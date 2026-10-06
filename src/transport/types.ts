/** Small BLE seam. The encoder and controller never touch navigator.bluetooth directly. */
export interface Transport {
  /** Write-without-response to A951. */
  writeCommand(data: Uint8Array): Promise<void>;
  /** Write-without-response to A952. */
  writeData(data: Uint8Array): Promise<void>;
  /** Subscribe to A953 notifications; returns an unsubscribe function. */
  onNotification(cb: (data: Uint8Array) => void): () => void;
  /** Called once when the GATT link drops (not when disconnect() is called by us). */
  onDisconnect(cb: () => void): () => void;
  disconnect(): void;
}

/** Thrown by a connector when the user dismisses the device chooser. */
export class SelectionCancelledError extends Error {
  constructor() {
    super('Device selection cancelled');
    this.name = 'SelectionCancelledError';
  }
}

export interface TransportProfile {
  /** Maximum stream bytes per Continue chunk. Spike default: 8 (20-byte frames). */
  chunkSize: number;
  /** Delay after each write, ms. Reference default: 10. */
  interWriteDelayMs: number;
  /** Largest stream the firmware accepted; capped at 65535 by the protocol. */
  maxStreamBytes: number;
  /** Set only after hardware shows the hat omits per-chunk acks. */
  allowMissingChunkAcks: boolean;
}

/** Conservative starting point; replace only with hardware-tested values. */
export const SPIKE_PROFILE: TransportProfile = {
  chunkSize: 8,
  interWriteDelayMs: 10,
  maxStreamBytes: 0xffff,
  allowMissingChunkAcks: false,
};
