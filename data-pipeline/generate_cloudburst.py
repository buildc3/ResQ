"""Synthetic sensor data generator: cloudburst / GLOF scenario.

Illustrative reconstruction of a South-Lhonak-Lake-style glacial lake outburst
flood (as referenced for Sikkim, Oct 2023) for demo purposes. No real sensor
network of this kind exists for that event — these are physically plausible
synthetic values (rainfall, water level, soil moisture, ground tremor), not
recorded measurements. Timings/magnitudes are chosen for a clear, explainable
demo narrative, not a hydrologically calibrated reconstruction.

Timeline (IST):
  Oct 2 00:00 - Oct 3 12:00  Baseline monsoon conditions.
  Oct 3 12:00 - Oct 4 06:00  Localized cloudburst intensifies over the upper
                             catchment (Lachen / Chungthang / Mangan).
  Oct 4 ~01:30               Landslide into South Lhonak Lake -> tremor at
                             Lachen, followed by rapid lake-level surge/breach.
  Oct 4 01:30 - 06:30        GLOF wave propagates downstream (~15 km/h),
                             producing a fast rise + slow recession at each
                             river station, attenuating with distance.
  Oct 4 (day) - Oct 6        Recession: water levels and rainfall taper off.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from stations import STATIONS, SIM_START, SIM_END
from utils import time_grid, ar1_series, gaussian_bump, rise_and_recede

OUT_DIR = Path(__file__).parent / "output"
STEP_MINUTES = 10
SEED = 42

LAKE_BREACH_ONSET = pd.Timestamp("2023-10-04 01:30:00")
WAVE_SPEED_KM_PER_H = 15.0
WATER_LEVEL_DECAY_KM = 45.0

RAIN_PEAK_TIME = pd.Timestamp("2023-10-03 21:00:00")
RAIN_WIDTH_HOURS = 5.0
UPPER_CATCHMENT = {"lachen", "chungthang", "mangan"}

TREMOR_CENTER = pd.Timestamp("2023-10-04 01:35:00")
TREMOR_WIDTH_HOURS = 0.15


def onset_time(basin_km):
    return LAKE_BREACH_ONSET + pd.Timedelta(hours=basin_km / WAVE_SPEED_KM_PER_H)


def peak_rise_m(basin_km):
    return 8.0 * np.exp(-basin_km / WATER_LEVEL_DECAY_KM)


def build_station_frame(station, idx, rng):
    n = len(idx)
    t_hours = (idx - idx[0]).total_seconds().values / 3600.0
    rain_center_hours = (RAIN_PEAK_TIME - idx[0]).total_seconds() / 3600.0

    rain_peak = rng.uniform(70, 90) if station["id"] in UPPER_CATCHMENT else rng.uniform(15, 30)
    baseline_rain = np.clip(rng.gamma(shape=0.3, scale=2.0, size=n), 0, 8)
    rain_event = gaussian_bump(t_hours, rain_center_hours, RAIN_WIDTH_HOURS, rain_peak)
    rainfall = np.clip(baseline_rain + rain_event, 0, None)

    if station["has_water_level"]:
        basin_km = station["basin_km"]
        onset_hours = (onset_time(basin_km) - idx[0]).total_seconds() / 3600.0
        rise_hours = 0.5 + basin_km / 100.0
        decay_tau_hours = 12.0 + basin_km / 10.0
        baseline_level = 3.0 if station["water_body"] == "South Lhonak Lake" else 2.0
        noise = rng.normal(0, 0.03, n)
        surge = rise_and_recede(t_hours, onset_hours, rise_hours, peak_rise_m(basin_km), decay_tau_hours)
        water_level = baseline_level + noise + surge
    else:
        water_level = np.full(n, np.nan)

    soil_moisture = ar1_series(n, mean=45.0, phi=0.985, sigma=0.25, rng=rng)
    cum_rain = pd.Series(rainfall).rolling(window=24 * 6, min_periods=1).sum().values  # trailing 24h
    soil_moisture = np.clip(soil_moisture + 20.0 * (cum_rain / (cum_rain.max() + 1e-6)), 20, 95)

    tremor_baseline = np.abs(rng.normal(0, 0.02, n))
    tremor_center_hours = (TREMOR_CENTER - idx[0]).total_seconds() / 3600.0
    if station["id"] == "lachen":
        tremor = tremor_baseline + gaussian_bump(t_hours, tremor_center_hours, TREMOR_WIDTH_HOURS, 0.95)
    elif station["id"] == "chungthang":
        tremor = tremor_baseline + gaussian_bump(t_hours, tremor_center_hours + 0.75, TREMOR_WIDTH_HOURS * 2, 0.35)
    elif station["id"] == "mangan":
        tremor = tremor_baseline + gaussian_bump(t_hours, tremor_center_hours + 2.1, TREMOR_WIDTH_HOURS * 2, 0.12)
    else:
        tremor = tremor_baseline
    tremor = np.clip(tremor, 0, 1)

    return pd.DataFrame(
        {
            "timestamp": idx,
            "station_id": station["id"],
            "station_name": station["name"],
            "lat": station["lat"],
            "lon": station["lon"],
            "rainfall_mm_hr": np.round(rainfall, 2),
            "water_level_m": np.round(water_level, 3),
            "soil_moisture_pct": np.round(soil_moisture, 2),
            "ground_tremor_index": np.round(tremor, 4),
        }
    )


def main():
    OUT_DIR.mkdir(exist_ok=True)
    idx = time_grid(SIM_START, SIM_END, STEP_MINUTES)
    rng = np.random.default_rng(SEED)

    frames = [build_station_frame(s, idx, rng) for s in STATIONS]
    raw = pd.concat(frames, ignore_index=True).sort_values(["timestamp", "station_id"])
    raw.to_csv(OUT_DIR / "cloudburst_raw.csv", index=False)

    ui_frames = []
    for ts, group in raw.groupby("timestamp"):
        stations_payload = {
            row.station_id: {
                "rainfall_mm_hr": row.rainfall_mm_hr,
                "water_level_m": None if pd.isna(row.water_level_m) else row.water_level_m,
                "soil_moisture_pct": row.soil_moisture_pct,
                "ground_tremor_index": row.ground_tremor_index,
            }
            for row in group.itertuples()
        }
        ui_frames.append({"timestamp": ts.isoformat(), "stations": stations_payload})
    with open(OUT_DIR / "cloudburst_frames.json", "w") as f:
        json.dump(ui_frames, f, indent=2)

    metadata = {
        "scenario": "cloudburst_glof",
        "label": "South Lhonak Lake-style GLOF (synthetic, illustrative)",
        "sim_start": SIM_START,
        "sim_end": SIM_END,
        "step_minutes": STEP_MINUTES,
        "lake_breach_onset": LAKE_BREACH_ONSET.isoformat(),
        "wave_speed_km_per_h": WAVE_SPEED_KM_PER_H,
        "rain_peak_time": RAIN_PEAK_TIME.isoformat(),
        "station_onsets": {
            s["id"]: onset_time(s["basin_km"]).isoformat() for s in STATIONS if s["has_water_level"]
        },
        "seed": SEED,
        "disclaimer": "Synthetic values for demo purposes; not recorded measurements.",
    }
    with open(OUT_DIR / "cloudburst_event_metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"rows: {len(raw)}  stations: {raw.station_id.nunique()}  timestamps: {raw.timestamp.nunique()}")
    print(raw.groupby("station_id")[["rainfall_mm_hr", "water_level_m", "ground_tremor_index"]].max())


if __name__ == "__main__":
    main()
