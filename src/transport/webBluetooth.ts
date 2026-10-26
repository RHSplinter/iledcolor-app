import { SelectionCancelledError, type Transport } from './types';

export const SERVICE_A950 = '0000a950-0000-1000-8000-00805f9b34fb';
export const CHAR_CMD = '0000a951-0000-1000-8000-00805f9b34fb';
export const CHAR_DATA = '0000a952-0000-1000-8000-00805f9b34fb';
export const CHAR_NOTIFY = '0000a953-0000-1000-8000-00805f9b34fb';
/** Reference panel advertises as iledcolor-*; adjust after the compatibility spike. */
export const NAME_PREFIX = 'iledcolor-';

export function bluetoothSupport(): { ok: true } | { ok: false; reason: string } {
  if (!window.isSecureContext) return { ok: false, reason: 'Web Bluetooth needs HTTPS (a secure context).' };
  if (!navigator.bluetooth)
    return { ok: false, reason: 'Web Bluetooth is not available in this browser. Use Chrome on Android.' };
  return { ok: true };
}

/** Must be called from a user gesture (tap). Resolves once A953 notifications are started. */
export async function connectWebBluetooth(
  namePrefix = NAME_PREFIX,
): Promise<{ transport: Transport; deviceName: string; deviceId: string }> {
  let device: BluetoothDevice;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix }],
      optionalServices: [SERVICE_A950],
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') throw new SelectionCancelledError();
    throw e;
  }
  return openDevice(device);
}

/**
 * Reconnect without a picker or user gesture to a hat the user already granted
 * (e.g. after a page reload). Throws SelectionCancelledError when it is not available.
 *
 * After a reload Chrome has forgotten where the hat is and fails `gatt.connect()` with
 * "no longer in range" until it has rediscovered it. Watching advertisements keeps a
 * discovery session running (on Windows `advertisementreceived` never fires, but the
 * scan still finds the hat), so connect is retried while watching until it succeeds.
 */
export async function reconnectWebBluetooth(
  deviceId: string,
  timeoutMs = 10000,
  retryMs = 1000,
): Promise<{ transport: Transport; deviceName: string; deviceId: string }> {
  if (!navigator.bluetooth?.getDevices) throw new SelectionCancelledError();
  const deadline = Date.now() + timeoutMs;
  const devices = await withTimeout(navigator.bluetooth.getDevices(), timeoutMs, 'Finding the hat');
  const device = devices.find((d) => d.id === deviceId);
  if (!device) throw new Error(devices.length === 0
    ? 'The browser returned no saved Bluetooth permissions. Automatic reconnect requires persistent Bluetooth permissions; use Connect to grant access again.'
    : 'The browser did not return permission for the remembered hat. Connect once to grant access in this browser configuration.');
  const watch = new AbortController();
  let seen: () => void = () => undefined;
  const onAdvert = () => seen();
  device.addEventListener('advertisementreceived', onAdvert);
  try {
    // Do not await discovery: some Windows stacks never settle it or emit advertisements.
    if (typeof device.watchAdvertisements === 'function') {
      try { void device.watchAdvertisements({ signal: watch.signal }).catch(() => undefined); } catch { /* discovery unavailable */ }
    }
    for (;;) {
      try {
        return await openDevice(device, deadline);
      } catch (e) {
        if (e instanceof BluetoothTimeoutError || Date.now() + retryMs >= deadline) throw e;
      }
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, retryMs); seen = () => { clearTimeout(t); resolve(); }; });
    }
  } finally {
    device.removeEventListener('advertisementreceived', onAdvert);
    watch.abort();
  }
}

class BluetoothTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BluetoothTimeoutError(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function openDevice(
  device: BluetoothDevice,
  deadline?: number,
): Promise<{ transport: Transport; deviceName: string; deviceId: string }> {
  if (!device.gatt) throw new Error('Device has no GATT server');
  const bounded = <T>(p: Promise<T>) => deadline === undefined ? p
    : withTimeout(p, Math.max(0, deadline - Date.now()), 'Connecting to the hat');
  let expired = false;
  const connecting = device.gatt.connect().then((server) => {
    if (expired) { server.disconnect(); throw new BluetoothTimeoutError('Connecting to the hat timed out'); }
    return server;
  });
  let server: BluetoothRemoteGATTServer;
  try { server = await bounded(connecting); }
  catch (e) { expired = true; device.gatt.disconnect(); throw e; }
  try {
    const service = await bounded(server.getPrimaryService(SERVICE_A950));
    const [cmd, data, notify] = await bounded(Promise.all([
      service.getCharacteristic(CHAR_CMD),
      service.getCharacteristic(CHAR_DATA),
      service.getCharacteristic(CHAR_NOTIFY),
    ]));
    if (!cmd.properties.writeWithoutResponse) throw new Error('A951 lacks write-without-response');
    if (!data.properties.writeWithoutResponse) throw new Error('A952 lacks write-without-response');
    if (!notify.properties.notify) throw new Error('A953 lacks notify');

    const noteListeners = new Set<(d: Uint8Array) => void>();
    const dropListeners = new Set<() => void>();
    let closing = false;
    notify.addEventListener('characteristicvaluechanged', () => {
      const v = notify.value;
      if (!v) return;
      const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      noteListeners.forEach((cb) => cb(bytes));
    });
    device.addEventListener('gattserverdisconnected', () => {
      if (!closing) dropListeners.forEach((cb) => cb());
    });
    // Notifications must be live before any command is written.
    await bounded(notify.startNotifications());

    const transport: Transport = {
      writeCommand: (d) => cmd.writeValueWithoutResponse(d as BufferSource),
      writeData: (d) => data.writeValueWithoutResponse(d as BufferSource),
      onNotification(cb) { noteListeners.add(cb); return () => noteListeners.delete(cb); },
      onDisconnect(cb) { dropListeners.add(cb); return () => dropListeners.delete(cb); },
      disconnect() { closing = true; if (device.gatt?.connected) device.gatt.disconnect(); },
    };
    return { transport, deviceName: device.name ?? 'unknown', deviceId: device.id };
  } catch (e) {
    server.disconnect();
    throw e;
  }
}
