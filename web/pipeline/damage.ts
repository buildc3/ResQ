/**
 * Simulated computer-vision damage/infrastructure severity — a 0-10 index
 * per station ("tower"), per frame. Since there's no real imagery, this
 * stands in for what a CV damage-assessment pass would output: intensity
 * derived from each station's own raw physical sensor magnitude (rainfall +
 * water-level rise for cloudburst, seismic amplitude for earthquake) —
 * deliberately a different metric from the detection probability, not a
 * re-color of it.
 *
 * Unlike the earlier spatial-grid version, this outputs one value per real
 * station location and lets the frontend's heat-map layer (leaflet.heat)
 * handle the spatial blending/radiating visually — closer to how an actual
 * heat map works (few real point sources, smooth falloff) than a synthetic
 * interpolation grid.
 */
import { STATIONS } from './stations.js';
import { formatNaiveIso } from './mathUtils.js';
import type { StationSeries } from './cloudburst.js';

const RAIN_MAX_MM_HR = 90; // matches the generator's upper-catchment rainfall peak range
const WATER_RISE_MAX_M = 8; // matches Lachen's peak surge rise (see cloudburst.ts peakRiseM)
const AMPLITUDE_MAX = 1.0; // mainshock amplitude at the epicenter before attenuation

export interface StationDamageFrame { timestamp: string; stations: Record<string, number> }

function waterBaseline(waterBody: string | null): number {
  return waterBody === 'South Lhonak Lake' ? 3.0 : 2.0;
}

export function buildCloudburstStationDamage(series: StationSeries[], timesMs: number[]): StationDamageFrame[] {
  return timesMs.map((t, i) => {
    const stations: Record<string, number> = {};
    for (const s of series) {
      const rainIntensity = Math.min(1, s.rainfall[i] / RAIN_MAX_MM_HR) * 5;
      const level = s.waterLevel[i];
      const riseIntensity = level === null ? 0 : Math.min(1, Math.max(0, level - waterBaseline(s.station.waterBody)) / WATER_RISE_MAX_M) * 5;
      stations[s.station.id] = Math.round(Math.min(10, rainIntensity + riseIntensity) * 100) / 100;
    }
    return { timestamp: formatNaiveIso(t), stations };
  });
}

export function buildEarthquakeStationDamage(stationAmpBinned: Record<string, number[]>, frameTimestamps: string[]): StationDamageFrame[] {
  return frameTimestamps.map((timestamp, i) => {
    const stations: Record<string, number> = {};
    for (const st of STATIONS) {
      const amp = stationAmpBinned[st.id][i] ?? 0;
      stations[st.id] = Math.round(Math.min(10, (amp / AMPLITUDE_MAX) * 10) * 100) / 100;
    }
    return { timestamp, stations };
  });
}
