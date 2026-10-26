import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconnectWebBluetooth, SERVICE_A950 } from '../src/transport/webBluetooth';
import { SelectionCancelledError } from '../src/transport/types';

function char(props: Partial<BluetoothCharacteristicProperties>) {
  return Object.assign(new EventTarget(), {
    properties: props,
    value: undefined,
    startNotifications: vi.fn(async () => undefined),
    writeValueWithoutResponse: vi.fn(async () => undefined),
  });
}

function fakeDevice(failures: number) {
  const service = {
    getCharacteristic: vi.fn(async (uuid: string) => uuid.startsWith('0000a953') ? char({ notify: true }) : char({ writeWithoutResponse: true })),
  };
  const server = { getPrimaryService: vi.fn(async (uuid: string) => { expect(uuid).toBe(SERVICE_A950); return service; }), disconnect: vi.fn() };
  let attempts = 0;
  const watch = vi.fn(async (_o?: { signal?: AbortSignal }) => undefined);
  const device = Object.assign(new EventTarget(), {
    id: 'hat-1',
    name: 'iledcolor-TEST',
    watchAdvertisements: watch,
    gatt: {
      connected: false,
      connect: vi.fn(async () => {
        if (attempts++ < failures) throw new DOMException('Bluetooth Device is no longer in range.', 'NetworkError');
        return server;
      }),
      disconnect: vi.fn(),
    },
  });
  return { device, watch, attempts: () => attempts };
}

function stubBluetooth(devices: unknown[] | undefined) {
  vi.stubGlobal('navigator', { bluetooth: devices ? { getDevices: vi.fn(async () => devices) } : {} });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('reconnectWebBluetooth', () => {
  it('retries while the hat is being rediscovered, then stops watching', async () => {
    const { device, watch, attempts } = fakeDevice(2);
    stubBluetooth([device]);
    const r = await reconnectWebBluetooth('hat-1', 5000, 5);
    expect(r.deviceName).toBe('iledcolor-TEST');
    expect(r.deviceId).toBe('hat-1');
    expect(attempts()).toBe(3);
    expect(watch.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
  });

  it('gives up with the last error once the timeout passes', async () => {
    const { device, watch } = fakeDevice(Infinity);
    stubBluetooth([device]);
    await expect(reconnectWebBluetooth('hat-1', 60, 20)).rejects.toThrow('no longer in range');
    expect(watch.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
  });

  it('treats a missing permission or unsupported browser as "not available"', async () => {
    stubBluetooth([]);
    await expect(reconnectWebBluetooth('hat-1')).rejects.toBeInstanceOf(SelectionCancelledError);
    stubBluetooth(undefined);
    await expect(reconnectWebBluetooth('hat-1')).rejects.toBeInstanceOf(SelectionCancelledError);
  });
});
