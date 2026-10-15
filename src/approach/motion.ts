/** Magnitudes in SI units, independent of how the phone is held. No positions are integrated. */
export interface MotionSample { acceleration: number; rotation: number }
export type MotionState = 'unavailable' | 'still' | 'moving' | 'turning';

export class MotionTracker {
  private lastSample = -Infinity;
  private movingUntil = -Infinity;
  private turningUntil = -Infinity;

  update(sample: MotionSample, now: number): void {
    if (!Number.isFinite(now) || !Number.isFinite(sample.acceleration) || !Number.isFinite(sample.rotation)
      || sample.acceleration < 0 || sample.rotation < 0 || now < this.lastSample) return;
    this.lastSample = now;
    if (sample.acceleration >= 0.65) this.movingUntil = now + 1500;
    if (sample.rotation >= 0.8) this.turningUntil = now + 600;
  }

  state(now: number): MotionState {
    if (now < this.lastSample || now - this.lastSample > 1500) return 'unavailable';
    if (now < this.turningUntil) return 'turning';
    return now < this.movingUntil ? 'moving' : 'still';
  }

  reset(): void {
    this.lastSample = this.movingUntil = this.turningUntil = -Infinity;
  }
}
