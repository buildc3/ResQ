/**
 * Earthquake scenario: synthetic mainshock + aftershock sequence generated
 * continuously at 1Hz (ambient noise plus superimposed event wavelets — see
 * data-pipeline/README.md for why continuous generation matters for a
 * correct STA/LTA detector), plus the STA/LTA multi-station detection model.
 * Ported from data-pipeline/generate_earthquake.py and detect_earthquake.py.
 */
import { SeededRng } from './rng.js';
import { STATIONS, EARTHQUAKE_EPICENTER, SIM_START, SIM_END } from './stations.js';
import { timeGridMs, formatNaiveIso, parseNaiveIso, haversineKm, dampedSineBurst, rollingMeanStd, sigmoid, sampleStd } from './mathUtils.js';
import type { FramePayload, ProbFramePayload } from './cloudburst.js';

const SEED = 7;
const ORIGIN_TIME = parseNaiveIso('2023-10-04T09:15:00');
const P_WAVE_KM_PER_S = 6.0;
const ATTENUATION_KM = 20.0;
const MAINSHOCK_AMPLITUDE = 1.0;
const MAINSHOCK_DURATION_S = 180;
const N_AFTERSHOCKS = 18;
const AFTERSHOCK_WINDOW_HOURS = 48.0;
const AMBIENT_NOISE_STD = 0.02;

const STA_SAMPLES = 10; // 10s at 1Hz — see data-pipeline/README.md #3 for why not 2s
const LTA_SAMPLES = 60; // 60s
const SIGMOID_K = 1.5;
const TRIGGER_PROB = 0.8;

// Adaptive per-station trigger ratio, instead of one hand-picked global
// value applied identically to every station. Calibrated from each
// station's own STA/LTA ratio during a stretch of the timeline guaranteed
// quiet for every station (hours before the mainshock, let alone any
// aftershock) — a station with a noisier ambient ratio needs a bigger jump
// to mean the same thing as a calmer one.
const CALIBRATION_END_SECONDS = 3 * 3600; // 3h of 1Hz samples, well before ORIGIN_TIME for every station
const ADAPT_SIGMA_MULT = 6.0; // threshold = quiet-period mean ratio + this many std-devs
const MIN_TRIGGER_RATIO = 2.0; // floor: an unrealistically calm calibration window shouldn't make a station oversensitive
const MIN_STATIONS = 2;
const CONFIRM_WINDOW_MS = 30 * 1000;
const FRAME_STEP_SECONDS = 10 * 60;

interface EventDef { timeMs: number; amplitude: number; durationS: number; kind: 'mainshock' | 'aftershock' }

function attenuated(baseAmplitude: number, distanceKm: number): number {
  return baseAmplitude / (1 + distanceKm / ATTENUATION_KM);
}

function buildEventCatalog(rng: SeededRng): EventDef[] {
  const events: EventDef[] = [{ timeMs: ORIGIN_TIME, amplitude: MAINSHOCK_AMPLITUDE, durationS: MAINSHOCK_DURATION_S, kind: 'mainshock' }];
  const u = Array.from({ length: N_AFTERSHOCKS }, () => rng.uniform(0.05, 1.0)).sort((a, b) => a - b);
  for (const ui of u) {
    const offsetHours = AFTERSHOCK_WINDOW_HOURS * ui ** 3; // Omori-like clustering: many soon after, tapering off
    const amp = Math.max(MAINSHOCK_AMPLITUDE * 0.5 * Math.exp(-offsetHours / 10) * rng.uniform(0.3, 1.0), 0.03);
    const durationS = Math.min(90, Math.max(20, Math.round(30 + 60 * (amp / MAINSHOCK_AMPLITUDE))));
    events.push({ timeMs: ORIGIN_TIME + offsetHours * 3600000, amplitude: amp, durationS, kind: 'aftershock' });
  }
  return events;
}

