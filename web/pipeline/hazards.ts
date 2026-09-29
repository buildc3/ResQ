/**
 * SIH26084 hazard outputs, computed per grid cell for the CURRENT (observed)
 * frame only — Milestone 1 does not project these forward across the 0-6h
 * lead-time axis (that needs the general forecast engine, deferred; see
 * README "Deferred to next milestone").
 *
 * Cloudburst rainfall is derived from reflectivity via a named Z-R relation.
 * Hail probability and downburst velocity are explicitly labeled PROXY
 * heuristics — no public labelled hail/downburst dataset for India exists to
 * calibrate against, so these are simple, documented formulas standing in
 * for a real model, not a claim of measured skill. Lightning strike density
 * is a direct count of the simulated flashes, not a proxy.
 *
 * VERIFICATION STATUS (see README "What's real, what's simulated" table):
 *  - Z-R relation: Marshall & Palmer (1948), Z = 200 * R^1.6 — a standard,
 *    widely-cited textbook relation. Coefficients used here were not
 *    re-verified against a primary source in this session (network access
 *    was unavailable) — TO BE VERIFIED before treating this as authoritative.
 *  - IMD cloudburst threshold used here (>=100mm rainfall in an hour) is a
 *    commonly cited figure but was likewise NOT verified against a primary
 *    IMD source in this session — TO BE VERIFIED.
 */
import { GRID_CELLS } from './grid.js';
import type { ConvectionFrame, LightningFlash } from './convection.js';

// Z = A * R^b  =>  R = (Z/A)^(1/b), with Z in linear units (mm^6/m^3), not dBZ.
const ZR_A = 200;
const ZR_B = 1.6;
function reflectivityDbzToRainRateMmHr(dbz: number): number {
  if (dbz <= 0) return 0;
  const zLinear = 10 ** (dbz / 10);
  return (zLinear / ZR_A) ** (1 / ZR_B);
}

// TO BE VERIFIED against a primary IMD source.
const CLOUDBURST_RAIN_RATE_MM_HR = 100;
const ELEVATED_RAIN_RATE_MM_HR = 50; // "Yellow" pre-warning level, half the cloudburst threshold

// Hail probability proxy: normalized core intensity above a height-weighted
// reflectivity threshold typically associated with large-hail-bearing cores.
// PROXY — not calibrated against any real hail observation.
const HAIL_PROXY_DBZ_FLOOR = 45;
const HAIL_PROXY_DBZ_CEIL = 60;
function hailProbabilityProxy(dbz: number): number {
  if (dbz <= HAIL_PROXY_DBZ_FLOOR) return 0;
  return Math.min(1, (dbz - HAIL_PROXY_DBZ_FLOOR) / (HAIL_PROXY_DBZ_CEIL - HAIL_PROXY_DBZ_FLOOR));
}

// Downburst velocity proxy: scales with core intensity above a threshold
// associated with strong convective cores capable of a wet-microburst
// collapse. PROXY — not calibrated against any real downburst observation.
const DOWNBURST_PROXY_DBZ_FLOOR = 45;
const DOWNBURST_PROXY_MAX_KMH = 90;
function downburstVelocityProxyKmh(dbz: number): number {
  if (dbz <= DOWNBURST_PROXY_DBZ_FLOOR) return 0;
  const frac = Math.min(1, (dbz - DOWNBURST_PROXY_DBZ_FLOOR) / (HAIL_PROXY_DBZ_CEIL - DOWNBURST_PROXY_DBZ_FLOOR));
  return Math.round(frac * DOWNBURST_PROXY_MAX_KMH);
}

export type ZoneLevel = 'nominal' | 'yellow' | 'red';

export interface HazardCell {
  cell_id: string;
  rain_rate_mm_hr: number;
  hail_probability_proxy: number;
  downburst_velocity_proxy_kmh: number;
  lightning_flash_density_per_km2_10min: number;
  zone: ZoneLevel;
}
export interface HazardFrame { timestamp: string; cells: HazardCell[] }

const CELL_AREA_KM2 = 1.5 * 1.5; // matches grid.ts's ~1.5km cell size

export function buildHazardFrames(convectionFrames: ConvectionFrame[], lightning: LightningFlash[]): HazardFrame[] {
  const cellById = Object.fromEntries(GRID_CELLS.map((c) => [c.id, c]));
  return convectionFrames.map((frame) => {
    const cells: HazardCell[] = frame.cells
      .filter((c) => cellById[c.cell_id]) // guard against any stale ids
      .map((c) => {
        const rainRate = reflectivityDbzToRainRateMmHr(c.reflectivity_dbz);
        const hailP = hailProbabilityProxy(c.reflectivity_dbz);
        const downburstKmh = downburstVelocityProxyKmh(c.reflectivity_dbz);
        let zone: ZoneLevel = 'nominal';
        if (rainRate >= CLOUDBURST_RAIN_RATE_MM_HR || hailP > 0.6 || downburstKmh > 60) zone = 'red';
        else if (rainRate >= ELEVATED_RAIN_RATE_MM_HR || hailP > 0.3 || downburstKmh > 30) zone = 'yellow';
        return {
          cell_id: c.cell_id,
          rain_rate_mm_hr: Math.round(rainRate * 10) / 10,
          hail_probability_proxy: Math.round(hailP * 1000) / 1000,
          downburst_velocity_proxy_kmh: downburstKmh,
          lightning_flash_density_per_km2_10min: 0, // filled in below
          zone,
        };
      });
    return { timestamp: frame.timestamp, cells };
  }).map((frame, i, all) => {
    // Lightning density: flashes within this 10-min frame window, per km^2,
    // attributed to whichever active cell each flash is nearest (flashes
    // were generated within a cell's own bounds in convection.ts, so a
    // simple prefix match on cell_id set is enough here).
    const windowStart = i > 0 ? all[i - 1].timestamp : frame.timestamp;
    const flashesInWindow = lightning.filter((f) => f.time > windowStart && f.time <= frame.timestamp);
    if (flashesInWindow.length === 0) return frame;
    const counts: Record<string, number> = {};
    for (const flash of flashesInWindow) {
      let nearest: string | null = null;
      let nearestDist = Infinity;
      for (const cell of frame.cells) {
        const c = cellById[cell.cell_id];
        const d = (c.lat - flash.lat) ** 2 + (c.lon - flash.lon) ** 2;
        if (d < nearestDist) { nearestDist = d; nearest = cell.cell_id; }
      }
      if (nearest) counts[nearest] = (counts[nearest] || 0) + 1;
    }
    return {
      timestamp: frame.timestamp,
      cells: frame.cells.map((c) => counts[c.cell_id]
        ? { ...c, lightning_flash_density_per_km2_10min: Math.round((counts[c.cell_id] / CELL_AREA_KM2) * 1000) / 1000 }
        : c),
    };
  });
}

export const HAZARD_PARAMS = {
  zr_relation: 'Marshall-Palmer: Z = 200 * R^1.6 (TO BE VERIFIED against a primary source)',
  cloudburst_rain_rate_mm_hr: CLOUDBURST_RAIN_RATE_MM_HR,
  elevated_rain_rate_mm_hr: ELEVATED_RAIN_RATE_MM_HR,
  hail_probability_proxy_range_dbz: [HAIL_PROXY_DBZ_FLOOR, HAIL_PROXY_DBZ_CEIL],
  downburst_velocity_proxy_floor_dbz: DOWNBURST_PROXY_DBZ_FLOOR,
};
