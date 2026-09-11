/**
 * Cloudburst / GLOF scenario: synthetic sensor generation + rolling z-score
 * fusion detection, ported from data-pipeline/generate_cloudburst.py and
 * detect_cloudburst.py. Generation and detection run on the same in-memory
 * per-station arrays (no CSV round-trip, unlike the Python version, which
 * had to reload from disk between scripts).
 */
import { SeededRng } from './rng.js';
import { STATIONS, SIM_START, SIM_END, type Station } from './stations.js';
import { timeGridMs, formatNaiveIso, parseNaiveIso, gaussianBump, riseAndRecede, rollingZ, sigmoid, sampleStd } from './mathUtils.js';

const STEP_MINUTES = 10;
const SEED = 42;

const LAKE_BREACH_ONSET = parseNaiveIso('2023-10-04T01:30:00');
const WAVE_SPEED_KM_PER_H = 15.0;
const WATER_LEVEL_DECAY_KM = 45.0;

const RAIN_PEAK_TIME = parseNaiveIso('2023-10-03T21:00:00');
const RAIN_WIDTH_HOURS = 5.0;
const UPPER_CATCHMENT = new Set(['lachen', 'chungthang', 'mangan']);

const TREMOR_CENTER = parseNaiveIso('2023-10-04T01:35:00');
const TREMOR_WIDTH_HOURS = 0.15;

const BASELINE_WINDOW = 144; // 24h at 10-min resolution
const MIN_PERIODS = 12; // 2h
const SIGMOID_K = 0.8;
const TRIGGER_PROB = 0.8;

// Adaptive per-station sigmoid midpoint, instead of one hand-picked global
// value applied identically to every station regardless of how noisy that
// station's own baseline actually is. Calibrated from each station's own
// composite z-score during a stretch of the timeline guaranteed quiet for
// every station (well before the earliest rain/tremor/water-level event
// onset for any of them) — a station with a jitterier natural baseline
// needs a larger anomaly to mean the same thing as a calmer one.
const CALIBRATION_END_IDX = 180; // ~30h — before any injected event affects any station
const ADAPT_SIGMA_MULT = 3.0; // midpoint = this many quiet-period std-devs above zero
const MIN_SIGMOID_MIDPOINT = 1.2; // floor: an unrealistically silent calibration window shouldn't make a station oversensitive
const CONFIRM_SAMPLES = 3; // 30 minutes sustained
const WEIGHTS_WITH_LEVEL = { rainfall: 0.3, waterLevelRate: 0.5, tremor: 0.2 };
const WEIGHTS_NO_LEVEL = { rainfall: 0.6, tremor: 0.4 };
const MIN_STD = { rainfall: 1.5, waterLevelRate: 0.05, tremor: 0.01 };

export interface StationSeries {
  station: Station;
  rainfall: number[];
  waterLevel: (number | null)[];
  groundTremor: number[];
}

function onsetTimeMs(basinKm: number): number {
  return LAKE_BREACH_ONSET + (basinKm / WAVE_SPEED_KM_PER_H) * 3600000;
}
function peakRiseM(basinKm: number): number {
  return 8.0 * Math.exp(-basinKm / WATER_LEVEL_DECAY_KM);
}

function buildStationSeries(station: Station, timesMs: number[], rng: SeededRng): StationSeries {
  const n = timesMs.length;
  const startMs = timesMs[0];
  const tHours = timesMs.map((t) => (t - startMs) / 3600000);
  const rainCenterHours = (RAIN_PEAK_TIME - startMs) / 3600000;

  const rainPeak = UPPER_CATCHMENT.has(station.id) ? rng.uniform(70, 90) : rng.uniform(15, 30);
  const rainfall = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const baseline = Math.min(8, rng.exponential(1.2));
    const event = gaussianBump(tHours[i], rainCenterHours, RAIN_WIDTH_HOURS, rainPeak);
    rainfall[i] = Math.max(0, baseline + event);
  }

  let waterLevel: (number | null)[];
  if (station.hasWaterLevel) {
    const basinKm = station.basinKm as number;
    const onsetHours = (onsetTimeMs(basinKm) - startMs) / 3600000;
    const riseHours = 0.5 + basinKm / 100;
    const decayTauHours = 12 + basinKm / 10;
    const baselineLevel = station.waterBody === 'South Lhonak Lake' ? 3.0 : 2.0;
    waterLevel = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const noise = rng.normal(0, 0.03);
      const surge = riseAndRecede(tHours[i], onsetHours, riseHours, peakRiseM(basinKm), decayTauHours);
      waterLevel[i] = baselineLevel + noise + surge;
    }
  } else {
    waterLevel = new Array(n).fill(null);
  }

  // Soil moisture isn't consumed by the UI or the detector — generation is
  // skipped here (the Python version computed it purely for the frames.json
  // export, which the frontend never reads either).

  const tremorCenterHours = (TREMOR_CENTER - startMs) / 3600000;
  const groundTremor = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let t = Math.abs(rng.normal(0, 0.02));
    if (station.id === 'lachen') t += gaussianBump(tHours[i], tremorCenterHours, TREMOR_WIDTH_HOURS, 0.95);
    else if (station.id === 'chungthang') t += gaussianBump(tHours[i], tremorCenterHours + 0.75, TREMOR_WIDTH_HOURS * 2, 0.35);
    else if (station.id === 'mangan') t += gaussianBump(tHours[i], tremorCenterHours + 2.1, TREMOR_WIDTH_HOURS * 2, 0.12);
    groundTremor[i] = Math.min(1, Math.max(0, t));
  }

  return { station, rainfall, waterLevel, groundTremor };
}

