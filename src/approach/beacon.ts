import { registerPlugin } from '@capacitor/core';

/** App-local native plugin (android/.../ApproachBeaconPlugin.java, ios/App/App/ApproachBeaconPlugin.swift). */
export interface ApproachBeaconPlugin {
  /** `name` (≤ 20 UTF-8 bytes, see fitBeaconName) is sent in the scan response / iOS local name. */
  start(opts: { uuid: string; name?: string }): Promise<{ advertising: boolean }>;
  stop(): Promise<void>;
  setKeepAwake(opts: { on: boolean }): Promise<void>;
}

export const ApproachBeacon = registerPlugin<ApproachBeaconPlugin>('ApproachBeacon');
