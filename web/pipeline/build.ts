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

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

function writeJson(name: string, data: unknown) {
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data));
  console.log(`wrote ${name}`);
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

  const cases = [buildCloudburstCase(cb.detectionResult), buildEarthquakeCase(eq.detectionResult)].filter(Boolean);
  writeJson('cases.json', cases);
  console.log(`wrote ${cases.length} case(s)`);
}

main();
