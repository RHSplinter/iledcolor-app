import { median } from './proximity';

/** Raw RSSI samples needed per calibration step. */
export const CALIBRATION_MIN_SAMPLES = 5;
/** Below this difference between "together" and "away" the two distances cannot be told apart reliably. */
export const CALIBRATION_MIN_GAP_DB = 6;

export interface Calibration { enterDbm: number; leaveDbm: number; togetherDbm: number; awayDbm: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Thresholds from two measurements on this phone: standing together and standing at the distance
 * that should count as "away". Medians ignore single outliers. "Away" is set just above the away
 * level, so that distance reliably counts as away; "near" sits between both levels, below the
 * together level, with at least 2 dB of hysteresis.
 */
export function calibrate(together: number[], away: number[]): Calibration | { error: string } {
  const t = together.filter(Number.isFinite), a = away.filter(Number.isFinite);
  if (t.length < CALIBRATION_MIN_SAMPLES || a.length < CALIBRATION_MIN_SAMPLES)
    return { error: `Need at least ${CALIBRATION_MIN_SAMPLES} reports per step; stay in place a little longer.` };
  const togetherDbm = Math.round(median(t)), awayDbm = Math.round(median(a));
  const gap = togetherDbm - awayDbm;
  if (gap < CALIBRATION_MIN_GAP_DB)
    return { error: `Together (${togetherDbm} dBm) and away (${awayDbm} dBm) differ by only ${gap} dB; step farther apart for the away measurement.` };
  const leaveDbm = clamp(awayDbm + 2, -120, -22);
  const enterDbm = clamp(Math.max(leaveDbm + 2, Math.round(togetherDbm - Math.max(3, gap * 0.4))), leaveDbm, -20);
  return { enterDbm, leaveDbm, togetherDbm, awayDbm };
}
