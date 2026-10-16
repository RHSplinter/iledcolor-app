import { BleClient } from '@capacitor-community/bluetooth-le';
import { initNativeBle } from '../transport/nativeBle';
import { CONTENT_HEADER, CONTENT_SERVICE, contentCharacteristic, decodeTierContent } from './sharedContent';
import type { TierConfig, TierId } from './tiers';

export async function readPeerContent(deviceId: string, phoneId: number, tier: TierId): Promise<TierConfig> {
  await initNativeBle();
  await BleClient.connect(deviceId, undefined, { timeout: 5000 });
  try {
    const read = async (uuid: string) => {
      const value = await BleClient.read(deviceId, CONTENT_SERVICE, uuid, { timeout: 5000 });
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    };
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
}
