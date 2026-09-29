/**
 * Convective-initiation (CI) detection — the SIH26084 differentiator.
 *
 * Reuses exactly the pattern already proven in cloudburst.ts (rolling
 * z-score -> adaptive per-entity threshold -> sigmoid -> sustained trigger)
 * and earthquake.ts (multi-entity confirmation within a matching window),
 * just applied per grid cell instead of per station, with "multiple stations
 * agree" replaced by "a small cluster of neighboring cells agree" — the
 * spatial equivalent of the same idea.
 *
 * This is what fixes the known gap in the existing system: cloudburst.ts's
 * rolling_zscore_fusion only fires on the flood wave, hours after the real
 * rain peak. CI detection instead watches the precursor signals (cloud-top
 * cooling + low-level convergence) and must fire before the storm's own
 * ground-truth maturity time.
 */
import { GRID_CELLS, neighborsOf } from './grid.js';
import { rollingZ, sigmoid, sampleStd, formatNaiveIso, parseNaiveIso } from './mathUtils.js';
import { coolingRateSeries } from './ciFeatures.js';
import type { ConvectionGroundTruth } from './convection.js';

const BASELINE_WINDOW = 144; // 24h at 10-min resolution — same as cloudburst.ts
const MIN_PERIODS = 12;
const SIGMOID_K = 0.8;
const TRIGGER_PROB = 0.8;
const CONFIRM_SAMPLES = 2; // 20 minutes sustained — storms move faster than a river corridor, so a shorter confirm window than cloudburst.ts's 30min

// Adaptive per-cell threshold, identical calibration idea to cloudburst.ts's
// adaptiveMidpoint(): learn each cell's own quiet-period noise rather than
// one hand-picked constant for the whole grid.
const CALIBRATION_END_IDX = 180; // ~30h, well before CONVERGENCE_ONSET for every cell
const ADAPT_SIGMA_MULT = 3.0;
const MIN_SIGMOID_MIDPOINT = 1.0;

const WEIGHTS = { cooling: 0.5, convergence: 0.5 };
const MIN_STD = { cooling: 0.3, convergence: 0.2 };

// Spatial confirmation: a triggering cell needs at least this many
// triggering cells (including itself) within its immediate 3x3 neighborhood
// at the same frame — the spatial analog of earthquake.ts's MIN_STATIONS.
const MIN_CLUSTER_CELLS = 3;

interface CellSeries { convergence: number[]; ir: number[]; reflectivity: number[] }

function adaptiveMidpoint(composite: number[]): number {
  const quiet = composite.slice(MIN_PERIODS, CALIBRATION_END_IDX);
  return Math.max(MIN_SIGMOID_MIDPOINT, ADAPT_SIGMA_MULT * sampleStd(quiet));
}

export interface CIDetectionResult {
  triggered: boolean;
  detectedAt?: string;
  leadMinutesBeforeMaturity?: number;
  confirmedCells?: string[]; // cell ids in the confirming cluster at trigger time
  peakProbability: number;
  peakProbabilityAt?: string;
  params: Record<string, unknown>;
}

export function runCIDetection(
  cellSeries: Record<string, CellSeries>,
  timesMs: number[],
  groundTruth: ConvectionGroundTruth,
): { probabilityByCell: Record<string, number[]>; result: CIDetectionResult } {
  const stepMinutes = (timesMs[1] - timesMs[0]) / 60000;
  const n = timesMs.length;

  const probabilityByCell: Record<string, number[]> = {};
  const cellIds = GRID_CELLS.map((c) => c.id);

  for (const cell of GRID_CELLS) {
    const s = cellSeries[cell.id];
    const coolingRate = coolingRateSeries(s.ir, stepMinutes);
    const zCooling = rollingZ(coolingRate, BASELINE_WINDOW, MIN_PERIODS, MIN_STD.cooling).map((v) => Math.max(0, v));
    const zConvergence = rollingZ(s.convergence, BASELINE_WINDOW, MIN_PERIODS, MIN_STD.convergence).map((v) => Math.max(0, v));
    const composite = zCooling.map((z, i) => WEIGHTS.cooling * z + WEIGHTS.convergence * zConvergence[i]);
    const midpoint = adaptiveMidpoint(composite);
    probabilityByCell[cell.id] = composite.map((z) => sigmoid(z - midpoint, SIGMOID_K));
  }

  // Per-frame: does a confirmed spatial cluster exist anywhere on the grid?
  const clusterConfirmedAt: (string[] | null)[] = new Array(n).fill(null);
  let peak = { p: -1, cellId: '', frameIdx: 0 };
  for (let i = 0; i < n; i++) {
    const triggeredThisFrame = new Set<string>();
    for (const id of cellIds) {
      const p = probabilityByCell[id][i];
      if (p > peak.p) peak = { p, cellId: id, frameIdx: i };
      if (p >= TRIGGER_PROB) triggeredThisFrame.add(id);
    }
    if (triggeredThisFrame.size === 0) continue;
    for (const cell of GRID_CELLS) {
      if (!triggeredThisFrame.has(cell.id)) continue;
      const clusterMembers = neighborsOf(cell.row, cell.col, 1).filter((n2) => triggeredThisFrame.has(n2.id));
      if (clusterMembers.length >= MIN_CLUSTER_CELLS) {
        clusterConfirmedAt[i] = clusterMembers.map((m) => m.id);
        break; // one confirmed cluster is enough to mark this frame
      }
    }
  }

  // Trigger: a confirmed cluster sustained for CONFIRM_SAMPLES consecutive frames.
  let run = 0;
  let triggerIdx = -1;
  for (let i = 0; i < n; i++) {
    run = clusterConfirmedAt[i] ? run + 1 : 0;
    if (run >= CONFIRM_SAMPLES) { triggerIdx = i - CONFIRM_SAMPLES + 1; break; }
  }

  const params = {
    baseline_window_samples: BASELINE_WINDOW,
    min_periods: MIN_PERIODS,
    sigmoid_k: SIGMOID_K,
    trigger_probability: TRIGGER_PROB,
    confirm_samples: CONFIRM_SAMPLES,
    calibration_window_samples: CALIBRATION_END_IDX,
    adapt_sigma_multiplier: ADAPT_SIGMA_MULT,
    min_sigmoid_midpoint: MIN_SIGMOID_MIDPOINT,
    min_cluster_cells: MIN_CLUSTER_CELLS,
    weights: WEIGHTS,
  };

  const result: CIDetectionResult = {
    triggered: triggerIdx >= 0,
    peakProbability: Math.round(peak.p * 10000) / 10000,
    peakProbabilityAt: formatNaiveIso(timesMs[peak.frameIdx]),
    params,
  };

  if (triggerIdx >= 0) {
    const detectedAt = formatNaiveIso(timesMs[triggerIdx]);
    result.detectedAt = detectedAt;
    result.confirmedCells = clusterConfirmedAt[triggerIdx] ?? [];
    result.leadMinutesBeforeMaturity = Math.round((parseNaiveIso(groundTruth.maturity_at) - parseNaiveIso(detectedAt)) / 60000);
  }

  return { probabilityByCell, result };
}
