import type { PluginListenerHandle } from '@capacitor/core';
import type { ApproachBeaconPlugin } from './beacon';
import type { MotionSample } from './motion';

type MotionSource = Pick<ApproachBeaconPlugin, 'startMotion' | 'stopMotion'> & {
  addListener(event: 'motion', listener: (sample: MotionSample) => void): Promise<PluginListenerHandle>;
  addListener(event: 'motionError', listener: (error: { message: string }) => void): Promise<PluginListenerHandle>;
};

/** Serialize native setup/teardown, including a stop requested while setup is pending. */
export class MotionSupport {
  private listeners: PluginListenerHandle[] = [];
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private source: MotionSource, private onSample: (sample: MotionSample) => void,
    private onError: (message: string) => void) {}

  start(): Promise<void> {
    this.queue = this.queue.then(async () => {
      await this.cleanup();
      try {
        this.listeners.push(await this.source.addListener('motion', this.onSample));
        this.listeners.push(await this.source.addListener('motionError', ({ message }) => this.onError(message)));
        this.started = true;
        await this.source.startMotion();
      } catch (error) {
        await this.cleanup();
        this.onError(error instanceof Error ? error.message : String(error));
      }
    });
    return this.queue;
  }

  stop(): Promise<void> {
    this.queue = this.queue.then(() => this.cleanup());
    return this.queue;
  }

  private async cleanup(): Promise<void> {
    const listeners = this.listeners.splice(0);
    const jobs = listeners.map((listener) => listener.remove());
    if (this.started) { this.started = false; jobs.push(this.source.stopMotion()); }
    for (const result of await Promise.allSettled(jobs)) {
      if (result.status === 'rejected') this.onError(`Motion cleanup failed: ${String(result.reason)}`);
    }
  }
}
