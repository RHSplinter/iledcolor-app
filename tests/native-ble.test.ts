import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAR_CMD, CHAR_DATA, CHAR_NOTIFY, NAME_PREFIX, SERVICE_A950 } from '../src/transport/webBluetooth';

const ble = vi.hoisted(() => ({
  initialize: vi.fn(), requestDevice: vi.fn(), connect: vi.fn(), getServices: vi.fn(),
  startNotifications: vi.fn(), disconnect: vi.fn(), writeWithoutResponse: vi.fn(),
  requestLEScan: vi.fn(), stopLEScan: vi.fn(), readRssi: vi.fn(),
}));
vi.mock('@capacitor-community/bluetooth-le', () => ({
  BleClient: ble, ScanMode: { SCAN_MODE_LOW_LATENCY: 2 },
}));

function services() {
  return [{
    uuid: SERVICE_A950.toUpperCase(),
    characteristics: [
      { uuid: CHAR_CMD.toUpperCase(), properties: { writeWithoutResponse: true } as { writeWithoutResponse?: boolean; notify?: boolean } },
      { uuid: CHAR_DATA.toUpperCase(), properties: { writeWithoutResponse: true } },
      { uuid: CHAR_NOTIFY.toUpperCase(), properties: { notify: true } },
    ],
  }];
}

