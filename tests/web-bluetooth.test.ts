// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bluetoothSupport, CHAR_CMD, CHAR_DATA, CHAR_NOTIFY, connectWebBluetooth, NAME_PREFIX, SERVICE_A950,
} from '../src/transport/webBluetooth';
import { SelectionCancelledError } from '../src/transport/types';

function characteristic(properties: { writeWithoutResponse?: boolean; notify?: boolean }) {
  return Object.assign(new EventTarget(), {
    properties,
    value: undefined as DataView | undefined,
    startNotifications: vi.fn().mockResolvedValue(undefined),
    writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
  });
}

function fixture() {
  const cmd = characteristic({ writeWithoutResponse: true });
  const data = characteristic({ writeWithoutResponse: true });
  const notify = characteristic({ notify: true });
  const service = {
    getCharacteristic: vi.fn(async (uuid: string) => {
      if (uuid === CHAR_CMD) return cmd;
      if (uuid === CHAR_DATA) return data;
      if (uuid === CHAR_NOTIFY) return notify;
      throw new Error(`Unexpected characteristic ${uuid}`);
    }),
  };
  const device = Object.assign(new EventTarget(), {
    name: 'iledcolor-test' as string | undefined,
    gatt: {
      connected: true,
      connect: vi.fn(),
      getPrimaryService: vi.fn().mockResolvedValue(service),
      disconnect: vi.fn(),
    },
  });
  device.gatt.connect.mockResolvedValue(device.gatt);
  device.gatt.disconnect.mockImplementation(() => {
    device.gatt.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));
  });
  const requestDevice = vi.fn().mockResolvedValue(device);
  vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
  return { cmd, data, notify, service, device, requestDevice };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('direct Web Bluetooth boundary', () => {
  it('distinguishes insecure contexts, absent Bluetooth and supported browsers', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(bluetoothSupport()).toEqual({ ok: false, reason: expect.stringContaining('HTTPS') });
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', {});
    expect(bluetoothSupport()).toEqual({ ok: false, reason: expect.stringContaining('not available') });
    vi.stubGlobal('navigator', { bluetooth: {} });
    expect(bluetoothSupport()).toEqual({ ok: true });
  });

  it.each([undefined, 'custom-'])('requests only the selected prefix (%s) and optional A950 service', async (prefix) => {
    const result = await connectWebBluetooth(prefix);
    expect(f.requestDevice).toHaveBeenCalledExactlyOnceWith({
      filters: [{ namePrefix: prefix ?? NAME_PREFIX }], optionalServices: [SERVICE_A950],
    });
    expect(result.deviceName).toBe('iledcolor-test');
    expect(f.device.gatt.getPrimaryService).toHaveBeenCalledExactlyOnceWith(SERVICE_A950);
    expect(f.service.getCharacteristic.mock.calls.map(([uuid]) => uuid)).toEqual([CHAR_CMD, CHAR_DATA, CHAR_NOTIFY]);
  });

  it('uses unknown for an unnamed device', async () => {
    f.device.name = undefined;
    expect((await connectWebBluetooth()).deviceName).toBe('unknown');
  });

  it('maps chooser NotFoundError to cancellation without hiding other errors', async () => {
    f.requestDevice.mockRejectedValueOnce(new DOMException('No selection', 'NotFoundError'));
    await expect(connectWebBluetooth()).rejects.toBeInstanceOf(SelectionCancelledError);
    const denied = new DOMException('Permission denied', 'SecurityError');
    f.requestDevice.mockRejectedValueOnce(denied);
    await expect(connectWebBluetooth()).rejects.toBe(denied);
    const plain = new Error('NotFoundError');
    f.requestDevice.mockRejectedValueOnce(plain);
    await expect(connectWebBluetooth()).rejects.toBe(plain);
    expect(f.device.gatt.connect).not.toHaveBeenCalled();
  });

  it('rejects devices without GATT before attempting service discovery', async () => {
    f.requestDevice.mockResolvedValue({ name: 'no-gatt' });
    await expect(connectWebBluetooth()).rejects.toThrow('Device has no GATT server');
    expect(f.device.gatt.getPrimaryService).not.toHaveBeenCalled();
  });

  it('preserves connection failures without attempting discovery', async () => {
    const error = new Error('Connection failed');
    f.device.gatt.connect.mockRejectedValue(error);
    await expect(connectWebBluetooth()).rejects.toBe(error);
    expect(f.device.gatt.getPrimaryService).not.toHaveBeenCalled();
  });

  it.each(['service', 'characteristic', 'notifications'])('disconnects after %s setup failure', async (stage) => {
    const error = new Error(`${stage} unavailable`);
    if (stage === 'service') f.device.gatt.getPrimaryService.mockRejectedValue(error);
    if (stage === 'characteristic') f.service.getCharacteristic.mockRejectedValue(error);
    if (stage === 'notifications') f.notify.startNotifications.mockRejectedValue(error);
    await expect(connectWebBluetooth()).rejects.toBe(error);
    expect(f.device.gatt.disconnect).toHaveBeenCalledOnce();
    expect(f.cmd.writeValueWithoutResponse).not.toHaveBeenCalled();
  });

  it.each(['cmd', 'data', 'notify'] as const)('rejects missing %s properties and disconnects before notifications', async (which) => {
    f[which].properties = {};
    await expect(connectWebBluetooth()).rejects.toThrow(
      which === 'notify' ? 'A953 lacks notify' : `${which === 'cmd' ? 'A951' : 'A952'} lacks write-without-response`,
    );
    expect(f.device.gatt.disconnect).toHaveBeenCalledOnce();
    expect(f.notify.startNotifications).not.toHaveBeenCalled();
  });

  it('does not expose a writable transport before notifications have started', async () => {
    let ready!: () => void;
    f.notify.startNotifications.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    const connected = vi.fn();
    const pending = connectWebBluetooth().then((result) => { connected(); return result; });
    await vi.waitFor(() => expect(f.notify.startNotifications).toHaveBeenCalledOnce());
    expect(connected).not.toHaveBeenCalled();
    expect(f.cmd.writeValueWithoutResponse).not.toHaveBeenCalled();
    ready();
    const { transport } = await pending;
    const bytes = new Uint8Array([99, 1, 2, 88]).subarray(1, 3);
    await transport.writeCommand(bytes);
    await transport.writeData(bytes);
    expect(f.cmd.writeValueWithoutResponse).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(f.data.writeValueWithoutResponse).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(Array.from(f.data.writeValueWithoutResponse.mock.calls[0]![0])).toEqual([1, 2]);
    const error = new Error('Write failed');
    f.cmd.writeValueWithoutResponse.mockRejectedValue(error);
    f.data.writeValueWithoutResponse.mockRejectedValue(error);
    await expect(transport.writeCommand(bytes)).rejects.toBe(error);
    await expect(transport.writeData(bytes)).rejects.toBe(error);
  });

  it('copies only the notification DataView subrange and stops delivery after unsubscribe', async () => {
    const { transport } = await connectWebBluetooth();
    const received = vi.fn();
    const unsubscribe = transport.onNotification(received);
    f.notify.dispatchEvent(new Event('characteristicvaluechanged'));
    expect(received).not.toHaveBeenCalled();
    const source = new Uint8Array([99, 4, 5, 88]);
    f.notify.value = new DataView(source.buffer, 1, 2);
    f.notify.dispatchEvent(new Event('characteristicvaluechanged'));
    source.fill(0);
    expect(received).toHaveBeenCalledExactlyOnceWith(new Uint8Array([4, 5]));
    unsubscribe();
    f.notify.dispatchEvent(new Event('characteristicvaluechanged'));
    expect(received).toHaveBeenCalledOnce();
  });

  it('reports unexpected disconnects only to subscribed listeners and suppresses intentional disconnects', async () => {
    const { transport } = await connectWebBluetooth();
    const dropped = vi.fn(), removed = vi.fn();
    transport.onDisconnect(dropped);
    transport.onDisconnect(removed)();
    f.device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(dropped).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    transport.disconnect();
    transport.disconnect();
    expect(f.device.gatt.disconnect).toHaveBeenCalledOnce();
    expect(dropped).toHaveBeenCalledOnce();
  });
});
