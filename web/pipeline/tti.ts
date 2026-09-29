/**
 * Time-to-Impact (WP7, partial per Milestone 1 scope).
 *
 * Two TTI sources for the same real event:
 *  1. Downstream GLOF flood-wave TTI — reuses the exact onset formula
 *     already in cloudburst.ts (LAKE_BREACH_ONSET + basin_km/WAVE_SPEED_KM_PER_H).
 *     Fully consistent with existing, real architecture — no new assumption.
 *  2. Storm-cell TTI — distance from each town to the storm's own simulated
 *     track ÷ its known steering-wind speed. This uses the *simulated
 *     event's own ground truth*, not a general vision-based forecast (that
 *     generality is the deferred WP5). The UI must label this distinction.
 *
 * Alert log entries use the exact SMS-style template from the SIH26084
 * brief, rendered in-app only — no live SMS dispatch in Milestone 1 (see
 * README "Deferred to next milestone").
 */
import { STATIONS } from './stations.js';
import { haversineKm, formatNaiveIso, parseNaiveIso } from './mathUtils.js';
import { onsetTimeMs, WAVE_SPEED_KM_PER_H } from './cloudburst.js';
import type { ConvectionGroundTruth } from './convection.js';

export interface FloodTTIEntry { station_id: string; basin_km: number; flood_arrival_at: string }
export interface StormTTIEntry { station_id: string; distance_km: number; minutes_to_impact: number; impact_at: string }
export interface AlertLogEntry { station_id: string; hazard: string; minutes: number; message: string; issued_at: string }

export function buildFloodTTI(): FloodTTIEntry[] {
  return STATIONS.filter((s) => s.basinKm !== null).map((s) => ({
    station_id: s.id,
    basin_km: s.basinKm as number,
    flood_arrival_at: formatNaiveIso(onsetTimeMs(s.basinKm as number)),
  }));
}

/** Storm-cell TTI computed from the storm's own ground-truth track/steering
 *  vector, evaluated at its most mature (peak track) point — a fixed,
 *  reproducible snapshot rather than a live per-frame recompute, since
 *  Milestone 1 doesn't do general cell tracking. */
export function buildStormTTI(groundTruth: ConvectionGroundTruth): { tti: StormTTIEntry[]; alerts: AlertLogEntry[] } {
  if (groundTruth.track.length === 0) return { tti: [], alerts: [] };
  const originIdx = Math.floor(groundTruth.track.length * 0.3); // an early-but-confirmed point along the track, not the very first noisy sample
  const origin = groundTruth.track[originIdx];
  const originMs = parseNaiveIso(origin.time);

  const tti: StormTTIEntry[] = [];
  const alerts: AlertLogEntry[] = [];
  for (const s of STATIONS) {
    const distanceKm = haversineKm(s.lat, s.lon, origin.centroid_lat, origin.centroid_lon);
    const speedKmh = groundTruth.steering_vector.speed_kmh || WAVE_SPEED_KM_PER_H;
    const minutes = Math.round((distanceKm / speedKmh) * 60);
    const impactMs = originMs + minutes * 60000;
    tti.push({ station_id: s.id, distance_km: Math.round(distanceKm * 10) / 10, minutes_to_impact: minutes, impact_at: formatNaiveIso(impactMs) });

    if (minutes <= 180) {
      alerts.push({
        station_id: s.id,
        hazard: 'Severe Hail and Downburst winds',
        minutes,
        message: `CRITICAL ALERT: Severe Hail and Downburst winds expected in your immediate sector within ${minutes} minutes. Seek immediate shelter.`,
        issued_at: origin.time,
      });
    }
  }
  return { tti, alerts };
}