function buildStationAmplitude(stationId: string, distanceKm: number, timesMs: number[], events: EventDef[], rng: SeededRng): Float64Array {
  const n = timesMs.length;
  const startMs = timesMs[0];
  const amp = new Float64Array(n);
  for (let i = 0; i < n; i++) amp[i] = Math.abs(rng.normal(0, AMBIENT_NOISE_STD));

  for (const ev of events) {
    const lagMs = (distanceKm / P_WAVE_KM_PER_S) * 1000;
    const arrivalMs = ev.timeMs + lagMs;
    const ampAtStation = attenuated(ev.amplitude, distanceKm);
    const wave = dampedSineBurst(ev.durationS, 1.0, ampAtStation, rng.uniform(1.0, 2.5), 3.0 / ev.durationS, rng);
    const startPos = Math.ceil((arrivalMs - startMs) / 1000);
    for (let j = 0; j < wave.length; j++) {
      const pos = startPos + j;
      if (pos >= 0 && pos < n) amp[pos] += wave[j];
    }
  }
  return amp;
}

/** Max within each fixed-size bin. Amplitude and probability are always >=0 here, so a 0 floor is safe. */
function maxBin(values: Float64Array, binSize: number, numBins: number): number[] {
  const out = new Array<number>(numBins).fill(0);
  for (let b = 0; b < numBins; b++) {
    const start = b * binSize;
    const end = Math.min(values.length, start + binSize);
    let m = 0;
    for (let i = start; i < end; i++) if (values[i] > m) m = values[i];
    out[b] = m;
  }
  return out;
}

export interface DetectionResultEarthquake {
  scenario: 'earthquake';
  model: 'sta_lta_multistation';
  params: Record<string, unknown>;
  triggered: boolean;
  detectedAt?: string;
  confirmingStations?: string[];
  probabilityAtDetection?: number;
  peakProbability?: number;
  peakProbabilityAt?: string;
  peakProbabilityStation?: string;
  estimatedEpicenter?: { lat: number; lon: number };
}

