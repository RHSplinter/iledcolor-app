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
): Promise<{ transport: Transport; deviceName: string }> {
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
  if (!device.gatt) throw new Error('Device has no GATT server');
  const server = await device.gatt.connect();
  try {
    const service = await server.getPrimaryService(SERVICE_A950);
    const [cmd, data, notify] = await Promise.all([
      service.getCharacteristic(CHAR_CMD),
      service.getCharacteristic(CHAR_DATA),
      service.getCharacteristic(CHAR_NOTIFY),
    ]);
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
    await notify.startNotifications();

    const transport: Transport = {
      writeCommand: (d) => cmd.writeValueWithoutResponse(d as BufferSource),
      writeData: (d) => data.writeValueWithoutResponse(d as BufferSource),
      onNotification(cb) { noteListeners.add(cb); return () => noteListeners.delete(cb); },
      onDisconnect(cb) { dropListeners.add(cb); return () => dropListeners.delete(cb); },
      disconnect() { closing = true; if (device.gatt?.connected) device.gatt.disconnect(); },
    };
    return { transport, deviceName: device.name ?? 'unknown' };
  } catch (e) {
    server.disconnect();
    throw e;
  }
}
