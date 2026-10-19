package com.harrybin.ledhat;

/** Framework-free rules used by {@link SoundDetectionPlugin}, kept separate so they run in JVM unit tests. */
final class SoundRules {
    static final int SAMPLE_RATE = 16000;
    static final int FRAME_SIZE = 2048;
    static final long FRAME_DURATION_MS = FRAME_SIZE * 1000L / SAMPLE_RATE;
    private static final float NEAR_DISTANCE_CM = 5.0f;

    private SoundRules() {}

    static boolean isSupportedLanguage(String language) {
        return "en-US".equals(language) || "de-DE".equals(language);
    }

    /** Matches a requested BCP-47 tag against installed recognizer languages, by full tag or language. */
    static boolean isLanguageInstalled(String requested, Iterable<String> installed) {
        if (requested == null || requested.length() < 2 || installed == null) return false;
        String base = requested.substring(0, 2);
        for (String language : installed) {
            if (requested.equalsIgnoreCase(language) || base.equalsIgnoreCase(language)) return true;
        }
        return false;
    }

    /** Little-endian 16-bit PCM, as the recognizer expects for EXTRA_AUDIO_SOURCE_ENCODING. */
    static byte[] toPcm16le(short[] samples) {
        byte[] bytes = new byte[samples.length * 2];
        for (int i = 0; i < samples.length; i++) {
            bytes[i * 2] = (byte) samples[i];
            bytes[i * 2 + 1] = (byte) (samples[i] >> 8);
        }
        return bytes;
    }

    static double normalize(short sample) {
        return sample / 32768.0;
    }

    static boolean isNear(float distance, float maximumRange) {
        return distance < Math.min(maximumRange, NEAR_DISTANCE_CM);
    }
}