export function runEarthquake() {
  const timesMs = timeGridMs(SIM_START, SIM_END, 1);
  const n = timesMs.length;
  const rng = new SeededRng(SEED);
  const events = buildEventCatalog(rng);

  const stationAmp: Record<string, Float64Array> = {};
  const stationProb: Record<string, Float64Array> = {};
  const stationDistance: Record<string, number> = {};
  const triggerRatioByStation: Record<string, number> = {};

  for (const s of STATIONS) {
    const distanceKm = haversineKm(s.lat, s.lon, EARTHQUAKE_EPICENTER.lat, EARTHQUAKE_EPICENTER.lon);
    stationDistance[s.id] = distanceKm;
    const amp = buildStationAmplitude(s.id, distanceKm, timesMs, events, rng);
    stationAmp[s.id] = amp;

    const { mean: sta } = rollingMeanStd(Array.from(amp), STA_SAMPLES, STA_SAMPLES);
    const { mean: lta } = rollingMeanStd(Array.from(amp), LTA_SAMPLES, LTA_SAMPLES);
    const ratio = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ratio[i] = Number.isNaN(sta[i]) || Number.isNaN(lta[i]) || lta[i] === 0 ? 0 : sta[i] / lta[i];
    }

    const calibStart = LTA_SAMPLES; // warm-up before the ratio is meaningful
    const calibEnd = Math.min(n, CALIBRATION_END_SECONDS);
    const quietRatios = Array.from(ratio.slice(calibStart, calibEnd));
    const quietMean = quietRatios.reduce((a, b) => a + b, 0) / quietRatios.length;
    const adaptiveThreshold = Math.max(MIN_TRIGGER_RATIO, quietMean + ADAPT_SIGMA_MULT * sampleStd(quietRatios));
    triggerRatioByStation[s.id] = Math.round(adaptiveThreshold * 1000) / 1000;

    const prob = new Float64Array(n);
    for (let i = 0; i < n; i++) prob[i] = sigmoid(ratio[i] - adaptiveThreshold, SIGMOID_K);
    stationProb[s.id] = prob;
  }

  // Confirmed trigger: >=MIN_STATIONS distinct stations crossing TRIGGER_PROB within CONFIRM_WINDOW_MS.
  const crossings: { t: number; sid: string }[] = [];
  for (const s of STATIONS) {
    const prob = stationProb[s.id];
    for (let i = 0; i < n; i++) if (prob[i] >= TRIGGER_PROB) crossings.push({ t: timesMs[i], sid: s.id });
  }
  crossings.sort((a, b) => a.t - b.t);

  let confirmed: { confirmTime: number; stations: string[] } | null = null;
  for (let i = 0; i < crossings.length; i++) {
    const windowEnd = crossings[i].t + CONFIRM_WINDOW_MS;
    const inWindow = crossings.slice(i).filter((e) => e.t <= windowEnd);
    const stationsInWindow = Array.from(new Set(inWindow.map((e) => e.sid)));
    if (stationsInWindow.length >= MIN_STATIONS) {
      const confirmTime = Math.max(...inWindow.filter((e) => stationsInWindow.includes(e.sid)).map((e) => e.t));
      confirmed = { confirmTime, stations: stationsInWindow.sort() };
      break;
    }
  }

  const numFrames = Math.floor((timesMs[n - 1] - timesMs[0]) / (FRAME_STEP_SECONDS * 1000)) + 1;
  const frameStartMs = timesMs[0];

  const frames: FramePayload[] = Array.from({ length: numFrames }, (_, k) => ({
    timestamp: formatNaiveIso(frameStartMs + k * FRAME_STEP_SECONDS * 1000),
    stations: {},
  }));
  const stationProbFrames: ProbFramePayload[] = Array.from({ length: numFrames }, (_, k) => ({
    timestamp: formatNaiveIso(frameStartMs + k * FRAME_STEP_SECONDS * 1000),
    stations: {},
  }));

  let peak = { p: -1, station: '', t: 0 };
  for (const s of STATIONS) {
    const binned = maxBin(stationAmp[s.id], FRAME_STEP_SECONDS, numFrames);
    const probBinned = maxBin(stationProb[s.id], FRAME_STEP_SECONDS, numFrames);
    for (let k = 0; k < numFrames; k++) {
      frames[k].stations[s.id] = { seismic_amplitude: Math.round(binned[k] * 100000) / 100000 };
      stationProbFrames[k].stations[s.id] = Math.round(probBinned[k] * 10000) / 10000;
    }
    for (let i = 0; i < n; i++) if (stationProb[s.id][i] > peak.p) peak = { p: stationProb[s.id][i], station: s.id, t: timesMs[i] };
  }

  const regionalProbability = Array.from({ length: numFrames }, (_, k) => {
    let max = 0;
    for (const s of STATIONS) max = Math.max(max, stationProbFrames[k].stations[s.id] as number);
    return { timestamp: frames[k].timestamp, probability: max };
  });

  const params = {
    sta_samples: STA_SAMPLES,
    lta_samples: LTA_SAMPLES,
    sigmoid_k: SIGMOID_K,
    trigger_probability: TRIGGER_PROB,
    min_confirming_stations: MIN_STATIONS,
    confirm_window_seconds: CONFIRM_WINDOW_MS / 1000,
    adapt_sigma_multiplier: ADAPT_SIGMA_MULT,
    calibration_window_seconds: CALIBRATION_END_SECONDS,
    min_trigger_ratio: MIN_TRIGGER_RATIO,
    adaptive_trigger_ratio_by_station: triggerRatioByStation,
  };

  const result: DetectionResultEarthquake = { scenario: 'earthquake', model: 'sta_lta_multistation', params, triggered: confirmed !== null };

  if (confirmed) {
    const atConfirmIdx = timesMs.indexOf(confirmed.confirmTime);
    let probAtDetection = 0;
    for (const sid of confirmed.stations) probAtDetection = Math.max(probAtDetection, stationProb[sid][atConfirmIdx]);

    const weights: Record<string, number> = {};
    let weightSum = 0;
    for (const sid of confirmed.stations) {
      let m = 0;
      for (let i = 0; i < n; i++) m = Math.max(m, stationProb[sid][i]);
      weights[sid] = m;
      weightSum += m;
    }
    let latEst = 0;
    let lonEst = 0;
    for (const sid of confirmed.stations) {
      const st = STATIONS.find((s) => s.id === sid)!;
      latEst += (weights[sid] / weightSum) * st.lat;
      lonEst += (weights[sid] / weightSum) * st.lon;
    }

    result.detectedAt = formatNaiveIso(confirmed.confirmTime);
    result.confirmingStations = confirmed.stations;
    result.probabilityAtDetection = Math.round(probAtDetection * 10000) / 10000;
    result.peakProbability = Math.round(peak.p * 10000) / 10000;
    result.peakProbabilityAt = formatNaiveIso(peak.t);
    result.peakProbabilityStation = peak.station;
    result.estimatedEpicenter = { lat: Math.round(latEst * 10000) / 10000, lon: Math.round(lonEst * 10000) / 10000 };
  }

  return { frames, stationProbFrames, regionalProbability, detectionResult: result, stationAmp, stationDistance, timesMs };
}
