package com.harrybin.ledhat;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.ParcelUuid;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Advertises this phone as an approach-mode participant. The whole payload lives in one
 * 128-bit service UUID because that is the only custom data iOS can advertise as well.
 */
@CapacitorPlugin(
    name = "ApproachBeacon",
    permissions = { @Permission(alias = "advertise", strings = { Manifest.permission.BLUETOOTH_ADVERTISE }) }
)
public class ApproachBeaconPlugin extends Plugin implements SensorEventListener {
    /** Mirrors beaconCodec.ts: user name as manufacturer data (test company id) in the scan response. */
    private static final int NAME_COMPANY_ID = 0xFFFF;
    private static final byte[] NAME_PREFIX = { 'L', 'H' };
    private static final int NAME_MAX_BYTES = 20;
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback callback;
    private SensorManager sensors;
    private boolean motionRequested;
    private double rotation;
    private long rotationTime;
    private long lastMotionEvent;

    @PluginMethod
    public void startMotion(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            stopMotionInternal();
            sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            motionRequested = true;
            if (!registerMotion()) {
                motionRequested = false;
                call.reject("Linear acceleration sensor unavailable", "UNAVAILABLE");
                return;
            }
            call.resolve();
        });
    }

    private boolean registerMotion() {
        if (sensors == null) return false;
        Sensor acceleration = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        if (acceleration == null || !sensors.registerListener(this, acceleration, SensorManager.SENSOR_DELAY_GAME)) return false;
        Sensor gyro = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (gyro != null) sensors.registerListener(this, gyro, SensorManager.SENSOR_DELAY_GAME);
        return true;
    }

    @PluginMethod
    public void stopMotion(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            motionRequested = false;
            stopMotionInternal();
            call.resolve();
        });
    }

    private void stopMotionInternal() {
        if (sensors != null) sensors.unregisterListener(this);
        rotation = 0;
        rotationTime = lastMotionEvent = 0;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        double magnitude = Math.sqrt((double) event.values[0] * event.values[0]
            + (double) event.values[1] * event.values[1] + (double) event.values[2] * event.values[2]);
        if (event.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
            rotation = magnitude;
            rotationTime = event.timestamp;
        } else if (event.sensor.getType() == Sensor.TYPE_LINEAR_ACCELERATION && event.timestamp - lastMotionEvent >= 100_000_000L) {
            lastMotionEvent = event.timestamp;
            JSObject sample = new JSObject();
            sample.put("acceleration", magnitude);
            sample.put("rotation", event.timestamp - rotationTime <= 250_000_000L ? rotation : 0);
            notifyListeners("motion", sample);
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    protected void handleOnPause() { stopMotionInternal(); }

    @Override
    protected void handleOnResume() {
        if (motionRequested && !registerMotion()) {
            motionRequested = false;
            JSObject error = new JSObject();
            error.put("message", "Motion sensors could not resume");
            notifyListeners("motionError", error);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("advertise") != PermissionState.GRANTED) {
            requestPermissionForAlias("advertise", call, "advertisePermsCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void advertisePermsCallback(PluginCall call) {
        if (getPermissionState("advertise") == PermissionState.GRANTED) doStart(call);
        else call.reject("Bluetooth advertise permission denied");
    }

    @SuppressWarnings("MissingPermission")
    private void doStart(PluginCall call) {
        String uuid = call.getString("uuid");
        if (uuid == null) { call.reject("uuid required"); return; }
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = mgr == null ? null : mgr.getAdapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("Bluetooth is off"); return; }
        if (!adapter.isMultipleAdvertisementSupported()) { call.reject("This phone cannot advertise BLE"); return; }
        stopInternal();
        advertiser = adapter.getBluetoothLeAdvertiser();
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(false)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(new ParcelUuid(UUID.fromString(uuid)))
            .build();
        AdvertiseData scanResponse = null;
        String name = call.getString("name", "");
        if (name != null && !name.trim().isEmpty()) {
            byte[] utf8 = name.trim().getBytes(StandardCharsets.UTF_8);
            int len = Math.min(utf8.length, NAME_MAX_BYTES);
            byte[] payload = new byte[NAME_PREFIX.length + len];
            System.arraycopy(NAME_PREFIX, 0, payload, 0, NAME_PREFIX.length);
            System.arraycopy(utf8, 0, payload, NAME_PREFIX.length, len);
            scanResponse = new AdvertiseData.Builder().setIncludeDeviceName(false).addManufacturerData(NAME_COMPANY_ID, payload).build();
        }
        final PluginCall pending = call;
        callback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings s) { JSObject r = new JSObject(); r.put("advertising", true); pending.resolve(r); }
            @Override public void onStartFailure(int errorCode) { callback = null; pending.reject("Advertising failed (code " + errorCode + ")"); }
        };
        try {
            advertiser.startAdvertising(settings, data, scanResponse, callback);
        } catch (SecurityException e) {
            call.reject("Bluetooth advertise permission missing", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopInternal();
        call.resolve();
    }

    /** Android throttles unfiltered scans with the screen off, so approach mode keeps it on. */
    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @SuppressWarnings("MissingPermission")
    private void stopInternal() {
        if (advertiser != null && callback != null) {
            try { advertiser.stopAdvertising(callback); } catch (SecurityException ignored) { }
        }
        callback = null;
    }

    @Override
    protected void handleOnDestroy() {
        motionRequested = false;
        stopMotionInternal();
        stopInternal();
    }
}
