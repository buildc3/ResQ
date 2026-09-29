/**
 * SIMULATED convective storm generator (SIH26084 Scenario 1) — a single
 * seeded thunderstorm/cloudburst lifecycle over the upper Teesta catchment,
 * timed to retell 2023-10-03/04 with a storm that *precedes* the existing
 * cloudburst.ts rainfall peak (RAIN_PEAK_TIME, 2023-10-03T21:00:00) rather
 * than duplicating it. This is the upstream cause; the existing GLOF flood
 * wave (cloudburst.ts) is the downstream consequence — both real facts about
 * the same event, two different stages of it.
 *
 * Nothing here is observed data. Every field is generated from simple,
 * documented envelope/falloff functions, not real radar/satellite/lightning —
 * see README "What's real, what's simulated" before treating any of it as
 * observation.
 */
import { SeededRng } from './rng.js';
import { GRID_CELLS, type GridCell } from './grid.js';
import { timeGridMs, formatNaiveIso, parseNaiveIso, haversineKm, riseAndRecede, gaussianBump } from './mathUtils.js';
import { SIM_START, SIM_END } from './stations.js';

const STEP_MINUTES = 10;
const SEED = 303;

// Maturity = first time the core reaches this reflectivity, OR first
// lightning flash — whichever comes first (matches the SIH26084 requirement
// to prove CI detection fires before this point).
export const MATURITY_REFLECTIVITY_DBZ = 40;
const MATURITY_TIME = parseNaiveIso('2023-10-03T20:45:00');

// Precursor signals lead maturity by roughly 90-135 minutes — this gap is
// exactly what WP4's convective-initiation detector exists to catch.
const CONVERGENCE_ONSET = MATURITY_TIME - 135 * 60000;
const CONVERGENCE_PEAK_TIME = MATURITY_TIME - 90 * 60000;
const COOLING_ONSET = MATURITY_TIME - 120 * 60000;
const COOLING_PEAK_TIME = MATURITY_TIME - 15 * 60000;
const REFLECTIVITY_ONSET = MATURITY_TIME - 75 * 60000;
const REFLECTIVITY_PEAK_TIME = MATURITY_TIME + 30 * 60000; // near cloudburst.ts's own RAIN_PEAK_TIME (21:00)
const FIRST_LIGHTNING_TARGET = MATURITY_TIME - 15 * 60000; // reflectivity crosses the ice-phase-plausible threshold here
const DECAY_TAU_HOURS = 1.2;

const CONVERGENCE_PEAK_MS = 12; // m/s, proxy magnitude — not a calibrated real value
const COOLING_PEAK_K = 62; // brightness-temp drop at coldest point
const IR_BASELINE_K = 270;
const REFLECTIVITY_PEAK_DBZ = 58; // clears the ~100mm/hr cloudburst rain-rate threshold (hazards.ts) with real margin, not a borderline crossing
const LIGHTNING_ICE_THRESHOLD_DBZ = 35; // flashes only spawn once the core plausibly has ice aloft

// Storm motion: starts in the upper catchment (between Lachen and Chungthang,
// the same UPPER_CATCHMENT stations cloudburst.ts already uses for its
// heaviest rain), advects due south along the valley toward the downstream
// towns — same direction the flood wave later takes.
const INITIATION_LAT = 27.65;
const INITIATION_LON = 88.60;
const HEADING_DEG = 180; // compass bearing, 0=north
const STEERING_SPEED_KMH = 15;

function centroidAtHours(tHours: number): { lat: number; lon: number } {
  const initHours = (MATURITY_TIME - parseNaiveIso(SIM_START)) / 3600000 - 0.75; // storm "exists" from ~75min before maturity for motion purposes
  const dtH = Math.max(0, tHours - initHours);
  const distKm = STEERING_SPEED_KMH * dtH;
  const headingRad = (HEADING_DEG * Math.PI) / 180;
  const dLat = (distKm * Math.cos(headingRad)) / 111;
  const dLon = (distKm * Math.sin(headingRad)) / (111 * Math.cos((INITIATION_LAT * Math.PI) / 180));
  return { lat: INITIATION_LAT + dLat, lon: INITIATION_LON + dLon };
}

export interface LightningFlash { lat: number; lon: number; time: string }
export interface ConvectionFrame {
  timestamp: string;
  // Sparse: only cells with a non-negligible value are listed — everywhere
  // else is implicitly clear/background. Keeps a static-site JSON export a
  // reasonable size instead of a dense 720-frame x full-grid array.
  cells: { cell_id: string; reflectivity_dbz: number; convergence_ms: number; ir_brightness_k: number }[];
}
export interface ConvectionGroundTruth {
  initiation_at: string;
  maturity_at: string;
  maturity_reflectivity_dbz: number;
  first_lightning_at: string | null;
  steering_vector: { speed_kmh: number; heading_deg: number };
  track: { time: string; centroid_lat: number; centroid_lon: number; radius_km: number }[];
}

