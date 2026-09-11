/**
 * Phase 3 — Medical & Relief Delivery.
 *
 * Two fleets, per the pitch: lightweight Medical Supply drones do a single
 * precision winch-drop of first-aid/medication to each affected zone the
 * moment connectivity (Phase 2) reaches it — "a call for help matters before
 * bulk supplies do" — while Heavy Payload drones then run repeat sorties
 * (food/water/blankets) for sustained, multi-day aid. Both are staged from
 * Gangtok (the state capital / best-infrastructure reference station) for
 * both scenarios, same as the pitch's "district depot" staging idea.
 *
 * Same architecture as Phase 2: this generates a deterministic schedule: all
 * of Phase 3's live state (dispatched/delivered, running payload totals) is
 * derived by the frontend from comparing the current playhead timestamp
 * against these real timestamps — no separate detection model needed.
 */
import { SeededRng } from './rng.js';
import { STATION_LOOKUP } from './stations.js';
import { parseNaiveIso, formatNaiveIso, haversineKm } from './mathUtils.js';

const STAGING_STATION_ID = 'gangtok';
const MEDICAL_PREP_MINUTES: [number, number] = [10, 20];
const MEDICAL_SPEED_KMH = 45;
const MEDICAL_PAYLOAD_KG: [number, number] = [2, 5];
const HEAVY_PREP_MINUTES: [number, number] = [30, 50];
const HEAVY_SPEED_KMH = 65;
const HEAVY_PAYLOAD_KG: [number, number] = [20, 50];
const HEAVY_SORTIE_INTERVAL_HOURS: [number, number] = [20, 30]; // repeat resupply cadence

export interface MedicalDelivery { station_id: string; dispatched_at: string; delivered_at: string; payload_kg: number }
export interface ReliefSortie { station_id: string; sortie: number; dispatched_at: string; delivered_at: string; payload_kg: number }
export interface Phase3Plan { medical_deliveries: MedicalDelivery[]; relief_sorties: ReliefSortie[] }

function flightMinutes(fromId: string, toId: string, speedKmh: number): number {
  const a = STATION_LOOKUP[fromId];
  const b = STATION_LOOKUP[toId];
  return (haversineKm(a.lat, a.lon, b.lat, b.lon) / speedKmh) * 60;
}

/**
 * relayDeployAt: station_id -> ISO timestamp connectivity reached that zone
 * (Phase 2's relay_schedule) — relief dispatch keys off this, matching the
 * pitch's "connectivity first, then relief in the same operation."
 */
export function buildPhase3Plan(relayDeployAt: Record<string, string>, simEndIso: string, seed: number): Phase3Plan {
  const rng = new SeededRng(seed);
  const simEndMs = parseNaiveIso(simEndIso);

  const medical_deliveries: MedicalDelivery[] = [];
  const relief_sorties: ReliefSortie[] = [];

  for (const [stationId, connectedAtIso] of Object.entries(relayDeployAt)) {
    const connectedMs = parseNaiveIso(connectedAtIso);

    const medPrep = MEDICAL_PREP_MINUTES[0] + rng.next() * (MEDICAL_PREP_MINUTES[1] - MEDICAL_PREP_MINUTES[0]);
    const medDispatchMs = connectedMs + medPrep * 60000;
    const medFlight = flightMinutes(STAGING_STATION_ID, stationId, MEDICAL_SPEED_KMH);
    medical_deliveries.push({
      station_id: stationId,
      dispatched_at: formatNaiveIso(medDispatchMs),
      delivered_at: formatNaiveIso(medDispatchMs + medFlight * 60000),
      payload_kg: Math.round((MEDICAL_PAYLOAD_KG[0] + rng.next() * (MEDICAL_PAYLOAD_KG[1] - MEDICAL_PAYLOAD_KG[0])) * 10) / 10,
    });

    const heavyPrep = HEAVY_PREP_MINUTES[0] + rng.next() * (HEAVY_PREP_MINUTES[1] - HEAVY_PREP_MINUTES[0]);
    let dispatchMs = connectedMs + heavyPrep * 60000;
    let sortieNum = 1;
    const heavyFlight = flightMinutes(STAGING_STATION_ID, stationId, HEAVY_SPEED_KMH);
    // Gate on the *delivery* time, not just dispatch — a sortie dispatched
    // near the window's edge whose flight time pushes delivery past simEndMs
    // would leave Phase 3 permanently "active" (computePhase3 in app.js can
    // never see it reach delivered_at within the generated timeline).
    while (dispatchMs + heavyFlight * 60000 <= simEndMs) {
      relief_sorties.push({
        station_id: stationId,
        sortie: sortieNum,
        dispatched_at: formatNaiveIso(dispatchMs),
        delivered_at: formatNaiveIso(dispatchMs + heavyFlight * 60000),
        payload_kg: Math.round(HEAVY_PAYLOAD_KG[0] + rng.next() * (HEAVY_PAYLOAD_KG[1] - HEAVY_PAYLOAD_KG[0])),
      });
      const intervalHours = HEAVY_SORTIE_INTERVAL_HOURS[0] + rng.next() * (HEAVY_SORTIE_INTERVAL_HOURS[1] - HEAVY_SORTIE_INTERVAL_HOURS[0]);
      dispatchMs += intervalHours * 3600000;
      sortieNum++;
    }
  }

  medical_deliveries.sort((a, b) => a.dispatched_at.localeCompare(b.dispatched_at));
  relief_sorties.sort((a, b) => a.dispatched_at.localeCompare(b.dispatched_at));
  return { medical_deliveries, relief_sorties };
}