function adaptiveMidpoint(composite: number[]): number {
  const quiet = composite.slice(MIN_PERIODS, CALIBRATION_END_IDX);
  return Math.max(MIN_SIGMOID_MIDPOINT, ADAPT_SIGMA_MULT * sampleStd(quiet));
}

function stationProbability(s: StationSeries): { probability: number[]; sigmoidMidpoint: number } {
  const zRain = rollingZ(s.rainfall, BASELINE_WINDOW, MIN_PERIODS, MIN_STD.rainfall).map((v) => Math.max(0, v));
  const zTremor = rollingZ(s.groundTremor, BASELINE_WINDOW, MIN_PERIODS, MIN_STD.tremor).map((v) => Math.max(0, v));

  let composite: number[];
  if (s.station.hasWaterLevel) {
    const rateOfRise = s.waterLevel.map((v, i) => {
      if (i === 0 || v === null || s.waterLevel[i - 1] === null) return 0;
      return ((v as number) - (s.waterLevel[i - 1] as number)) / (10 / 60);
    });
    const zLevel = rollingZ(rateOfRise, BASELINE_WINDOW, MIN_PERIODS, MIN_STD.waterLevelRate).map((v) => Math.max(0, v));
    composite = zRain.map((z, i) => WEIGHTS_WITH_LEVEL.rainfall * z + WEIGHTS_WITH_LEVEL.waterLevelRate * zLevel[i] + WEIGHTS_WITH_LEVEL.tremor * zTremor[i]);
  } else {
    composite = zRain.map((z, i) => WEIGHTS_NO_LEVEL.rainfall * z + WEIGHTS_NO_LEVEL.tremor * zTremor[i]);
  }
  const midpoint = adaptiveMidpoint(composite);
  return { probability: composite.map((z) => sigmoid(z - midpoint, SIGMOID_K)), sigmoidMidpoint: midpoint };
}

export interface DetectionResultCloudburst {
  scenario: 'cloudburst_glof';
  model: 'rolling_zscore_fusion';
  params: Record<string, unknown>;
  triggered: boolean;
  detectedAt?: string;
  primaryStation?: string;
  probabilityAtDetection?: number;
  peakProbability?: number;
  peakProbabilityAt?: string;
  contributingStations?: string[];
  corridorStations?: string[];
  offCorridorStations?: string[];
}

export interface FramePayload {
  timestamp: string;
  stations: Record<string, Record<string, number | null>>;
}
export interface ProbFramePayload {
  timestamp: string;
  stations: Record<string, number | null>;
}

