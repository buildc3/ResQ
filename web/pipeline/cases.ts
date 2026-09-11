/**
 * Turns a triggered detection result into a Case object — the artifact the
 * UI reads. Ported from data-pipeline/generate_cases.py. Output field names
 * are intentionally snake_case (case_id, detected_at, phase_1, ...) to match
 * the JSON schema web/js/app.js already consumes unchanged.
 */
import { STATION_LOOKUP } from './stations.js';
import type { DetectionResultCloudburst } from './cloudburst.js';
import type { DetectionResultEarthquake } from './earthquake.js';
import type { Phase2Plan } from './phase2.js';

function severityLabel(probability: number): 'critical' | 'high' | 'moderate' {
  if (probability >= 0.95) return 'critical';
  if (probability >= 0.85) return 'high';
  return 'moderate';
}

export function buildCloudburstCase(result: DetectionResultCloudburst, phase2: Phase2Plan) {
  if (!result.triggered) return null;
  const primary = STATION_LOOKUP[result.primaryStation!];
  const contributing = result.contributingStations!;
  const corridor = result.corridorStations!;
  const corridorNames = corridor.map((id) => STATION_LOOKUP[id].name);
  const regionLabel = corridorNames.length > 1
    ? `Teesta Basin corridor: ${corridorNames[0]} to ${corridorNames[corridorNames.length - 1]}`
    : corridorNames[0] || primary.name;

  return {
    case_id: 'CASE-CLOUDBURST-20231004',
    disaster_type: 'cloudburst_glof',
    title: 'Cloudburst / GLOF — Upper Teesta Basin',
    location: {
      primary_station_id: primary.id,
      primary_station_name: primary.name,
      lat: primary.lat,
      lon: primary.lon,
      region_label: regionLabel,
    },
    detected_at: result.detectedAt,
    severity: {
      probability_at_detection: result.probabilityAtDetection,
      peak_probability: result.peakProbability,
      severity_label: severityLabel(result.peakProbability!),
      contributing_stations: contributing,
      corridor_stations: corridor,
      off_corridor_stations: result.offCorridorStations,
    },
    phase_1: {
      status: 'complete',
      model: result.model,
      model_params: result.params,
      summary:
        `Rolling z-score fusion triggered at ${primary.name}; over the following hours the flood wave was ` +
        `confirmed at ${corridorNames.length} corridor station(s) (${corridorNames.join(', ')}), peaking at ` +
        `${result.peakProbability!.toFixed(2)} probability at ${result.peakProbabilityAt}.`,
    },
    phase_2: {
      relay_schedule: phase2.relay_schedule,
      search_zones: phase2.search_zones,
      connectivity_complete_at: phase2.connectivity_complete_at,
      search_complete_at: phase2.search_complete_at,
    },
    phase_3: { status: 'pending', medical_dispatch: null, relief_dispatch: null },
  };
}

export function buildEarthquakeCase(result: DetectionResultEarthquake, phase2: Phase2Plan) {
  if (!result.triggered) return null;
  const epicenter = result.estimatedEpicenter!;
  const confirming = result.confirmingStations!;
  const confirmingNames = confirming.map((id) => STATION_LOOKUP[id].name);

  return {
    case_id: 'CASE-EARTHQUAKE-20231004',
    disaster_type: 'earthquake',
    title: 'Earthquake — North Sikkim',
    location: {
      primary_station_id: result.peakProbabilityStation,
      primary_station_name: STATION_LOOKUP[result.peakProbabilityStation!].name,
      lat: epicenter.lat,
      lon: epicenter.lon,
      region_label: 'Estimated epicenter near Mangan, North Sikkim',
    },
    detected_at: result.detectedAt,
    severity: {
      probability_at_detection: result.probabilityAtDetection,
      peak_probability: result.peakProbability,
      severity_label: severityLabel(result.peakProbability!),
      contributing_stations: confirming,
    },
    phase_1: {
      status: 'complete',
      model: result.model,
      model_params: result.params,
      summary:
        `STA/LTA trigger confirmed across ${confirming.length} stations (${confirmingNames.join(', ')}); ` +
        `peak probability ${result.peakProbability!.toFixed(2)} at ${result.peakProbabilityStation}.`,
    },
    phase_2: {
      relay_schedule: phase2.relay_schedule,
      search_zones: phase2.search_zones,
      connectivity_complete_at: phase2.connectivity_complete_at,
      search_complete_at: phase2.search_complete_at,
    },
    phase_3: { status: 'pending', medical_dispatch: null, relief_dispatch: null },
  };
}
