import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MotionSample } from './motion';

/** App-local native plugin (android/.../ApproachBeaconPlugin.java, ios/App/App/ApproachBeaconPlugin.swift). */
export interface ApproachBeaconPlugin {
  /** `name` (≤ 20 UTF-8 bytes, see fitBeaconName) is sent in the scan response / iOS local name. */
  start(opts: { uuid: string; name?: string }): Promise<{ advertising: boolean }>;
  stop(): Promise<void>;
  setKeepAwake(opts: { on: boolean }): Promise<void>;
  startMotion(): Promise<void>;
  stopMotion(): Promise<void>;
  addListener(event: 'motion', listener: (sample: MotionSample) => void): Promise<PluginListenerHandle>;
  addListener(event: 'motionError', listener: (error: { message: string }) => void): Promise<PluginListenerHandle>;
}

export const ApproachBeacon = registerPlugin<ApproachBeaconPlugin>('ApproachBeacon');
