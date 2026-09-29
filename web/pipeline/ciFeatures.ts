/**
 * Feature computation for convective-initiation detection, kept separate
 * from the detector itself (ciDetection.ts) — same split as damage.ts is
 * kept separate from cloudburst.ts's detector.
 */

/** Cloud-top cooling rate: positive when brightness temperature is
 *  dropping (cooling), in K per 10-min step — the satellite-side CI
 *  precursor signal. */
export function coolingRateSeries(irBrightnessK: number[], stepMinutes: number): number[] {
  const n = irBrightnessK.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) out[i] = -(irBrightnessK[i] - irBrightnessK[i - 1]) / stepMinutes;
  return out;
}