let native: typeof import('../src/transport/nativeBle');
let notes: Map<string, (value: DataView) => void>;
let drops: Map<string, () => void>;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  notes = new Map();
  drops = new Map();
  ble.initialize.mockResolvedValue(undefined);
  ble.requestDevice.mockResolvedValue({ deviceId: 'cap-1', name: 'iledcolor-test' });
  ble.connect.mockImplementation(async (id: string, cb: () => void) => { drops.set(id, cb); });
  ble.getServices.mockResolvedValue(services());
  ble.startNotifications.mockImplementation(async (id: string, _svc: string, _char: string, cb: (v: DataView) => void) => {
    notes.set(id, cb);
  });
  ble.disconnect.mockImplementation(async (id: string) => { drops.get(id)?.(); });
  ble.writeWithoutResponse.mockResolvedValue(undefined);
  ble.requestLEScan.mockResolvedValue(undefined);
  ble.stopLEScan.mockResolvedValue(undefined);
  native = await import('../src/transport/nativeBle');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shared Android/iOS BLE adapter boundary', () => {
  it('shares concurrent initialization and caches only successful initialization', async () => {
    let finish!: () => void;
    ble.initialize.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const first = native.initNativeBle(), second = native.initNativeBle();
    expect(first).toBe(second);
    expect(ble.initialize).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    await native.initNativeBle();
    expect(ble.initialize).toHaveBeenCalledOnce();
  });

  it('retries initialization after a shared rejection rather than poisoning subsequent calls', async () => {
    const error = new Error('Permissions unavailable');
    ble.initialize.mockRejectedValueOnce(error);
    const first = native.initNativeBle(), second = native.initNativeBle();
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    await native.initNativeBle();
    expect(ble.initialize).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'custom-'])('initializes before choosing and passes the prefix (%s) and optional service', async (prefix) => {
    expect(await native.chooseNativeCap(prefix)).toEqual({ deviceId: 'cap-1', name: 'iledcolor-test' });
    expect(ble.requestDevice).toHaveBeenCalledExactlyOnceWith({
      namePrefix: prefix ?? NAME_PREFIX, optionalServices: [SERVICE_A950],
    });
    expect(ble.initialize.mock.invocationCallOrder[0]).toBeLessThan(ble.requestDevice.mock.invocationCallOrder[0]!);
  });

  it('falls back to device ID for an unnamed native device', async () => {
    ble.requestDevice.mockResolvedValue({ deviceId: 'unnamed' });
    expect(await native.chooseNativeCap()).toEqual({ deviceId: 'unnamed', name: 'unnamed' });
  });

  it.each(['User CANCELLED', 'No device selected'])('distinguishes selection cancellation (%s) from plugin errors', async (message) => {
    ble.requestDevice.mockRejectedValueOnce(new Error(message));
    await expect(native.chooseNativeCap()).rejects.toMatchObject({ name: 'SelectionCancelledError' });
    const error = new Error('Bluetooth powered off');
    ble.requestDevice.mockRejectedValueOnce(error);
    await expect(native.chooseNativeCap()).rejects.toBe(error);
  });

  it('propagates initialization failure without opening the chooser, connection or scanner', async () => {
    const error = new Error('Permission denied');
    ble.initialize.mockRejectedValue(error);
    await expect(native.chooseNativeCap()).rejects.toBe(error);
    await expect(native.connectNativeCap('cap')).rejects.toBe(error);
    await expect(native.startNativeScan(vi.fn())).rejects.toBe(error);
    expect(ble.requestDevice).not.toHaveBeenCalled();
    expect(ble.connect).not.toHaveBeenCalled();
    expect(ble.requestLEScan).not.toHaveBeenCalled();
  });

  it('normalizes service and characteristic UUID case before starting A953 notifications', async () => {
    await native.connectNativeCap('cap-1');
    expect(ble.connect).toHaveBeenCalledExactlyOnceWith('cap-1', expect.any(Function), { timeout: 10000 });
    expect(ble.getServices).toHaveBeenCalledExactlyOnceWith('cap-1');
    expect(ble.startNotifications).toHaveBeenCalledExactlyOnceWith('cap-1', SERVICE_A950, CHAR_NOTIFY, expect.any(Function));
    expect(ble.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    ['service', 'Cap does not expose service A950'],
    ['cmd-missing', 'A951 lacks write-without-response'],
    ['cmd-property', 'A951 lacks write-without-response'],
    ['data-missing', 'A952 lacks write-without-response'],
    ['data-property', 'A952 lacks write-without-response'],
    ['notify-missing', 'A953 lacks notify'],
    ['notify-property', 'A953 lacks notify'],
  ])('disconnects invalid %s without starting notifications', async (which, message) => {
    const list = services();
    const svc = list[0]!;
    if (which === 'service') list.length = 0;
    else {
      const index = which.startsWith('cmd') ? 0 : which.startsWith('data') ? 1 : 2;
      if (which.endsWith('missing')) svc.characteristics.splice(index, 1);
      else svc.characteristics[index]!.properties = {};
    }
    ble.getServices.mockResolvedValue(list);
    await expect(native.connectNativeCap('bad')).rejects.toThrow(message);
    expect(ble.disconnect).toHaveBeenCalledExactlyOnceWith('bad');
    expect(ble.startNotifications).not.toHaveBeenCalled();
  });

  it.each(['getServices', 'startNotifications'] as const)('preserves %s failure even if disconnect cleanup also fails', async (stage) => {
    const error = new Error(`${stage} failed`);
    ble[stage].mockRejectedValue(error);
    ble.disconnect.mockRejectedValue(new Error('Cleanup failed'));
    await expect(native.connectNativeCap('bad')).rejects.toBe(error);
    expect(ble.disconnect).toHaveBeenCalledExactlyOnceWith('bad');
  });

  it('does not perform service discovery after a connection failure', async () => {
    const error = new Error('Timeout');
    ble.connect.mockRejectedValue(error);
    await expect(native.connectNativeCap('missing')).rejects.toBe(error);
    expect(ble.getServices).not.toHaveBeenCalled();
  });

  it('waits for notifications before returning a writable transport', async () => {
    let ready!: () => void;
    ble.startNotifications.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    const connected = vi.fn();
    const pending = native.connectNativeCap('cap').then((transport) => { connected(); return transport; });
    await vi.waitFor(() => expect(ble.startNotifications).toHaveBeenCalledOnce());
    expect(connected).not.toHaveBeenCalled();
    expect(ble.writeWithoutResponse).not.toHaveBeenCalled();
    ready();
    await pending;
    expect(connected).toHaveBeenCalledOnce();
  });

  it('routes A951/A952 writes by device and preserves byte offsets and lengths', async () => {
    const a = await native.connectNativeCap('a'), b = await native.connectNativeCap('b');
    const bytes = new Uint8Array([99, 1, 2, 88]).subarray(1, 3);
    await a.writeCommand(bytes);
    await b.writeData(bytes);
    expect(ble.writeWithoutResponse).toHaveBeenNthCalledWith(1, 'a', SERVICE_A950, CHAR_CMD, expect.any(DataView));
    expect(ble.writeWithoutResponse).toHaveBeenNthCalledWith(2, 'b', SERVICE_A950, CHAR_DATA, expect.any(DataView));
    for (const call of ble.writeWithoutResponse.mock.calls) {
      const view: DataView = call[3];
      expect(view.buffer).toBe(bytes.buffer);
      expect(view.byteOffset).toBe(1);
      expect(view.byteLength).toBe(2);
      expect([view.getUint8(0), view.getUint8(1)]).toEqual([1, 2]);
    }
    const error = new Error('Write rejected');
    ble.writeWithoutResponse.mockRejectedValue(error);
    await expect(a.writeCommand(bytes)).rejects.toBe(error);
    await expect(b.writeData(bytes)).rejects.toBe(error);
  });

  it('copies notification subranges and isolates listeners and unsubscription per device', async () => {
    const a = await native.connectNativeCap('a'), b = await native.connectNativeCap('b');
    const receivedA = vi.fn(), receivedB = vi.fn(), secondA = vi.fn();
    const unsubscribe = a.onNotification(receivedA);
    a.onNotification(secondA);
    b.onNotification(receivedB);
    const source = new Uint8Array([99, 3, 4, 88]);
    notes.get('a')!(new DataView(source.buffer, 1, 2));
    source.fill(0);
    expect(receivedA).toHaveBeenCalledExactlyOnceWith(new Uint8Array([3, 4]));
    expect(secondA).toHaveBeenCalledExactlyOnceWith(new Uint8Array([3, 4]));
    expect(receivedB).not.toHaveBeenCalled();
    unsubscribe();
    notes.get('a')!(new DataView(source.buffer, 1, 2));
    notes.get('b')!(new DataView(new Uint8Array([7]).buffer));
    expect(receivedA).toHaveBeenCalledOnce();
    expect(secondA).toHaveBeenCalledTimes(2);
    expect(receivedB).toHaveBeenCalledExactlyOnceWith(new Uint8Array([7]));
  });

  it('isolates unexpected drops, removes subscriptions and suppresses intentional disconnect callbacks', async () => {
    const a = await native.connectNativeCap('a'), b = await native.connectNativeCap('b');
    const droppedA = vi.fn(), droppedB = vi.fn(), removed = vi.fn();
    a.onDisconnect(droppedA);
    b.onDisconnect(droppedB);
    a.onDisconnect(removed)();
    drops.get('a')!();
    expect(droppedA).toHaveBeenCalledOnce();
    expect(droppedB).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    b.disconnect();
    expect(ble.disconnect).toHaveBeenCalledExactlyOnceWith('b');
    expect(droppedB).not.toHaveBeenCalled();
    ble.disconnect.mockRejectedValue(new Error('Already disconnected'));
    a.disconnect();
    await Promise.resolve();
    drops.get('a')!();
    expect(droppedA).toHaveBeenCalledOnce();
  });

  it('scans with duplicate low-latency advertisements, forwards callbacks and propagates scan errors', async () => {
    const received = vi.fn();
    await native.startNativeScan(received);
    expect(ble.requestLEScan).toHaveBeenCalledExactlyOnceWith({ allowDuplicates: true, scanMode: 2 }, received);
    const result = { device: { deviceId: 'beacon' }, rssi: -65 };
    ble.requestLEScan.mock.calls[0]![1](result);
    expect(received).toHaveBeenCalledExactlyOnceWith(result);
    const error = new Error('Scan denied');
    ble.requestLEScan.mockRejectedValue(error);
    await expect(native.startNativeScan(received)).rejects.toBe(error);
  });

  it('stops scanning and tolerates stop failures without reinitializing', async () => {
    await native.stopNativeScan();
    ble.stopLEScan.mockRejectedValue(new Error('Not scanning'));
    await expect(native.stopNativeScan()).resolves.toBeUndefined();
    expect(ble.stopLEScan).toHaveBeenCalledTimes(2);
    expect(ble.initialize).not.toHaveBeenCalled();
  });
});
