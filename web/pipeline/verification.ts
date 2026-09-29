/**
 * WP8 verification — scores forecast.ts's baseline nowcast against this
 * scenario's own real simulated future (i.e., what convection.ts actually
 * generated at each forecast's target time), per lead time. Standard
 * categorical skill scores: POD (probability of detection), FAR (false
 * alarm ratio), CSI (critical success index) — computed by comparing which
 * grid cells cross the same >=40dBZ threshold in the forecast vs. the
 * actual future frame.
 *
 * Honest framing: this scores the forecast against SIMULATED ground truth,
 * not real-world verification data — stated plainly in the UI and README.
 * Skill is expected (and should) decay as lead time grows; a flat curve
 * would mean something is wrong with the scoring, not that the forecast is
 * unusually good.
 */
import { CELL_ID_THRESHOLD_DBZ, targetTimestamp, type ForecastFrame } from './forecast.js';
import { LEAD_TIME_MINUTES } from './grid.js';
import type { ConvectionFrame } from './convection.js';

export interface SkillAtLead { lead_minutes: number; hits: number; misses: number; false_alarms: number; pod: number; far: number; csi: number; sample_count: number }

export function buildVerification(forecastFrames: ForecastFrame[], actualFrames: ConvectionFrame[]): SkillAtLead[] {
  const actualByTs = new Map<string, Set<string>>();
  for (const frame of actualFrames) {
    const ids = new Set(frame.cells.filter((c) => c.reflectivity_dbz >= CELL_ID_THRESHOLD_DBZ).map((c) => c.cell_id));
    actualByTs.set(frame.timestamp, ids);
  }

  const byLead = new Map<number, { hits: number; misses: number; falseAlarms: number; sampleCount: number }>();
  for (const lead of LEAD_TIME_MINUTES) if (lead > 0) byLead.set(lead, { hits: 0, misses: 0, falseAlarms: 0, sampleCount: 0 });

  for (const f of forecastFrames) {
    const target = targetTimestamp(f.base_timestamp, f.lead_minutes);
    const actualSet = actualByTs.get(target) ?? new Set<string>();
    const forecastSet = new Set(f.cells.filter((c) => c.reflectivity_dbz >= CELL_ID_THRESHOLD_DBZ).map((c) => c.cell_id));

    let hits = 0, falseAlarms = 0;
    forecastSet.forEach((id) => { if (actualSet.has(id)) hits++; else falseAlarms++; });
    let misses = 0;
    actualSet.forEach((id) => { if (!forecastSet.has(id)) misses++; });

    const bucket = byLead.get(f.lead_minutes);
    if (bucket) { bucket.hits += hits; bucket.misses += misses; bucket.falseAlarms += falseAlarms; bucket.sampleCount++; }
  }

  return Array.from(byLead.entries()).map(([lead_minutes, b]) => {
    const pod = b.hits + b.misses > 0 ? b.hits / (b.hits + b.misses) : 0;
    const far = b.hits + b.falseAlarms > 0 ? b.falseAlarms / (b.hits + b.falseAlarms) : 0;
    const csi = b.hits + b.misses + b.falseAlarms > 0 ? b.hits / (b.hits + b.misses + b.falseAlarms) : 0;
    return {
      lead_minutes, hits: b.hits, misses: b.misses, false_alarms: b.falseAlarms,
      pod: Math.round(pod * 1000) / 1000, far: Math.round(far * 1000) / 1000, csi: Math.round(csi * 1000) / 1000,
      sample_count: b.sampleCount,
    };
  }).sort((a, b) => a.lead_minutes - b.lead_minutes);
}
