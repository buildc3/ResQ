/**
 * Orchestrator: runs both scenarios end to end and writes exactly the JSON
 * files web/js/app.js fetches, straight into web/data/ — no intermediate
 * CSV/debug files, no Python, no separate sync step. This is what
 * `npm run build` executes for the Netlify deploy.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIONS, EARTHQUAKE_EPICENTER, SIM_END } from './stations.js';
import { runCloudburst } from './cloudburst.js';
import { runEarthquake } from './earthquake.js';
import { buildCloudburstCase, buildEarthquakeCase } from './cases.js';
import { buildCloudburstStationDamage, buildEarthquakeStationDamage, type StationDamageFrame } from './damage.js';
import { buildPhase2Plan, type RelayDeployment } from './phase2.js';
import { buildPhase3Plan } from './phase3.js';
import { GRID_CELLS, GRID_ROWS, GRID_COLS, GRID_LAT_MIN, GRID_LAT_MAX, GRID_LON_MIN, GRID_LON_MAX, LEAD_TIME_MINUTES } from './grid.js';
import { runConvection } from './convection.js';
import { runCIDetection } from './ciDetection.js';
import { buildHazardFrames, HAZARD_PARAMS } from './hazards.js';
import { buildFloodTTI, buildStormTTI } from './tti.js';
import { buildConvectiveCase } from './cases.js';
import { buildForecastFrames } from './forecast.js';
import { buildVerification } from './verification.js';

function relayDeployMap(relays: RelayDeployment[]): Record<string, string> {
  return Object.fromEntries(relays.map((r) => [r.station_id, r.deploy_at]));
}

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

function damageSnapshotAt(frames: StationDamageFrame[], iso: string) {
  const idx = frameIndexAtOrBefore(frames, iso);
  return frames[idx].stations;
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

  console.log('Building per-station damage/infrastructure severity (simulated CV pass)...');
  const cbDamage = buildCloudburstStationDamage(cb.series, cb.timesMs);
  const stationAmpBinned: Record<string, number[]> = {};
  for (const s of STATIONS) stationAmpBinned[s.id] = eq.frames.map((f) => f.stations[s.id].seismic_amplitude as number);
  const eqDamage = buildEarthquakeStationDamage(stationAmpBinned, eq.frames.map((f) => f.timestamp));
  writeJson('cloudburst_damage_stations.json', cbDamage);
  writeJson('earthquake_damage_stations.json', eqDamage);

  console.log('Building Phase 2 plans (relay deployment + search sweeps)...');
  console.log('Building Phase 3 plans (medical delivery + relief sorties)...');
  let cbCase = null;
  if (cb.detectionResult.triggered) {
    const cbPhase2 = buildPhase2Plan(cb.detectionResult.corridorStations ?? [], cb.detectionResult.detectedAt!, 101);
    const cbPhase3 = buildPhase3Plan(relayDeployMap(cbPhase2.relay_schedule), SIM_END, 201);
    cbCase = buildCloudburstCase(cb.detectionResult, cbPhase2, cbPhase3);
    if (cbCase) (cbCase.phase_1 as Record<string, unknown>).damage_by_station = damageSnapshotAt(cbDamage, cbCase.detected_at!);
  }
  let eqCase = null;
  if (eq.detectionResult.triggered) {
    const eqPhase2 = buildPhase2Plan(eq.detectionResult.confirmingStations ?? [], eq.detectionResult.detectedAt!, 102, EARTHQUAKE_EPICENTER);
    const eqPhase3 = buildPhase3Plan(relayDeployMap(eqPhase2.relay_schedule), SIM_END, 202);
    eqCase = buildEarthquakeCase(eq.detectionResult, eqPhase2, eqPhase3);
    if (eqCase) (eqCase.phase_1 as Record<string, unknown>).damage_by_station = damageSnapshotAt(eqDamage, eqCase.detected_at!);
  }

  const cases = [cbCase, eqCase].filter(Boolean);
  writeJson('cases.json', cases);
  console.log(`wrote ${cases.length} case(s)`);

  console.log('Generating SIMULATED convective nowcast scenario (SIH26084)...');
  writeJson('grid.json', {
    rows: GRID_ROWS,
    cols: GRID_COLS,
    bounds: { lat_min: GRID_LAT_MIN, lat_max: GRID_LAT_MAX, lon_min: GRID_LON_MIN, lon_max: GRID_LON_MAX },
    cells: GRID_CELLS,
    lead_time_minutes: LEAD_TIME_MINUTES,
  });

  const conv = runConvection();
  writeJson('convection_frames.json', conv.frames);
  writeJson('convection_lightning.json', conv.lightning);
  writeJson('convection_ground_truth.json', conv.groundTruth);
  console.log(`  storm initiation=${conv.groundTruth.initiation_at} maturity=${conv.groundTruth.maturity_at}`);

  const ci = runCIDetection(conv.cellSeries, conv.timesMs, conv.groundTruth);
  // Sparse export: only frames/cells with a non-trivial probability, same
  // "omit the clear/uninteresting majority" approach as convection_frames.json.
  const CI_EXPORT_THRESHOLD = 0.05;
  const ciFrames = conv.frames.map((frame, i) => {
    const cells = GRID_CELLS
      .map((c) => ({ cell_id: c.id, probability: ci.probabilityByCell[c.id][i] }))
      .filter((c) => c.probability >= CI_EXPORT_THRESHOLD)
      .map((c) => ({ cell_id: c.cell_id, probability: Math.round(c.probability * 1000) / 1000 }));
    return { timestamp: frame.timestamp, cells };
  }).filter((f) => f.cells.length > 0);
  writeJson('ci_probability_frames.json', ciFrames);
  console.log(`  CI triggered=${ci.result.triggered} detectedAt=${ci.result.detectedAt ?? '—'} leadMinutesBeforeMaturity=${ci.result.leadMinutesBeforeMaturity ?? '—'}`);

  const ciCase = buildConvectiveCase(ci.result, conv.groundTruth);
  writeJson('ci_case.json', ciCase);

  const hazardFrames = buildHazardFrames(conv.frames, conv.lightning);
  writeJson('hazard_frames.json', hazardFrames);
  writeJson('hazard_params.json', HAZARD_PARAMS);

  writeJson('tti_flood.json', buildFloodTTI());
  const stormTTI = buildStormTTI(conv.groundTruth);
  writeJson('tti_storm.json', stormTTI.tti);
  writeJson('alert_log.json', stormTTI.alerts);
  console.log(`  wrote ${stormTTI.alerts.length} alert log entrie(s)`);

  console.log('Building WP5 baseline nowcast (cell ID + centroid tracking + advection extrapolation)...');
  const forecastFrames = buildForecastFrames(conv.frames);
  writeJson('forecast_frames.json', forecastFrames);
  console.log(`  wrote ${forecastFrames.length} forecast (base, lead) pair(s)`);

  console.log('Scoring the baseline nowcast against simulated ground truth (WP8)...');
  const skill = buildVerification(forecastFrames, conv.frames);
  writeJson('verification.json', skill);
  const csiAt10 = skill.find((s) => s.lead_minutes === 10)?.csi ?? 0;
  const csiAt60 = skill.find((s) => s.lead_minutes === 60)?.csi ?? 0;
  const csiAt180 = skill.find((s) => s.lead_minutes === 180)?.csi ?? 0;
  console.log(`  CSI: T+10min=${csiAt10} T+60min=${csiAt60} T+180min=${csiAt180}`);
}

main();
