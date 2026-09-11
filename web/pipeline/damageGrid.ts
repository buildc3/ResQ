/**
 * Synthetic damage/infrastructure-severity heat map — simulates what a
 * computer-vision damage-assessment pass over drone/satellite imagery would
 * produce, since no real imagery exists for either scenario. Rather than
 * re-coloring the existing anomaly-detection probability (a statistical
 * "is this unusual" signal), damage here is a separate physical-impact
 * metric: distance-weighted interpolation of each station's raw sensor
 * magnitude (rainfall + water-level rise for cloudburst, seismic amplitude
 * for earthquake) onto a regular grid, scaled to a 0-10 severity index.
 *
 * Normalization constants (RAIN_MAX_MM_HR, WATER_RISE_MAX_M) are the known
 * physical maxima baked into the generators (see cloudburst.ts) — damage
 * saturates at 10 only where a station is experiencing the worst case the
 * simulation ever produces, not an arbitrary ceiling.
 */
import { STATIONS } from './stations.js';
import { haversineKm, formatNaiveIso } from './mathUtils.js';
import type { StationSeries } from './cloudburst.js';

const GRID_COLS = 10;
const GRID_ROWS = 8;
const PADDING_DEG = 0.06;
const CLOUDBURST_DECAY_KM = 25;
const EARTHQUAKE_DECAY_KM = 30;
const RAIN_MAX_MM_HR = 90; // matches the generator's upper-catchment rainfall peak range
const WATER_RISE_MAX_M = 8; // matches Lachen's peak surge rise (see cloudburst.ts peakRiseM)
const AMPLITUDE_MAX = 1.0; // mainshock amplitude at the epicenter before attenuation

export interface GridCell { id: number; lat: number; lon: number; latMin: number; latMax: number; lonMin: number; lonMax: number }
export interface DamageGridPayload {
  cells: GridCell[];
  frames: { timestamp: string; values: number[] }[];
}

function buildGrid(): GridCell[] {
  const lats = STATIONS.map((s) => s.lat);
  const lons = STATIONS.map((s) => s.lon);
  const latMin = Math.min(...lats) - PADDING_DEG;
  const latMax = Math.max(...lats) + PADDING_DEG;
  const lonMin = Math.min(...lons) - PADDING_DEG;
  const lonMax = Math.max(...lons) + PADDING_DEG;
  const cells: GridCell[] = [];
  let id = 0;
  const latStep = (latMax - latMin) / GRID_ROWS;
  const lonStep = (lonMax - lonMin) / GRID_COLS;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cellLatMin = latMin + r * latStep;
      const cellLonMin = lonMin + c * lonStep;
      cells.push({
        id: id++,
        lat: cellLatMin + latStep / 2,
        lon: cellLonMin + lonStep / 2,
        latMin: cellLatMin,
        latMax: cellLatMin + latStep,
        lonMin: cellLonMin,
        lonMax: cellLonMin + lonStep,
      });
    }
  }
  return cells;
}

function waterBaseline(waterBody: string | null): number {
  return waterBody === 'South Lhonak Lake' ? 3.0 : 2.0;
}

export function buildCloudburstDamageGrid(series: StationSeries[], timesMs: number[]): DamageGridPayload {
  const cells = buildGrid();
  // Precompute per-station weight for each cell once (distance doesn't change over time).
  const weights = series.map((s) => cells.map((cell) => Math.exp(-haversineKm(cell.lat, cell.lon, s.station.lat, s.station.lon) / CLOUDBURST_DECAY_KM)));

  const frames = timesMs.map((t, i) => {
    const values = cells.map((_, cellIdx) => {
      let score = 0;
      for (let sIdx = 0; sIdx < series.length; sIdx++) {
        const s = series[sIdx];
        const rainIntensity = Math.min(1, s.rainfall[i] / RAIN_MAX_MM_HR) * 5;
        const level = s.waterLevel[i];
        const riseIntensity = level === null ? 0 : Math.min(1, Math.max(0, level - waterBaseline(s.station.waterBody)) / WATER_RISE_MAX_M) * 5;
        score += weights[sIdx][cellIdx] * (rainIntensity + riseIntensity);
      }
      return Math.round(Math.min(10, score) * 100) / 100;
    });
    return { timestamp: formatNaiveIso(t), values };
  });

  return { cells, frames };
}

export function buildEarthquakeDamageGrid(
  stationAmpBinned: Record<string, number[]>,
  frameTimestamps: string[],
): DamageGridPayload {
  const cells = buildGrid();
  const weights = STATIONS.map((st) => cells.map((cell) => Math.exp(-haversineKm(cell.lat, cell.lon, st.lat, st.lon) / EARTHQUAKE_DECAY_KM)));

  const frames = frameTimestamps.map((timestamp, i) => {
    const values = cells.map((_, cellIdx) => {
      let score = 0;
      STATIONS.forEach((st, sIdx) => {
        const amp = stationAmpBinned[st.id][i] ?? 0;
        const intensity = Math.min(1, amp / AMPLITUDE_MAX) * 10;
        score = Math.max(score, weights[sIdx][cellIdx] * intensity);
      });
      return Math.round(Math.min(10, score) * 100) / 100;
    });
    return { timestamp, values };
  });

  return { cells, frames };
}
