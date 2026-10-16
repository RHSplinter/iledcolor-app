package com.harrybin.ledhat;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
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
import android.util.Base64;

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
import java.util.Map;
import java.util.HashMap;
import java.util.Arrays;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Advertises this phone as an approach-mode participant. The whole payload lives in one
 * 128-bit service UUID because that is the only custom data iOS can advertise as well.
 */
@CapacitorPlugin(
    name = "ApproachBeacon",
    permissions = {
        @Permission(alias = "advertise", strings = { Manifest.permission.BLUETOOTH_ADVERTISE }),
        @Permission(alias = "connect", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class ApproachBeaconPlugin extends Plugin implements SensorEventListener {
    /** Mirrors beaconCodec.ts: user name as manufacturer data (test company id) in the scan response. */
    private static final int NAME_COMPANY_ID = 0xFFFF;
    private static final byte[] NAME_PREFIX = { 'L', 'H' };
    private static final int NAME_MAX_BYTES = 20;
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback callback;
    private static final UUID CONTENT_SERVICE = UUID.fromString("4c454448-1000-4000-8000-000000000001");
    /** Preset sharing (presetShare.ts): nearby phones write offers/data to the inbox and read the status. */
    private static final UUID SHARE_INBOX = UUID.fromString("4c454448-1000-4000-8000-000000000020");
    private static final UUID SHARE_STATUS = UUID.fromString("4c454448-1000-4000-8000-000000000021");
    private volatile byte[] shareStatus = new byte[0];
    private volatile BluetoothGattServer contentServer;
    private boolean contentServiceReady;
    private PluginCall contentCall;
    private volatile int contentEpoch;
    private volatile Map<UUID, byte[]> contentValues = new HashMap<>();
    private final Map<String, Integer> peerMtus = new ConcurrentHashMap<>();
    private SensorManager sensors;
    private boolean motionRequested;
    private double rotation;
    private long rotationTime;
    private long lastMotionEvent;

    @PluginMethod
    public void publishContent(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("connect") != PermissionState.GRANTED) {
            requestPermissionForAlias("connect", call, "contentPermsCallback");
            return;
        }
        doPublishContent(call);
    }

    @PermissionCallback
    private void contentPermsCallback(PluginCall call) {
        if (getPermissionState("connect") == PermissionState.GRANTED) doPublishContent(call);
        else call.reject("Bluetooth connect permission denied");
    }

    @SuppressWarnings("MissingPermission")
    private synchronized void doPublishContent(PluginCall call) {
        try {
            com.getcapacitor.JSArray values = call.getArray("values");
            if (values == null || values.length() != 6) { call.reject("Six content values required"); return; }
            Map<UUID, byte[]> next = new HashMap<>();
            for (int i = 0; i < 6; i++) {
                byte[] value = Base64.decode(values.getString(i), Base64.DEFAULT);
                if (value.length > 512 || (i == 0 && value.length != 8)) { call.reject("Invalid content value"); return; }
                int suffix = i == 0 ? 2 : 9 + i;
                next.put(UUID.fromString(String.format(java.util.Locale.ROOT, "4c454448-1000-4000-8000-%012d", suffix)), value);
            }
            contentValues = next;
            BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = mgr == null ? null : mgr.getAdapter();
            if (adapter == null || !adapter.isEnabled()) { closeContentServer(); call.reject("Bluetooth is off"); return; }
            if (contentServiceReady) { call.resolve(); return; }
            if (contentCall != null) { call.reject("Content service is starting"); return; }
            contentCall = call;
            final int epoch = ++contentEpoch;
            contentServer = mgr.openGattServer(getContext(), new BluetoothGattServerCallback() {
                @Override public void onServiceAdded(int status, BluetoothGattService service) {
                    synchronized (ApproachBeaconPlugin.this) {
                        if (epoch != contentEpoch || contentCall == null || !CONTENT_SERVICE.equals(service.getUuid())) return;
                        PluginCall pending = contentCall;
                        contentCall = null;
                        contentServiceReady = status == BluetoothGatt.GATT_SUCCESS;
                        if (contentServiceReady) pending.resolve();
                        else { closeContentServer(); pending.reject("Could not publish shared texts (GATT " + status + ")"); }
                    }
                }
                @Override public void onMtuChanged(BluetoothDevice device, int mtu) { peerMtus.put(device.getAddress(), mtu); }
                @Override public void onConnectionStateChange(BluetoothDevice device, int status, int state) {
                    if (state == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) peerMtus.remove(device.getAddress());
                }
                @Override public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattCharacteristic characteristic) {
                    BluetoothGattServer server = contentServer;
                    if (epoch != contentEpoch || server == null) return;
                    byte[] value = SHARE_STATUS.equals(characteristic.getUuid()) ? shareStatus : contentValues.get(characteristic.getUuid());
                    if (value == null) { server.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null); return; }
                    if (offset < 0 || offset > value.length) { server.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null); return; }
                    int end = Math.min(value.length, offset + peerMtus.getOrDefault(device.getAddress(), 23) - 1);
                    server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, Arrays.copyOfRange(value, offset, end));
                }
                @Override public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic characteristic,
                                                                   boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
                    BluetoothGattServer server = contentServer;
                    if (epoch != contentEpoch || server == null) return;
                    // Senders keep every packet within one ATT write, so prepared (long) writes are not needed.
                    boolean ok = SHARE_INBOX.equals(characteristic.getUuid()) && !preparedWrite && offset == 0 && value != null && value.length <= 512;
                    if (ok) {
                        JSObject write = new JSObject();
                        write.put("value", Base64.encodeToString(value, Base64.NO_WRAP));
                        notifyListeners("shareWrite", write);
                    }
                    if (responseNeeded) server.sendResponse(device, requestId,
                        ok ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null);
                }
                @Override public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
                    BluetoothGattServer server = contentServer;
                    if (epoch == contentEpoch && server != null)
                        server.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null);
                }
            });
            if (contentServer == null) { contentCall = null; call.reject("GATT server unavailable"); return; }
            BluetoothGattService service = new BluetoothGattService(CONTENT_SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
            for (UUID uuid : next.keySet())
                service.addCharacteristic(new BluetoothGattCharacteristic(uuid, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ));
            service.addCharacteristic(new BluetoothGattCharacteristic(SHARE_STATUS, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ));
            service.addCharacteristic(new BluetoothGattCharacteristic(SHARE_INBOX, BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE));
            if (!contentServer.addService(service)) {
                contentCall = null;
                closeContentServer();
                call.reject("Could not add shared text service");
                return;
            }
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                synchronized (ApproachBeaconPlugin.this) {
                    if (contentCall != call) return;
                    contentCall = null;
                    closeContentServer();
                    call.reject("Shared text service timed out; retrying");
                }
            }, 5000);
        } catch (org.json.JSONException | IllegalArgumentException | SecurityException e) {
            contentCall = null;
            closeContentServer();
            call.reject("Could not publish shared texts", e);
        }
    }

    @PluginMethod
    public void setShareStatus(PluginCall call) {
        String value = call.getString("value");
        if (value == null) { call.reject("value required"); return; }
        try {
            byte[] bytes = Base64.decode(value, Base64.DEFAULT);
            if (bytes.length > 512) { call.reject("Status too long"); return; }
            shareStatus = bytes;
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject("Invalid status", e);
        }
    }

    @SuppressWarnings("MissingPermission")
    private synchronized void closeContentServer() {
        contentEpoch++;
        if (contentCall != null) { contentCall.reject("Shared text service stopped"); contentCall = null; }
        if (contentServer != null) contentServer.close();
        contentServer = null;
        contentServiceReady = false;
        peerMtus.clear();
    }

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
            .setConnectable(true)
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
        closeContentServer();
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
        closeContentServer();
    }
}
