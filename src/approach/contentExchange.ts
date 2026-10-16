import { BleClient } from '@capacitor-community/bluetooth-le';
import { initNativeBle } from '../transport/nativeBle';
import { ApproachBeacon } from './beacon';
import { CONTENT_HEADER, CONTENT_SERVICE, contentCharacteristic, decodeTierContent } from './sharedContent';
import { ShareReceiver, type ReceiverHooks, type ShareLink } from './presetShare';
import type { TierConfig, TierId } from './tiers';

/** One connection per phone at a time: a preset transfer must not be cut by a text refresh disconnecting. */
const peerLocks = new Map<string, Promise<unknown>>();
export const peerBusy = (deviceId: string) => peerLocks.has(deviceId);

async function withPeer<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  while (peerLocks.has(deviceId)) await peerLocks.get(deviceId)!.catch(() => undefined);
  const run = fn();
  peerLocks.set(deviceId, run);
  try { return await run; } finally { if (peerLocks.get(deviceId) === run) peerLocks.delete(deviceId); }
}

const bytes = (value: DataView) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
const view = (value: Uint8Array) => new DataView(value.buffer, value.byteOffset, value.byteLength);

export async function readPeerContent(deviceId: string, phoneId: number, tier: TierId): Promise<TierConfig> {
  await initNativeBle();
  return withPeer(deviceId, async () => {
    await BleClient.connect(deviceId, undefined, { timeout: 5000 });
    try {
      const read = async (uuid: string) => bytes(await BleClient.read(deviceId, CONTENT_SERVICE, uuid, { timeout: 5000 }));
      const header = await read(CONTENT_HEADER);
      if (header.length !== 8 || new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0) !== phoneId)
        throw new Error('Shared text belongs to a different phone');
      const config = decodeTierContent(await read(contentCharacteristic(tier)));
      const after = await read(CONTENT_HEADER);
      if (after.length !== header.length || after.some((b, i) => b !== header[i]))
        throw new Error('Peer text changed during transfer; retrying');
      return config;
    } finally {
      await BleClient.disconnect(deviceId);
    }
  });
}

/** Runs `fn` with a link to a nearby phone's approach GATT service, holding that phone's connection lock. */
export async function withShareLink<T>(deviceId: string, fn: (link: ShareLink) => Promise<T>): Promise<T> {
  await initNativeBle();
  return withPeer(deviceId, () => fn({
    connect: () => BleClient.connect(deviceId, undefined, { timeout: 8000 }),
    disconnect: () => BleClient.disconnect(deviceId),
    maxWrite: async () => Math.max(20, (await BleClient.getMtu(deviceId).catch(() => 23)) - 3),
    write: (uuid, value) => BleClient.write(deviceId, CONTENT_SERVICE, uuid, view(value), { timeout: 5000 }),
    read: async (uuid) => bytes(await BleClient.read(deviceId, CONTENT_SERVICE, uuid, { timeout: 5000 })),
  }));
}

/** Receives offers written by nearby phones (needs approach mode on, which opens the GATT service). */
export async function listenForShares(hooks: Omit<ReceiverHooks, 'publishStatus'>): Promise<ShareReceiver> {
  const receiver = new ShareReceiver({
    ...hooks,
    publishStatus: (value) => void ApproachBeacon.setShareStatus({ value: btoa(String.fromCharCode(...value)) }).catch(() => undefined),
  });
  await ApproachBeacon.addListener('shareWrite', ({ value }) => {
    try { receiver.handleWrite(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))); } catch { /* malformed base64: ignore */ }
  });
  setInterval(() => receiver.tick(), 1000);
  return receiver;
}
