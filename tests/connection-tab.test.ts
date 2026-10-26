import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionTabClient, hostConnectionTab } from '../src/transport/connectionTab';
import type { Transport } from '../src/transport/types';
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((close) => close()); });

function fixture() {
  const key = crypto.randomUUID();
  const notes = new Set<(bytes: Uint8Array) => void>();
  const transport: Transport = {
    writeCommand: vi.fn(async () => { notes.forEach((cb) => cb(Uint8Array.of(84, 1))); }),
    writeData: vi.fn(async () => {}),
    onNotification: (cb) => { notes.add(cb); return () => notes.delete(cb); },
    onDisconnect: () => () => {}, disconnect: vi.fn(),
  };
  const host = hostConnectionTab(key, vi.fn());
  host.setConnection({ transport, deviceId: 'hat-231B', deviceName: 'iledcolor-231B' });
  const client = new ConnectionTabClient(key);
  cleanups.push(() => { client.close(); host.close(); });
  return { key, host, client, transport };
}

describe('connection tab transport', () => {
  it('forwards protocol writes and notifications without moving the Bluetooth object', async () => {
    const { client, transport } = fixture();
    const connection = await client.connect('hat-231B', 500);
    const note = new Promise<Uint8Array>((resolve) => connection.transport.onNotification(resolve));
    await connection.transport.writeCommand(Uint8Array.of(1, 2, 3));
    await connection.transport.writeData(Uint8Array.of(4, 5));
    expect(await note).toEqual(Uint8Array.of(84, 1));
    expect(transport.writeCommand).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3));
    expect(transport.writeData).toHaveBeenCalledWith(Uint8Array.of(4, 5));
  });
  it('rejects a different remembered hat instead of taking the available connection', async () => {
    const { client, transport } = fixture();
    await expect(client.connect('another-hat', 100)).rejects.toThrow('different LED hat');
    expect(transport.writeCommand).not.toHaveBeenCalled();
  });
  it('reattaches a new main page without disconnecting the physical link', async () => {
    const { key, client, transport } = fixture();
    await client.connect('hat-231B', 500);
    client.close();
    const nextPage = new ConnectionTabClient(key);
    cleanups.push(() => nextPage.close());
    expect((await nextPage.connect('hat-231B', 500)).deviceName).toBe('iledcolor-231B');
    // setConnection disposes the previous (empty) slot; reattach itself never disconnects.
    expect(transport.disconnect).not.toHaveBeenCalled();
  });
  it('explicit disconnect reaches the connection owner', async () => {
    const { client, transport } = fixture();
    const connection = await client.connect('hat-231B', 500);
    const dropped = new Promise<void>((resolve) => connection.transport.onDisconnect(resolve));
    connection.transport.disconnect();
    await dropped;
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });
});
