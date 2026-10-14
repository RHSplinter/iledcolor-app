import { BleClient, ScanMode, type ScanResult } from '@capacitor-community/bluetooth-le';
import { SelectionCancelledError, type Transport } from './types';
import { CHAR_CMD, CHAR_DATA, CHAR_NOTIFY, NAME_PREFIX, SERVICE_A950 } from './webBluetooth';

let initialized: Promise<void> | null = null;

/** Requests the Android/iOS Bluetooth permissions once. */
export function initNativeBle(): Promise<void> {
  initialized ??= BleClient.initialize().catch((e) => { initialized = null; throw e; });
  return initialized;
}

const toView = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const toBytes = (v: DataView) => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

/** Native chooser (Android dialog / iOS sheet) for one cap, same as the web flow. */
export async function chooseNativeCap(namePrefix = NAME_PREFIX): Promise<{ deviceId: string; name: string }> {
  await initNativeBle();
  try {
    const d = await BleClient.requestDevice({ namePrefix, optionalServices: [SERVICE_A950] });
    return { deviceId: d.deviceId, name: d.name ?? d.deviceId };
  } catch (e) {
    if (/cancel|no device/i.test(String((e as Error)?.message ?? e))) throw new SelectionCancelledError();
    throw e;
  }
}

/**
 * Connects to a cap by id. Several caps can be connected at the same time; each gets its
 * own Transport, so each can be driven by its own DeviceController.
 */
export async function connectNativeCap(deviceId: string): Promise<Transport> {
  await initNativeBle();
  const noteListeners = new Set<(d: Uint8Array) => void>();
  const dropListeners = new Set<() => void>();
  let closing = false;
  await BleClient.connect(deviceId, () => { if (!closing) dropListeners.forEach((cb) => cb()); }, { timeout: 10000 });
  try {
    const services = await BleClient.getServices(deviceId);
    const svc = services.find((s) => s.uuid.toLowerCase() === SERVICE_A950);
    if (!svc) throw new Error('Cap does not expose service A950');
    const props = (uuid: string) => svc.characteristics.find((c) => c.uuid.toLowerCase() === uuid)?.properties;
    if (!props(CHAR_CMD)?.writeWithoutResponse) throw new Error('A951 lacks write-without-response');
    if (!props(CHAR_DATA)?.writeWithoutResponse) throw new Error('A952 lacks write-without-response');
    if (!props(CHAR_NOTIFY)?.notify) throw new Error('A953 lacks notify');
    // Notifications must be live before any command is written.
    await BleClient.startNotifications(deviceId, SERVICE_A950, CHAR_NOTIFY, (v) => {
      const bytes = toBytes(v);
      noteListeners.forEach((cb) => cb(bytes));
    });
  } catch (e) {
    closing = true;
    await BleClient.disconnect(deviceId).catch(() => undefined);
    throw e;
  }
  return {
    writeCommand: (d) => BleClient.writeWithoutResponse(deviceId, SERVICE_A950, CHAR_CMD, toView(d)),
    writeData: (d) => BleClient.writeWithoutResponse(deviceId, SERVICE_A950, CHAR_DATA, toView(d)),
    onNotification(cb) { noteListeners.add(cb); return () => noteListeners.delete(cb); },
    onDisconnect(cb) { dropListeners.add(cb); return () => dropListeners.delete(cb); },
    disconnect() { closing = true; void BleClient.disconnect(deviceId).catch(() => undefined); },
  };
}

export const readCapRssi = (deviceId: string) => BleClient.readRssi(deviceId);

/** Continuous scan reporting every advertisement (caps and approach beacons). */
export async function startNativeScan(cb: (r: ScanResult) => void): Promise<void> {
  await initNativeBle();
  await BleClient.requestLEScan({ allowDuplicates: true, scanMode: ScanMode.SCAN_MODE_LOW_LATENCY }, cb);
}
export const stopNativeScan = () => BleClient.stopLEScan().catch(() => undefined);
