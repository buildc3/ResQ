/**
 * Sensor station registry — ported from data-pipeline/stations.py.
 * Coordinates are approximate (illustrative, not survey-grade) placements of
 * real Sikkim settlements along the Teesta / North Sikkim corridor. basin_km
 * is the along-river distance downstream from South Lhonak Lake, used by the
 * cloudburst/GLOF generator for flood-wave propagation lag. Stations with
 * hasWaterLevel=false sit off the Teesta flood path and act as rainfall/
 * seismic reference points only.
 */

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  basinKm: number | null;
  role: string;
  hasWaterLevel: boolean;
  waterBody: string | null;
}

export const STATIONS: Station[] = [
  { id: 'lachen', name: 'Lachen', lat: 27.7167, lon: 88.5567, basinKm: 0, role: 'upstream_catchment', hasWaterLevel: true, waterBody: 'South Lhonak Lake' },
  { id: 'chungthang', name: 'Chungthang', lat: 27.6167, lon: 88.65, basinKm: 18, role: 'dam_site', hasWaterLevel: true, waterBody: 'Teesta River' },
  { id: 'mangan', name: 'Mangan', lat: 27.5167, lon: 88.5333, basinKm: 32, role: 'district_hq', hasWaterLevel: true, waterBody: 'Teesta River' },
  { id: 'dikchu', name: 'Dikchu', lat: 27.3833, lon: 88.6167, basinKm: 55, role: 'midstream', hasWaterLevel: true, waterBody: 'Teesta River' },
  { id: 'singtam', name: 'Singtam', lat: 27.2333, lon: 88.4833, basinKm: 70, role: 'downstream', hasWaterLevel: true, waterBody: 'Teesta River' },
  { id: 'gangtok', name: 'Gangtok', lat: 27.3389, lon: 88.6065, basinKm: null, role: 'reference', hasWaterLevel: false, waterBody: null },
  { id: 'gyalshing', name: 'Gyalshing', lat: 27.2833, lon: 88.2667, basinKm: null, role: 'reference', hasWaterLevel: false, waterBody: null },
];

export const STATION_LOOKUP: Record<string, Station> = Object.fromEntries(STATIONS.map((s) => [s.id, s]));

// Synthetic epicenter for the earthquake scenario — not tied to a real recorded event.
export const EARTHQUAKE_EPICENTER = { lat: 27.55, lon: 88.55, label: 'North Sikkim fault zone (synthetic)' };

export const SIM_START = '2023-10-02T00:00:00';
export const SIM_END = '2023-10-06T23:50:00';