export function runConvection() {
  const timesMs = timeGridMs(SIM_START, SIM_END, STEP_MINUTES * 60);
  const startMs = timesMs[0];
  const rng = new SeededRng(SEED);

  const frames: ConvectionFrame[] = [];
  const lightning: LightningFlash[] = [];
  const track: ConvectionGroundTruth['track'] = [];
  let firstLightningAt: string | null = null;

  // Per-cell continuous series (needed by ciFeatures/ciDetection for rolling
  // calibration) — kept in memory only, not exported wholesale.
  const cellSeries: Record<string, { convergence: number[]; ir: number[]; reflectivity: number[] }> = {};
  for (const c of GRID_CELLS) cellSeries[c.id] = { convergence: [], ir: [], reflectivity: [] };

  for (let i = 0; i < timesMs.length; i++) {
    const t = timesMs[i];
    const tHours = (t - startMs) / 3600000;

    // Every field is a smooth, continuous function of time (gaussianBump /
    // riseAndRecede both decay toward zero far from their center/onset
    // rather than being hard-gated) — deliberately no on/off "active"
    // switch here. An artificial step boundary would itself look like a
    // sudden anomaly to the rolling z-score detector and get mistaken for
    // the real precursor signal, which defeats the point of this scenario.
    const convergenceEnv = gaussianBump(t, CONVERGENCE_PEAK_TIME, 0.6 * 3600000, CONVERGENCE_PEAK_MS);
    const coolingEnv = riseAndRecede(tHours, (COOLING_ONSET - startMs) / 3600000, (COOLING_PEAK_TIME - COOLING_ONSET) / 3600000, COOLING_PEAK_K, DECAY_TAU_HOURS);
    const reflectivityEnv = riseAndRecede(tHours, (REFLECTIVITY_ONSET - startMs) / 3600000, (REFLECTIVITY_PEAK_TIME - REFLECTIVITY_ONSET) / 3600000, REFLECTIVITY_PEAK_DBZ, DECAY_TAU_HOURS);

    const centroid = centroidAtHours(tHours);
    // Each field's areal footprint scales with its own current intensity
    // fraction of peak — a weak/forming storm is a small patch, a mature one
    // is a wide cell, matching real convective cores growing then shrinking.
    const convergenceRadiusKm = 4 + 8 * Math.min(1, convergenceEnv / CONVERGENCE_PEAK_MS);
    const coolingRadiusKm = 5 + 10 * Math.min(1, coolingEnv / COOLING_PEAK_K); // cloud shield is broader than the precip core
    const reflectivityRadiusKm = 3 + 9 * Math.min(1, reflectivityEnv / REFLECTIVITY_PEAK_DBZ);
    const hasSignal = convergenceEnv > 0.01 || coolingEnv > 0.1 || reflectivityEnv > 0.1;

    const cellsOut: ConvectionFrame['cells'] = [];
    for (const c of GRID_CELLS) {
      const distKm = hasSignal ? haversineKm(c.lat, c.lon, centroid.lat, centroid.lon) : Infinity;
      const convergence = convergenceEnv * Math.exp(-(distKm ** 2) / (2 * convergenceRadiusKm ** 2));
      const cooling = coolingEnv * Math.exp(-(distKm ** 2) / (2 * coolingRadiusKm ** 2));
      const reflectivity = reflectivityEnv * Math.exp(-(distKm ** 2) / (2 * reflectivityRadiusKm ** 2));
      const ir = IR_BASELINE_K - cooling + rng.normal(0, 0.4);
      const reflNoisy = Math.max(0, reflectivity + rng.normal(0, 0.5));
      const convNoisy = Math.max(0, convergence + rng.normal(0, 0.15));

      cellSeries[c.id].convergence.push(convNoisy);
      cellSeries[c.id].ir.push(ir);
      cellSeries[c.id].reflectivity.push(reflNoisy);

      // Thresholds well above the noise floor (reflectivity/convergence
      // noise std is 0.5/0.15) so a pure-noise blip on a genuinely clear
      // cell essentially never crosses them by chance — without this, a
      // small fraction of the ~1500 cells cross a looser threshold on noise
      // alone every frame, cluttering the export with "signal" a full day
      // before the storm even begins.
      if (reflNoisy > 3 || convNoisy > 1 || cooling > 2) {
        cellsOut.push({ cell_id: c.id, reflectivity_dbz: Math.round(reflNoisy * 10) / 10, convergence_ms: Math.round(convNoisy * 100) / 100, ir_brightness_k: Math.round(ir * 10) / 10 });
      }

      // Lightning: expected flash rate ramps with how far reflectivity is
      // past the ice-phase-plausible threshold, only within the core.
      if (reflNoisy > LIGHTNING_ICE_THRESHOLD_DBZ && distKm < reflectivityRadiusKm) {
        const expectedRate = ((reflNoisy - LIGHTNING_ICE_THRESHOLD_DBZ) / 20) * 0.15; // flashes per cell per 10-min frame, order-of-magnitude only
        if (rng.next() < expectedRate) {
          const flashTime = formatNaiveIso(t + rng.next() * STEP_MINUTES * 60000);
          lightning.push({ lat: c.lat + rng.uniform(-0.003, 0.003), lon: c.lon + rng.uniform(-0.003, 0.003), time: flashTime });
          if (!firstLightningAt || flashTime < firstLightningAt) firstLightningAt = flashTime;
        }
      }
    }

    frames.push({ timestamp: formatNaiveIso(t), cells: cellsOut });
    if (hasSignal) track.push({ time: formatNaiveIso(t), centroid_lat: Math.round(centroid.lat * 10000) / 10000, centroid_lon: Math.round(centroid.lon * 10000) / 10000, radius_km: Math.round(reflectivityRadiusKm * 10) / 10 });
  }

  lightning.sort((a, b) => a.time.localeCompare(b.time));

  const groundTruth: ConvectionGroundTruth = {
    initiation_at: formatNaiveIso(CONVERGENCE_ONSET),
    maturity_at: formatNaiveIso(MATURITY_TIME),
    maturity_reflectivity_dbz: MATURITY_REFLECTIVITY_DBZ,
    first_lightning_at: firstLightningAt,
    steering_vector: { speed_kmh: STEERING_SPEED_KMH, heading_deg: HEADING_DEG },
    track,
  };

  return { timesMs, frames, lightning, groundTruth, cellSeries };
}
