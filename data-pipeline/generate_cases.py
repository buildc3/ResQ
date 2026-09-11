"""Step 3: turn a triggered detection result into a Case object.

A Case is the central entity the future UI reads: created the moment Phase 1
confirms a disaster, carrying Phase 1's findings plus empty Phase 2/3 slots
for later phases to fill in as the response progresses.
"""

import json
from pathlib import Path

from stations import STATIONS

OUT_DIR = Path(__file__).parent / "output"
STATION_LOOKUP = {s["id"]: s for s in STATIONS}


def severity_label(probability):
    if probability >= 0.95:
        return "critical"
    if probability >= 0.85:
        return "high"
    return "moderate"


def build_cloudburst_case(result):
    primary = STATION_LOOKUP[result["primary_station"]]
    contributing = result["contributing_stations"]
    corridor = result["corridor_stations"]
    corridor_names = [STATION_LOOKUP[s]["name"] for s in corridor]
    if len(corridor_names) > 1:
        region_label = f"Teesta Basin corridor: {corridor_names[0]} to {corridor_names[-1]}"
    elif corridor_names:
        region_label = corridor_names[0]
    else:
        region_label = primary["name"]
    return {
        "case_id": "CASE-CLOUDBURST-20231004",
        "disaster_type": "cloudburst_glof",
        "title": "Cloudburst / GLOF — Upper Teesta Basin",
        "location": {
            "primary_station_id": primary["id"],
            "primary_station_name": primary["name"],
            "lat": primary["lat"],
            "lon": primary["lon"],
            "region_label": region_label,
        },
        "detected_at": result["detected_at"],
        "severity": {
            "probability_at_detection": result["probability_at_detection"],
            "peak_probability": result["peak_probability"],
            "severity_label": severity_label(result["peak_probability"]),
            "contributing_stations": contributing,
            "corridor_stations": corridor,
            "off_corridor_stations": result["off_corridor_stations"],
        },
        "phase_1": {
            "status": "complete",
            "model": result["model"],
            "model_params": result["params"],
            "summary": (
                f"Rolling z-score fusion triggered at {primary['name']}; over the "
                f"following hours the flood wave was confirmed at {len(corridor_names)} "
                f"corridor station(s) ({', '.join(corridor_names)}), peaking at "
                f"{result['peak_probability']:.2f} probability at {result['peak_probability_at']}."
            ),
        },
        "phase_2": {"status": "pending", "search": None, "connectivity": None},
        "phase_3": {"status": "pending", "medical_dispatch": None, "relief_dispatch": None},
    }


def build_earthquake_case(result):
    epicenter = result["estimated_epicenter"]
    confirming = result["confirming_stations"]
    return {
        "case_id": "CASE-EARTHQUAKE-20231004",
        "disaster_type": "earthquake",
        "title": "Earthquake — North Sikkim",
        "location": {
            "primary_station_id": result["peak_probability_station"],
            "primary_station_name": STATION_LOOKUP[result["peak_probability_station"]]["name"],
            "lat": epicenter["lat"],
            "lon": epicenter["lon"],
            "region_label": "Estimated epicenter near Mangan, North Sikkim",
        },
        "detected_at": result["detected_at"],
        "severity": {
            "probability_at_detection": result["probability_at_detection"],
            "peak_probability": result["peak_probability"],
            "severity_label": severity_label(result["peak_probability"]),
            "contributing_stations": confirming,
        },
        "phase_1": {
            "status": "complete",
            "model": result["model"],
            "model_params": result["params"],
            "summary": (
                f"STA/LTA trigger confirmed across {len(confirming)} stations "
                f"({', '.join(STATION_LOOKUP[s]['name'] for s in confirming)}); "
                f"peak probability {result['peak_probability']:.2f} at {result['peak_probability_station']}."
            ),
        },
        "phase_2": {"status": "pending", "search": None, "connectivity": None},
        "phase_3": {"status": "pending", "medical_dispatch": None, "relief_dispatch": None},
    }


def main():
    cases = []

    cloudburst_result = json.load(open(OUT_DIR / "cloudburst_detection_result.json"))
    if cloudburst_result.get("triggered"):
        cases.append(build_cloudburst_case(cloudburst_result))

    earthquake_result = json.load(open(OUT_DIR / "earthquake_detection_result.json"))
    if earthquake_result.get("triggered"):
        cases.append(build_earthquake_case(earthquake_result))

    with open(OUT_DIR / "cases.json", "w") as f:
        json.dump(cases, f, indent=2)

    print(f"generated {len(cases)} case(s)")
    for c in cases:
        print(f"- {c['case_id']}: detected_at={c['detected_at']} severity={c['severity']['severity_label']}")


if __name__ == "__main__":
    main()
