import { registerPlugin } from '@capacitor/core';

/** App-local native plugin (android/.../ApproachBeaconPlugin.java, ios/App/App/ApproachBeaconPlugin.swift). */
export interface ApproachBeaconPlugin {
  start(opts: { uuid: string }): Promise<{ advertising: boolean }>;
  stop(): Promise<void>;
  setKeepAwake(opts: { on: boolean }): Promise<void>;
}

export const ApproachBeacon = registerPlugin<ApproachBeaconPlugin>('ApproachBeacon');
