/**
 * Phase 2 — Search & Connectivity Restoration.
 *
 * Two fleets, per the pitch: Network Extender drones daisy-chain a relay
 * chain from the edge of the still-working network into the disaster
 * corridor one hop at a time; Search drones sweep each affected zone for
 * survivors in parallel. This generates a deterministic schedule for both,
 * seeded off the case's own detection — the frontend derives all dynamic
 * status (pending/active/complete, connectivity %, survivors found so far)
 * by comparing the current timeline position against these real timestamps,
 * the same pattern Phase 1's case-reveal already uses.
 */
import { SeededRng } from './rng.js';
import { STATION_LOOKUP } from './stations.js';
import { parseNaiveIso, formatNaiveIso, haversineKm } from './mathUtils.js';

const RELAY_START_LAG_MINUTES = 20; // time after detection before the first relay launches
const RELAY_HOP_MINUTES: [number, number] = [25, 40]; // transit + setup time per subsequent hop
const SEARCH_START_LAG_MINUTES = 15;
const SEARCH_START_JITTER_MINUTES = 10;
const SEARCH_DURATION_MINUTES: [number, number] = [40, 90];
const MAX_SURVIVORS_PER_ZONE = 6;
const SURVIVOR_JITTER_DEG = 0.01; // scatter survivor pins slightly around the station

export interface RelayDeployment { station_id: string; lat: number; lon: number; order: number; deploy_at: string }
export interface SurvivorEvent { lat: number; lon: number; found_at: string }
export interface SearchZone { station_id: string; search_start: string; search_complete: string; survivors: SurvivorEvent[] }
export interface Phase2Plan {
  relay_schedule: RelayDeployment[];
  search_zones: SearchZone[];
  connectivity_complete_at: string;
  search_complete_at: string;
}

/**
 * stationIds: the affected zone (corridor or confirming stations from Phase 1).
 * epicenter: when set (earthquake), relay order goes nearest-epicenter-first
 * since there's no directional "dead corridor" the way a river has one; when
 * unset (cloudburst), order goes by descending basin_km — starting at the
 * station closest to the still-working downstream network and working
 * upstream into the cut-off zone, matching the pitch's worked example.
 */
export function buildPhase2Plan(stationIds: string[], detectedAtIso: string, seed: number, epicenter?: { lat: number; lon: number }): Phase2Plan {
  const rng = new SeededRng(seed);
  const detectedMs = parseNaiveIso(detectedAtIso);

  const ordered = [...stationIds].sort((a, b) => {
    const sa = STATION_LOOKUP[a];
    const sb = STATION_LOOKUP[b];
    if (sa.basinKm !== null && sb.basinKm !== null) return sb.basinKm - sa.basinKm;
    if (epicenter) {
      return haversineKm(sa.lat, sa.lon, epicenter.lat, epicenter.lon) - haversineKm(sb.lat, sb.lon, epicenter.lat, epicenter.lon);
    }
    return 0;
  });

  let cursorMs = detectedMs + RELAY_START_LAG_MINUTES * 60000;
  const relay_schedule: RelayDeployment[] = ordered.map((id, i) => {
    if (i > 0) cursorMs += (RELAY_HOP_MINUTES[0] + rng.next() * (RELAY_HOP_MINUTES[1] - RELAY_HOP_MINUTES[0])) * 60000;
    const st = STATION_LOOKUP[id];
    return { station_id: id, lat: st.lat, lon: st.lon, order: i, deploy_at: formatNaiveIso(cursorMs) };
  });

  const search_zones: SearchZone[] = stationIds.map((id) => {
    const st = STATION_LOOKUP[id];
    const startMs = detectedMs + (SEARCH_START_LAG_MINUTES + rng.next() * SEARCH_START_JITTER_MINUTES) * 60000;
    const durationMs = (SEARCH_DURATION_MINUTES[0] + rng.next() * (SEARCH_DURATION_MINUTES[1] - SEARCH_DURATION_MINUTES[0])) * 60000;
    const completeMs = startMs + durationMs;
    const n = Math.floor(rng.next() * (MAX_SURVIVORS_PER_ZONE + 1));
    const survivors: SurvivorEvent[] = Array.from({ length: n }, () => ({
      lat: st.lat + (rng.next() - 0.5) * SURVIVOR_JITTER_DEG,
      lon: st.lon + (rng.next() - 0.5) * SURVIVOR_JITTER_DEG,
      found_at: formatNaiveIso(startMs + rng.next() * durationMs),
    })).sort((a, b) => a.found_at.localeCompare(b.found_at));
    return { station_id: id, search_start: formatNaiveIso(startMs), search_complete: formatNaiveIso(completeMs), survivors };
  });

  const connectivity_complete_at = relay_schedule.length ? relay_schedule[relay_schedule.length - 1].deploy_at : detectedAtIso;
  const search_complete_at = search_zones.reduce((max, z) => (z.search_complete > max ? z.search_complete : max), detectedAtIso);

  return { relay_schedule, search_zones, connectivity_complete_at, search_complete_at };
}
