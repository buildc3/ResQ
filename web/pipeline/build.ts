/**
 * Orchestrator: runs both scenarios end to end and writes exactly the JSON
 * files web/js/app.js fetches, straight into web/data/ — no intermediate
 * CSV/debug files, no Python, no separate sync step. This is what
 * `npm run build` executes for the Netlify deploy.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIONS, EARTHQUAKE_EPICENTER } from './stations.js';
import { runCloudburst } from './cloudburst.js';
import { runEarthquake } from './earthquake.js';
import { buildCloudburstCase, buildEarthquakeCase } from './cases.js';
import { buildCloudburstDamageGrid, buildEarthquakeDamageGrid, type DamageGridPayload } from './damageGrid.js';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

function writeJson(name: string, data: unknown) {
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data));
  console.log(`wrote ${name}`);
}

/** Last frame index at or before a given ISO timestamp (frames are 10-min; a
 *  detection can land mid-frame, e.g. the earthquake's second-level timestamp). */
function frameIndexAtOrBefore(frames: { timestamp: string }[], iso: string): number {
  let lo = 0;
  let hi = frames.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timestamp <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function damageSnapshotAt(grid: DamageGridPayload, iso: string) {
  const idx = frameIndexAtOrBefore(grid.frames, iso);
  return { cells: grid.cells, values: grid.frames[idx].values };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const stationsJson = {
    stations: STATIONS.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      basin_km: s.basinKm,
      role: s.role,
      has_water_level: s.hasWaterLevel,
      water_body: s.waterBody,
    })),
    earthquake_epicenter: EARTHQUAKE_EPICENTER,
  };
  writeJson('stations.json', stationsJson);

  console.log('Generating + detecting cloudburst scenario...');
  const cb = runCloudburst();
  writeJson('cloudburst_frames.json', cb.frames);
  writeJson('cloudburst_regional_probability.json', cb.regionalProbability);
  writeJson('cloudburst_station_probability_frames.json', cb.stationProbFrames);
  console.log(`  triggered=${cb.detectionResult.triggered} detectedAt=${cb.detectionResult.detectedAt ?? '—'}`);

  console.log('Generating + detecting earthquake scenario (1Hz x 5 days x 7 stations)...');
  const eq = runEarthquake();
  writeJson('earthquake_frames.json', eq.frames);
  writeJson('earthquake_regional_probability.json', eq.regionalProbability);
  writeJson('earthquake_station_probability_frames.json', eq.stationProbFrames);
  console.log(`  triggered=${eq.detectionResult.triggered} detectedAt=${eq.detectionResult.detectedAt ?? '—'}`);

  console.log('Building damage/infrastructure severity heat maps...');
  const cbDamage = buildCloudburstDamageGrid(cb.series, cb.timesMs);
  const stationAmpBinned: Record<string, number[]> = {};
  for (const s of STATIONS) stationAmpBinned[s.id] = eq.frames.map((f) => f.stations[s.id].seismic_amplitude as number);
  const eqDamage = buildEarthquakeDamageGrid(stationAmpBinned, eq.frames.map((f) => f.timestamp));
  writeJson('cloudburst_damage_grid.json', cbDamage);
  writeJson('earthquake_damage_grid.json', eqDamage);

  const cbCase = buildCloudburstCase(cb.detectionResult);
  if (cbCase) (cbCase.phase_1 as Record<string, unknown>).damage_grid = damageSnapshotAt(cbDamage, cbCase.detected_at!);
  const eqCase = buildEarthquakeCase(eq.detectionResult);
  if (eqCase) (eqCase.phase_1 as Record<string, unknown>).damage_grid = damageSnapshotAt(eqDamage, eqCase.detected_at!);

  const cases = [cbCase, eqCase].filter(Boolean);
  writeJson('cases.json', cases);
  console.log(`wrote ${cases.length} case(s)`);
}

main();