export function runCloudburst() {
  const timesMs = timeGridMs(SIM_START, SIM_END, STEP_MINUTES * 60);
  const rng = new SeededRng(SEED);
  const series = STATIONS.map((s) => buildStationSeries(s, timesMs, rng));
  const probByStation: Record<string, number[]> = {};
  const midpointByStation: Record<string, number> = {};
  for (const s of series) {
    const { probability, sigmoidMidpoint } = stationProbability(s);
    probByStation[s.station.id] = probability;
    midpointByStation[s.station.id] = Math.round(sigmoidMidpoint * 1000) / 1000;
  }

  const frames: FramePayload[] = timesMs.map((t, i) => {
    const stationsPayload: Record<string, Record<string, number | null>> = {};
    for (const s of series) {
      stationsPayload[s.station.id] = {
        rainfall_mm_hr: Math.round(s.rainfall[i] * 100) / 100,
        water_level_m: s.waterLevel[i] === null ? null : Math.round((s.waterLevel[i] as number) * 1000) / 1000,
        ground_tremor_index: Math.round(s.groundTremor[i] * 10000) / 10000,
      };
    }
    return { timestamp: formatNaiveIso(t), stations: stationsPayload };
  });

  const stationProbFrames: ProbFramePayload[] = timesMs.map((t, i) => {
    const stationsPayload: Record<string, number | null> = {};
    for (const s of series) stationsPayload[s.station.id] = Math.round(probByStation[s.station.id][i] * 10000) / 10000;
    return { timestamp: formatNaiveIso(t), stations: stationsPayload };
  });

  const regionalProbability = timesMs.map((t, i) => {
    let max = -Infinity;
    let topStation = '';
    for (const s of series) {
      const p = probByStation[s.station.id][i];
      if (p > max) { max = p; topStation = s.station.id; }
    }
    return { timestamp: formatNaiveIso(t), probability: Math.round(max * 10000) / 10000, topStation };
  });

  // Trigger: regional probability sustained >= TRIGGER_PROB for CONFIRM_SAMPLES consecutive frames.
  let triggerIdx = -1;
  let run = 0;
  for (let i = 0; i < regionalProbability.length; i++) {
    run = regionalProbability[i].probability >= TRIGGER_PROB ? run + 1 : 0;
    if (run >= CONFIRM_SAMPLES) { triggerIdx = i - CONFIRM_SAMPLES + 1; break; }
  }

  const params = {
    baseline_window_samples: BASELINE_WINDOW,
    min_periods: MIN_PERIODS,
    sigmoid_k: SIGMOID_K,
    trigger_probability: TRIGGER_PROB,
    confirm_samples: CONFIRM_SAMPLES,
    weights_with_water_level: WEIGHTS_WITH_LEVEL,
    weights_without_water_level: WEIGHTS_NO_LEVEL,
    adapt_sigma_multiplier: ADAPT_SIGMA_MULT,
    calibration_window_samples: CALIBRATION_END_IDX,
    min_sigmoid_midpoint: MIN_SIGMOID_MIDPOINT,
    adaptive_sigmoid_midpoint_by_station: midpointByStation,
  };

  const result: DetectionResultCloudburst = { scenario: 'cloudburst_glof', model: 'rolling_zscore_fusion', params, triggered: triggerIdx >= 0 };

  if (triggerIdx >= 0) {
    const atTrigger = series.map((s) => ({ id: s.station.id, p: probByStation[s.station.id][triggerIdx] }));
    const primary = atTrigger.reduce((a, b) => (b.p > a.p ? b : a));
    let peakIdx = 0;
    for (let i = 1; i < regionalProbability.length; i++) if (regionalProbability[i].probability > regionalProbability[peakIdx].probability) peakIdx = i;

    const everCrossed = STATIONS.filter((s) => probByStation[s.id].some((p) => p >= TRIGGER_PROB)).map((s) => s.id);
    const corridor = everCrossed
      .filter((id) => STATION_HAS_LEVEL(id))
      .sort((a, b) => (STATION_LOOKUP_BASIN(a) as number) - (STATION_LOOKUP_BASIN(b) as number));
    const offCorridor = everCrossed.filter((id) => !STATION_HAS_LEVEL(id)).sort();

    result.detectedAt = regionalProbability[triggerIdx].timestamp;
    result.primaryStation = primary.id;
    result.probabilityAtDetection = Math.round(primary.p * 10000) / 10000;
    result.contributingStations = everCrossed;
    result.corridorStations = corridor;
    result.offCorridorStations = offCorridor;
    result.peakProbability = regionalProbability[peakIdx].probability;
    result.peakProbabilityAt = regionalProbability[peakIdx].timestamp;
  }

  return {
    frames,
    stationProbFrames,
    regionalProbability: regionalProbability.map(({ timestamp, probability }) => ({ timestamp, probability })),
    detectionResult: result,
    series,
    timesMs,
  };
}

function STATION_HAS_LEVEL(id: string): boolean {
  return STATIONS.find((s) => s.id === id)!.hasWaterLevel;
}
function STATION_LOOKUP_BASIN(id: string): number | null {
  return STATIONS.find((s) => s.id === id)!.basinKm;
}
