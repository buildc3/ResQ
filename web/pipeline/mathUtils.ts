import { SeededRng } from './rng.js';

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// --- naive-local timestamp handling -----------------------------------
// Pipeline timestamps are "naive local" (Sikkim time, no timezone suffix),
// same convention as the Python version and the frontend. Date arithmetic
// here always goes through Date.UTC(...)/getUTC*() so the *value* of the
// wall-clock fields is preserved exactly — UTC is used purely as an
// arbitrary, unambiguous internal representation, not as the true zone.
export function parseNaiveIso(iso: string): number {
  const [datePart, timePart] = iso.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s ?? 0);
}
export function formatNaiveIso(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
export function timeGridMs(startIso: string, endIso: string, stepSeconds: number): number[] {
  const startMs = parseNaiveIso(startIso);
  const endMs = parseNaiveIso(endIso);
  const out: number[] = [];
  for (let t = startMs; t <= endMs; t += stepSeconds * 1000) out.push(t);
  return out;
}

// --- rolling window statistics ------------------------------------------
// Trailing, inclusive-of-current-index window (matches pandas .rolling(window, min_periods)).
export function rollingMeanStd(values: number[], window: number, minPeriods: number): { mean: number[]; std: number[] } {
  const n = values.length;
  const mean = new Array<number>(n).fill(NaN);
  const std = new Array<number>(n).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  let validCount = 0; // count of non-NaN values currently in the window
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isNaN(v)) {
      sum += v;
      sumSq += v * v;
      validCount++;
    }
    if (i >= window) {
      const old = values[i - window];
      if (!Number.isNaN(old)) {
        sum -= old;
        sumSq -= old * old;
        validCount--;
      }
    }
    if (validCount >= minPeriods) {
      const m = sum / validCount;
      mean[i] = m;
      std[i] = Math.sqrt(Math.max(0, sumSq / validCount - m * m));
    }
  }
  return { mean, std };
}

/**
 * Z-score of each point against its own trailing baseline (shifted by one
 * sample, so the baseline never includes the point being scored — no
 * look-ahead). minStd floors the denominator to a sensor-appropriate noise
 * level so a quiet/low-variance baseline doesn't make a merely-moderate
 * reading look like an extreme anomaly.
 */
export function rollingZ(values: number[], window: number, minPeriods: number, minStd?: number): number[] {
  const n = values.length;
  const shifted = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) shifted[i] = values[i - 1];
  const { mean, std } = rollingMeanStd(shifted, window, minPeriods);
  const z = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(mean[i]) || Number.isNaN(std[i])) continue;
    const s = minStd !== undefined ? Math.max(std[i], minStd) : std[i];
    if (s === 0) continue;
    z[i] = (values[i] - mean[i]) / s;
  }
  return z;
}

export function sigmoid(x: number, k = 1): number {
  return 1 / (1 + Math.exp(-k * x));
}

/** Slowly-varying mean-reverting noise (used for e.g. soil moisture). */
export function ar1Series(n: number, mean: number, phi: number, sigma: number, rng: SeededRng): number[] {
  const x = new Array<number>(n);
  x[0] = mean;
  for (let i = 1; i < n; i++) x[i] = mean + phi * (x[i - 1] - mean) + rng.normal(0, sigma);
  return x;
}

export function gaussianBump(t: number, center: number, width: number, peak: number): number {
  return peak * Math.exp(-0.5 * ((t - center) / width) ** 2);
}

/**
 * Fast rise to `peak` starting at onset, then exponential recession —
 * used for river/lake water-level surges (sharp hydrograph rise, slow decay).
 */
export function riseAndRecede(tHours: number, onsetHours: number, riseHours: number, peak: number, decayTauHours: number): number {
  const dt = tHours - onsetHours;
  if (dt < 0) return 0;
  if (dt < riseHours) return peak * (dt / riseHours);
  return peak * Math.exp(-(dt - riseHours) / decayTauHours);
}

/** A short seismic-wavelet-like burst: oscillation under an exponential envelope. */
export function dampedSineBurst(nSamples: number, sampleRateHz: number, amplitude: number, freqHz: number, decayPerS: number, rng: SeededRng, noise = 0.03): number[] {
  const phase = rng.uniform(0, 2 * Math.PI);
  const out = new Array<number>(nSamples);
  for (let i = 0; i < nSamples; i++) {
    const t = i / sampleRateHz;
    const envelope = amplitude * Math.exp(-decayPerS * t);
    const wave = envelope * Math.sin(2 * Math.PI * freqHz * t + phase) + rng.normal(0, noise * Math.max(amplitude, 1e-6));
    out[i] = Math.abs(wave);
  }
  return out;
}
