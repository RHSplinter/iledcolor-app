package com.harrybin.ledhat;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "SoundDetection",
    permissions = @Permission(alias = "microphone", strings = Manifest.permission.RECORD_AUDIO)
)
public class SoundDetectionPlugin extends Plugin {
    private static final int SAMPLE_RATE = SoundRules.SAMPLE_RATE;
    private static final int FRAME_SIZE = SoundRules.FRAME_SIZE;
    private final Handler main = new Handler(Looper.getMainLooper());
    // All bridge/lifecycle/recognizer state is serialized on the main looper.
    private Session session;
    private PluginCall pendingStart;
    private PluginCall permissionCall;
    private int generation;
    private boolean paused;
    private boolean destroyed;

    private static final class Session {
        final int generation;
        final String language;
        final boolean speech;
        final AudioRecord recorder;
        volatile boolean active = true;
        volatile SpeechStream stream;
        boolean audioReady;
        boolean speechReady;
        long lastEmissionAt;
        SensorManager sensors;
        SensorEventListener proximityListener;

        Session(int generation, String language, boolean speech, AudioRecord recorder) {
            this.generation = generation;
            this.language = language;
            this.speech = speech;
            this.recorder = recorder;
        }
    }

    private static final class AudioFrame {
        final byte[] bytes;
        final long at;

        AudioFrame(byte[] bytes, long at) {
            this.bytes = bytes;
            this.at = at;
        }
    }

    private static final class SpeechStream {
        final ArrayBlockingQueue<AudioFrame> frames = new ArrayBlockingQueue<>(32);
        final ParcelFileDescriptor read;
        final ParcelFileDescriptor.AutoCloseInputStream probe;
        final OutputStream write;
        volatile boolean active = true;
        volatile long firstAudioAt;
        volatile long lastAudioAt;
        volatile long bytesWritten;
        boolean inputConsumed;
        boolean speechBegan;
        SpeechRecognizer recognizer;
        long from;
        long to;
        volatile boolean ended;
        volatile boolean acceptingAudio;

