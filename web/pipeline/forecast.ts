/**
 * WP5 baseline nowcast — the "must have" tier from the SIH26084 brief:
 * cell identification (>=40dBZ contours), centroid tracking across frames
 * to get a speed/direction vector, then advection extrapolation of the
 * fields out to T+6h with a simple lifecycle growth/decay term. This
 * replaces the Milestone 1 "forecast engine not yet implemented" UI
 * placeholder with a real, honestly-derived forecast.
 *
 * Deliberately NOT the general/stretch case: no multi-frame vision-based
 * object tracking, no ML model (ConvLSTM/U-Net) — see README "Deferred to
 * a future milestone" for why that tier is skipped. This is the simple,
 * explainable baseline the brief explicitly calls out as sufficient.
 *
 * Important honesty constraint: this only ever reads OBSERVED data (the
 * sparse per-frame reflectivity cell lists in ConvectionFrame) — never
 * convection.ts's ConvectionGroundTruth (track/steering_vector/maturity),
 * which exists only for CI-lead-time proof and TTI, both already clearly
 * labeled as reading the simulated event's own known ground truth. A
 * forecast that secretly read the future track wouldn't be a forecast.
 */
import { GRID_CELLS } from './grid.js';
import { haversineKm, parseNaiveIso, formatNaiveIso } from './mathUtils.js';
import { LEAD_TIME_MINUTES } from './grid.js';
import type { ConvectionFrame } from './convection.js';

export const CELL_ID_THRESHOLD_DBZ = 40; // matches convection.ts's MATURITY_REFLECTIVITY_DBZ

interface IdentifiedCell { row: number; col: number; lat: number; lon: number; reflectivity_dbz: number }
interface TrackedFrame { timestamp: string; centroid_lat: number; centroid_lon: number; peak_dbz: number; cells: IdentifiedCell[] }

export interface ForecastFrame {
  base_timestamp: string;
  lead_minutes: number;
  cells: { cell_id: string; reflectivity_dbz: number }[];
}

const cellById = Object.fromEntries(GRID_CELLS.map((c) => [c.id, c]));

/** Identify >=40dBZ cells at each observed frame and their reflectivity-weighted centroid. */
function identifyCells(frames: ConvectionFrame[]): (TrackedFrame | null)[] {
  return frames.map((frame) => {
    const identified = frame.cells
      .filter((c) => c.reflectivity_dbz >= CELL_ID_THRESHOLD_DBZ)
      .map((c) => ({ ...cellById[c.cell_id], reflectivity_dbz: c.reflectivity_dbz }))
      .filter((c) => c.lat !== undefined);
    if (identified.length === 0) return null;
    let sumW = 0, sumLat = 0, sumLon = 0, peak = 0;
    for (const c of identified) {
      sumW += c.reflectivity_dbz;
      sumLat += c.lat * c.reflectivity_dbz;
      sumLon += c.lon * c.reflectivity_dbz;
      if (c.reflectivity_dbz > peak) peak = c.reflectivity_dbz;
    }
    return { timestamp: frame.timestamp, centroid_lat: sumLat / sumW, centroid_lon: sumLon / sumW, peak_dbz: peak, cells: identified };
  });
}

export function buildForecastFrames(frames: ConvectionFrame[]): ForecastFrame[] {
  const tracked = identifyCells(frames);
  const out: ForecastFrame[] = [];

  for (let i = 0; i < frames.length; i++) {
    const now = tracked[i];
    if (!now) continue; // no identified cell yet at this base frame — nothing to extrapolate from

    // Velocity: from the two most recent identified frames (this one and
    // the previous one that had an identified cell) — a real baseline
    // only ever knows its own recent history, never the future track.
    let prevIdx = i - 1;
    while (prevIdx >= 0 && !tracked[prevIdx]) prevIdx--;
    const prev = prevIdx >= 0 ? tracked[prevIdx] : null;
    const dtMin = prev ? (parseNaiveIso(now.timestamp) - parseNaiveIso(prev.timestamp)) / 60000 : 0;
    const velLatPerMin = prev && dtMin > 0 ? (now.centroid_lat - prev.centroid_lat) / dtMin : 0;
    const velLonPerMin = prev && dtMin > 0 ? (now.centroid_lon - prev.centroid_lon) / dtMin : 0;

    // Lifecycle trend: estimate growth/decay rate from the observed peak
    // reflectivity trend so far (positive while intensifying, negative
    // once it turns over) — never the simulator's own true decay tau.
    const growthRatePerMin = prev && dtMin > 0 && prev.peak_dbz > 0
      ? Math.log(Math.max(1, now.peak_dbz) / Math.max(1, prev.peak_dbz)) / dtMin
      : 0;

    // Footprint radius: approximate from the identified cell count's area
    // (same assumption a simple baseline would make — hold radius roughly
    // constant over the extrapolation window rather than modeling its own
    // growth/shrink physics, which is genuinely harder than intensity decay).
    const areaKm2 = now.cells.length * 1.5 * 1.5;
    const radiusKm = Math.max(3, Math.sqrt(areaKm2 / Math.PI));

    for (const leadMinutes of LEAD_TIME_MINUTES) {
      if (leadMinutes === 0) continue; // T+0 is the observed frame itself, not a forecast
      const forecastLat = now.centroid_lat + velLatPerMin * leadMinutes;
      const forecastLon = now.centroid_lon + velLonPerMin * leadMinutes;
      // Bounded exponential trend — a storm can't grow forever, and shouldn't
      // be forecast below 0; clamp to a sane ceiling so a brief upward blip
      // right at the base frame doesn't extrapolate into something absurd.
      const forecastPeak = Math.max(0, Math.min(65, now.peak_dbz * Math.exp(growthRatePerMin * leadMinutes)));
      if (forecastPeak < CELL_ID_THRESHOLD_DBZ - 15) continue; // decayed too far to be worth exporting

      const cellsOut: ForecastFrame['cells'] = [];
      for (const cell of GRID_CELLS) {
        const distKm = haversineKm(cell.lat, cell.lon, forecastLat, forecastLon);
        const v = forecastPeak * Math.exp(-(distKm ** 2) / (2 * radiusKm ** 2));
        if (v > CELL_ID_THRESHOLD_DBZ - 20) cellsOut.push({ cell_id: cell.id, reflectivity_dbz: Math.round(v * 10) / 10 });
      }
      if (cellsOut.length > 0) out.push({ base_timestamp: now.timestamp, lead_minutes: leadMinutes, cells: cellsOut });
    }
  }
  return out;
}

// Re-exported so build.ts/verification.ts don't need to know forecast.ts's
// internal helper name for "what timestamp does this forecast target".
export function targetTimestamp(baseTimestamp: string, leadMinutes: number): string {
  return formatNaiveIso(parseNaiveIso(baseTimestamp) + leadMinutes * 60000);
}
