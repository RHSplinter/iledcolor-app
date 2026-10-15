/**
 * Rough distance from BLE RSSI with the log-distance path-loss model
 * d = 10 ^ ((rssiAt1m - rssi) / (10 * n)).
 * Calibrated for phones/caps indoors: about -62 dBm at 1 m, path-loss exponent 2.2.
 * Bodies, pockets and walls easily change RSSI by 10 dB, so treat it as an estimate only.
 */
export const RSSI_AT_1M = -62;
export const PATH_LOSS_EXPONENT = 2.2;

export function estimateMeters(rssi: number): number {
  return Math.pow(10, (RSSI_AT_1M - rssi) / (10 * PATH_LOSS_EXPONENT));
}

/** RSSI at which the estimate reaches the given distance. */
export function dbmForMeters(m: number): number {
  return Math.round(RSSI_AT_1M - 10 * PATH_LOSS_EXPONENT * Math.log10(m));
}

export function formatMeters(rssi: number | undefined): string {
  if (rssi === undefined || !Number.isFinite(rssi)) return '';
  const m = estimateMeters(rssi);
  if (m < 0.5) return '< 0.5 m';
  if (m < 10) return `≈ ${m.toFixed(1)} m`;
  if (m > 50) return '> 50 m';
  return `≈ ${Math.round(m)} m`;
}