        SpeechStream() throws IOException {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            read = pipe[0];
            probe = new ParcelFileDescriptor.AutoCloseInputStream(read);
            write = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]);
        }
    }

    private boolean speechAvailable() {
        return Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());
    }

    private SensorManager sensorManager() {
        return (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        main.post(() -> {
            try {
                SensorManager sensors = sensorManager();
                JSObject result = new JSObject();
                result.put("speech", speechAvailable());
                result.put("proximity", sensors != null && sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY) != null);
                call.resolve(result);
            } catch (RuntimeException e) {
                call.reject("Could not inspect sound detection capabilities", e);
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        main.post(() -> {
            if (destroyed || paused) {
                call.reject("Sound detection requires a foreground activity");
                return;
            }
            if (session != null || pendingStart != null || permissionCall != null) {
                call.reject("Sound detection is already active or starting");
                return;
            }
            String language = call.getString("language", "en-US");
            if (!SoundRules.isSupportedLanguage(language)) {
                call.reject("Sound detection supports en-US and de-DE");
                return;
            }
            try {
                if (Boolean.TRUE.equals(call.getBoolean("speech", false)) && !speechAvailable()) {
                    call.reject("On-device speech with shared microphone audio requires Android 13 or newer and an installed on-device recognizer");
                    return;
                }
                pendingStart = call;
                ++generation;
                if (getPermissionState("microphone") != PermissionState.GRANTED) {
                    permissionCall = call;
                    requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
                } else {
                    begin(call);
                }
            } catch (RuntimeException e) {
                permissionCall = null;
                stopInternal("Could not start sound detection: " + e.getMessage(), true);
            }
        });
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        main.post(() -> {
            if (permissionCall != call) return;
            permissionCall = null;
            // stop/pause may have rejected this call while the permission dialog was open.
            if (pendingStart != call || paused || destroyed) return;
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                stopInternal("Microphone permission denied", true);
                return;
            }
            begin(call);
        });
    }

    @SuppressWarnings("MissingPermission")
    private void begin(PluginCall call) {
        AudioRecord recorder = null;
        try {
            int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IllegalStateException("16 kHz microphone capture is unavailable");
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, FRAME_SIZE * 4));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("Microphone initialization failed");
            Session next = new Session(generation, call.getString("language", "en-US"),
                Boolean.TRUE.equals(call.getBoolean("speech", false)), recorder);
            session = next;
            recorder.startRecording();
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("Microphone did not start");
            startProximity(next);
            if (next.speech) startSpeech(next);
            if (!current(next)) return;
            new Thread(() -> capture(next), "SoundDetection-capture").start();
            main.postDelayed(() -> {
                if (current(next) && pendingStart == call) fail(next, "Sound detection startup timed out");
            }, 12000);
        } catch (RuntimeException e) {
            if (session == null && recorder != null) recorder.release();
            stopInternal("Could not start microphone: " + e.getMessage(), true);
        }
    }

    private boolean current(Session candidate) {
        return session == candidate && candidate.active && candidate.generation == generation;
    }

    private void resolveReady(Session candidate) {
        if (!current(candidate) || !candidate.audioReady || (candidate.speech && !candidate.speechReady)) return;
        if (candidate.speech && !speechInputConsumed(candidate, candidate.stream)) return;
        if (pendingStart != null) {
            PluginCall call = pendingStart;
            pendingStart = null;
            call.resolve();
        }
    }

    private boolean speechInputConsumed(Session candidate, SpeechStream stream) {
        if (stream == null || !stream.active) return false;
        if (stream.inputConsumed) return true;
        try {
            // checkRecognitionSupport validates the intent/model, but some services ignore the
            // supplied source. Only a remote reader can remove bytes from this otherwise unread pipe.
            stream.inputConsumed = stream.bytesWritten - stream.probe.available() >= FRAME_SIZE * 2L;
            return stream.inputConsumed;
        } catch (IOException e) {
            fail(candidate, "Could not verify shared speech audio consumption: " + e.getMessage());
            return false;
        }
    }

    private void capture(Session candidate) {
        short[] samples = new short[FRAME_SIZE];
        long epoch = System.currentTimeMillis();
        long clock = SystemClock.elapsedRealtime();
        long lastEmission = 0;
        try {
            while (candidate.active) {
                int offset = 0;
                while (offset < samples.length && candidate.active) {
                    int count = candidate.recorder.read(samples, offset, samples.length - offset, AudioRecord.READ_BLOCKING);
                    if (count <= 0) throw new IOException("Microphone read failed (" + count + ")");
                    offset += count;
                }
                if (!candidate.active) break;
                long now = SystemClock.elapsedRealtime();
                long at = epoch + now - clock;
                SpeechStream stream = candidate.stream;
                if (stream != null && stream.active && stream.acceptingAudio && !stream.ended) {
                    byte[] bytes = SoundRules.toPcm16le(samples);
                    if (!stream.frames.offer(new AudioFrame(bytes, at)) && stream.active && !stream.ended) {
                        throw new IOException("On-device recognizer stopped consuming shared microphone audio");
                    }
                }
                if (now - lastEmission < 64) continue;
                lastEmission = now;
                JSArray normalized = new JSArray();
                for (short sample : samples) normalized.put(SoundRules.normalize(sample));
                JSObject event = new JSObject();
                event.put("samples", normalized);
                event.put("sampleRate", SAMPLE_RATE);
                event.put("at", at);
                main.post(() -> {
                    if (!current(candidate)) return;
                    candidate.audioReady = true;
                    resolveReady(candidate);
                    long deliveredAt = SystemClock.elapsedRealtime();
                    if (deliveredAt - candidate.lastEmissionAt < 64) return;
                    candidate.lastEmissionAt = deliveredAt;
                    notifyListeners("audio", event);
                });
            }
        } catch (Exception e) {
            main.post(() -> {
                if (current(candidate)) fail(candidate, "Audio capture failed: " + e.getMessage());
            });
        }
    }

    private void startProximity(Session candidate) {
        candidate.sensors = sensorManager();
        Sensor sensor = candidate.sensors == null ? null : candidate.sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY);
        if (sensor == null) return;
        candidate.proximityListener = new SensorEventListener() {
            @Override public void onSensorChanged(SensorEvent event) {
                if (!current(candidate) || event.values.length == 0) return;
                JSObject value = new JSObject();
                value.put("near", SoundRules.isNear(event.values[0], sensor.getMaximumRange()));
                notifyListeners("proximity", value);
            }
            @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        if (!candidate.sensors.registerListener(candidate.proximityListener, sensor, SensorManager.SENSOR_DELAY_NORMAL, main)) {
            throw new IllegalStateException("Could not register proximity sensor");
        }
    }

    private void startSpeech(Session candidate) {
        if (!current(candidate)) return;
        try {
            SpeechStream stream = new SpeechStream();
            candidate.stream = stream;
            stream.recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
            stream.recognizer.setRecognitionListener(new RecognitionListener() {
                private boolean live() { return current(candidate) && candidate.stream == stream && stream.active; }
                @Override public void onReadyForSpeech(Bundle params) {
                    if (!live()) return;
                    candidate.speechReady = true;
                    resolveReady(candidate);
                }
                @Override public void onBeginningOfSpeech() {
                    if (live()) {
                        stream.speechBegan = true;
                        stream.from = Math.max(stream.firstAudioAt,
                            stream.lastAudioAt - FRAME_SIZE * 1000L / SAMPLE_RATE);
                    }
                }
                @Override public void onEndOfSpeech() {
                    if (!live()) return;
                    finishSpeechInput(candidate, stream);
                }
                @Override public void onResults(Bundle results) {
                    if (!live()) return;
                    ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (texts != null && !texts.isEmpty() && !texts.get(0).trim().isEmpty()) {
                        if (!speechInputConsumed(candidate, stream)) {
                            if (live()) fail(candidate, "On-device recognizer returned text without consuming shared microphone audio");
                            return;
                        }
                        JSObject phrase = new JSObject();
                        long from = stream.from > 0 ? stream.from : stream.firstAudioAt;
                        long to = stream.to > 0 ? stream.to : stream.lastAudioAt;
                        if (!stream.speechBegan || from <= 0 || to <= from) {
                            fail(candidate, "On-device recognizer returned text without a valid shared-audio utterance interval");
                            return;
                        }
                        phrase.put("text", texts.get(0));
                        phrase.put("from", from);
                        phrase.put("to", to);
                        notifyListeners("phrase", phrase);
                    }
                    restartSpeech(candidate, stream);
                }
                @Override public void onError(int code) {
                    if (!live()) return;
                    if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        restartSpeech(candidate, stream);
                    } else {
                        fail(candidate, "On-device speech recognition failed (code " + code + "); check that the selected language is installed");
                    }
                }
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onEvent(int eventType, Bundle params) {}
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, candidate.language);
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            // Only this AudioRecord owns the microphone. Never fall back to recognizer-owned capture.
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, stream.read);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SAMPLE_RATE);
            // Require intent/model support, then separately verify actual pipe consumption.
            stream.recognizer.checkRecognitionSupport(intent, command -> main.post(command), new RecognitionSupportCallback() {
                @Override public void onSupportResult(RecognitionSupport support) {
                    if (!current(candidate) || candidate.stream != stream || !stream.active) return;
                    if (!SoundRules.isLanguageInstalled(candidate.language, support.getInstalledOnDeviceLanguages())) {
                        fail(candidate, "The selected on-device speech language is not installed: " + candidate.language);
                        return;
                    }
                    try {
                        stream.acceptingAudio = true;
                        stream.recognizer.startListening(intent);
                        new Thread(() -> feedSpeech(candidate, stream), "SoundDetection-speech-pipe").start();
                        // Some external-audio services wait for EOF rather than reporting end-of-speech.
                        main.postDelayed(() -> finishSpeechInput(candidate, stream), 15000);
                    } catch (RuntimeException e) {
                        fail(candidate, "Could not start shared-audio recognition: " + e.getMessage());
                    }
                }
                @Override public void onError(int code) {
                    if (current(candidate) && candidate.stream == stream && stream.active) {
                        fail(candidate, "On-device recognizer cannot confirm shared-audio support (code " + code + ")");
                    }
                }
            });
            main.postDelayed(() -> {
                if (current(candidate) && candidate.stream == stream && !candidate.speechReady) {
                    fail(candidate, "On-device recognizer did not accept shared microphone audio");
                }
            }, 10000);
        } catch (IOException | RuntimeException e) {
            fail(candidate, "Could not start on-device speech: " + e.getMessage());
        }
    }

    private void finishSpeechInput(Session candidate, SpeechStream stream) {
        if (!current(candidate) || candidate.stream != stream || !stream.active || stream.ended) return;
        stream.to = stream.lastAudioAt;
        stream.ended = true;
        // Preserve the recognizer/read end until final results, while delivering EOF.
        closeQuietly(stream.write);
        main.postDelayed(() -> {
            if (current(candidate) && candidate.stream == stream && stream.active) {
                fail(candidate, "On-device recognizer did not deliver a final result");
            }
        }, 8000);
    }

    private void feedSpeech(Session candidate, SpeechStream stream) {
        try {
            while (candidate.active && stream.active && !stream.ended) {
                AudioFrame frame = stream.frames.poll(250, TimeUnit.MILLISECONDS);
                if (frame != null) {
                    if (stream.firstAudioAt == 0) stream.firstAudioAt = frame.at - FRAME_SIZE * 1000L / SAMPLE_RATE;
                    stream.write.write(frame.bytes);
                    stream.lastAudioAt = frame.at;
                    stream.bytesWritten += frame.bytes.length;
                }
            }
        } catch (IOException | InterruptedException e) {
            main.post(() -> {
                if (current(candidate) && candidate.stream == stream && stream.active && !stream.ended) {
                    fail(candidate, "Shared speech audio pipe failed: " + e.getMessage());
                }
            });
        }
    }

    private void restartSpeech(Session candidate, SpeechStream stream) {
        if (!current(candidate) || candidate.stream != stream) return;
        candidate.stream = null;
        closeSpeech(stream);
        candidate.speechReady = false;
        main.postDelayed(() -> startSpeech(candidate), 100);
    }

    private void closeSpeech(SpeechStream stream) {
        if (stream == null) return;
        stream.active = false;
        closeQuietly(stream.probe);
        closeQuietly(stream.write);
        stream.frames.clear();
        if (stream.recognizer != null) {
            try { stream.recognizer.cancel(); } catch (RuntimeException ignored) {}
            try { stream.recognizer.destroy(); } catch (RuntimeException ignored) {}
        }
    }

    private static void closeQuietly(java.io.Closeable resource) {
        try { resource.close(); } catch (IOException ignored) {}
    }

    private void fail(Session candidate, String message) {
        if (current(candidate)) stopInternal(message, true);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            stopInternal("Sound detection stopped before startup completed", false);
            call.resolve();
        });
    }

    private void stopInternal(String message, boolean error) {
        ++generation;
        Session previous = session;
        session = null;
        if (previous != null) {
            previous.active = false;
            SpeechStream stream = previous.stream;
            previous.stream = null;
            closeSpeech(stream);
            if (previous.sensors != null && previous.proximityListener != null) {
                previous.sensors.unregisterListener(previous.proximityListener);
            }
            try { previous.recorder.stop(); } catch (RuntimeException ignored) {}
            previous.recorder.release();
        }
        if (pendingStart != null) {
            PluginCall call = pendingStart;
            pendingStart = null;
            call.reject(message);
        }
        if (error) {
            JSObject event = new JSObject();
            event.put("message", message);
            notifyListeners("error", event);
        }
        if (previous != null) notifyListeners("ended", new JSObject());
    }

    @Override
    protected void handleOnPause() {
        main.post(() -> {
            paused = true;
            stopInternal("Sound detection paused before startup completed", false);
        });
    }

    @Override
    protected void handleOnResume() {
        main.post(() -> paused = false);
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            destroyed = true;
            stopInternal("Sound detection destroyed before startup completed", false);
        });
    }
}
