"""Cloudburst / GLOF detection: rolling z-score anomaly fusion.

For each station, fuses positive anomalies in rainfall rate, water-level
rate-of-rise (the strongest flash-flood predictor), and ground tremor into one
composite z-score, then maps it to a 0-1 probability via a sigmoid. The
regional probability is the max across stations; a trigger requires it to
stay >= TRIGGER_PROB for CONFIRM_SAMPLES consecutive 10-minute samples, so a
single noisy tick can't fire a case on its own.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from stations import STATIONS
from detection_utils import rolling_z, sigmoid

OUT_DIR = Path(__file__).parent / "output"

BASELINE_WINDOW = 144  # 24h at 10-min resolution
MIN_PERIODS = 12  # 2h
SIGMOID_K = 0.8
SIGMOID_MIDPOINT = 2.5
TRIGGER_PROB = 0.8
CONFIRM_SAMPLES = 3  # 30 minutes sustained

WEIGHTS_WITH_LEVEL = {"rainfall": 0.3, "water_level_rate": 0.5, "tremor": 0.2}
WEIGHTS_NO_LEVEL = {"rainfall": 0.6, "tremor": 0.4}

# Noise floors: a quiet/low-variance baseline (e.g. a dry spell with near-zero
# rainfall variance) shouldn't make a merely-moderate reading register as an
# extreme anomaly just because nothing happened for a while beforehand. Values
# are rough sensor-noise-floor guesses in each signal's native unit.
MIN_STD = {"rainfall": 1.5, "water_level_rate": 0.05, "tremor": 0.01}

STATION_LOOKUP = {s["id"]: s for s in STATIONS}


def station_probability(df):
    df = df.sort_values("timestamp").reset_index(drop=True)
    z_rain = rolling_z(df.rainfall_mm_hr, BASELINE_WINDOW, MIN_PERIODS, min_std=MIN_STD["rainfall"]).clip(lower=0)
    z_tremor = rolling_z(df.ground_tremor_index, BASELINE_WINDOW, MIN_PERIODS, min_std=MIN_STD["tremor"]).clip(lower=0)

    has_level = df.water_level_m.notna().all()
    if has_level:
        rate_of_rise = df.water_level_m.diff() / (10 / 60)  # m/hr
        z_level = rolling_z(
            rate_of_rise.fillna(0), BASELINE_WINDOW, MIN_PERIODS, min_std=MIN_STD["water_level_rate"]
        ).clip(lower=0)
        w = WEIGHTS_WITH_LEVEL
        composite = w["rainfall"] * z_rain + w["water_level_rate"] * z_level + w["tremor"] * z_tremor
    else:
        w = WEIGHTS_NO_LEVEL
        composite = w["rainfall"] * z_rain + w["tremor"] * z_tremor

    probability = sigmoid(composite - SIGMOID_MIDPOINT, k=SIGMOID_K)
    return pd.DataFrame({"timestamp": df.timestamp, "probability": probability, "composite_z": composite})


def find_trigger(regional):
    above = regional.probability >= TRIGGER_PROB
    run = 0
    for i, is_above in enumerate(above):
        run = run + 1 if is_above else 0
        if run >= CONFIRM_SAMPLES:
            trigger_idx = i - CONFIRM_SAMPLES + 1
            return regional.timestamp.iloc[trigger_idx]
    return None


def main():
    raw = pd.read_csv(OUT_DIR / "cloudburst_raw.csv")
    raw["timestamp"] = pd.to_datetime(raw["timestamp"])

    per_station = []
    for sid, group in raw.groupby("station_id"):
        prob = station_probability(group)
        prob["station_id"] = sid
        per_station.append(prob)
    per_station = pd.concat(per_station, ignore_index=True)

    wide = per_station.pivot(index="timestamp", columns="station_id", values="probability")
    regional = wide.max(axis=1).rename("probability").reset_index()
    contributor = wide.idxmax(axis=1).rename("top_station").reset_index()
    regional = regional.merge(contributor, on="timestamp")

    regional.to_csv(OUT_DIR / "cloudburst_probability.csv", index=False)
    per_station.to_csv(OUT_DIR / "cloudburst_probability_by_station.csv", index=False)

    # UI-friendly JSON mirrors (avoids a client-side CSV parser).
    with open(OUT_DIR / "cloudburst_regional_probability.json", "w") as f:
        json.dump(
            [{"timestamp": pd.Timestamp(t).isoformat(), "probability": round(float(p), 4)} for t, p in zip(regional.timestamp, regional.probability)],
            f,
        )
    station_prob_frames = [
        {
            "timestamp": pd.Timestamp(ts).isoformat(),
            "stations": {sid: (None if pd.isna(v) else round(float(v), 4)) for sid, v in row.items()},
        }
        for ts, row in wide.iterrows()
    ]
    with open(OUT_DIR / "cloudburst_station_probability_frames.json", "w") as f:
        json.dump(station_prob_frames, f)

    trigger_time = find_trigger(regional)
    result = {
        "scenario": "cloudburst_glof",
        "model": "rolling_zscore_fusion",
        "params": {
            "baseline_window_samples": BASELINE_WINDOW,
            "min_periods": MIN_PERIODS,
            "sigmoid_k": SIGMOID_K,
            "sigmoid_midpoint": SIGMOID_MIDPOINT,
            "trigger_probability": TRIGGER_PROB,
            "confirm_samples": CONFIRM_SAMPLES,
            "weights_with_water_level": WEIGHTS_WITH_LEVEL,
            "weights_without_water_level": WEIGHTS_NO_LEVEL,
        },
        "triggered": trigger_time is not None,
    }

    if trigger_time is not None:
        at_trigger = wide.loc[trigger_time]
        peak_row = regional.loc[regional.probability.idxmax()]

        # Contributing stations: scan the *entire* event timeline, not just the trigger
        # instant — a propagating flood wave reaches downstream stations hours later,
        # and they should still show up as part of the affected corridor.
        ever_crossed = wide.ge(TRIGGER_PROB).any(axis=0)
        contributing_all = wide.columns[ever_crossed].tolist()
        corridor = sorted(
            (s for s in contributing_all if STATION_LOOKUP.get(s, {}).get("has_water_level")),
            key=lambda s: STATION_LOOKUP[s]["basin_km"],
        )
        off_corridor = sorted(s for s in contributing_all if not STATION_LOOKUP.get(s, {}).get("has_water_level"))

        result.update(
            {
                "detected_at": pd.Timestamp(trigger_time).isoformat(),
                "primary_station": at_trigger.idxmax(),
                "probability_at_detection": round(float(at_trigger.max()), 4),
                "contributing_stations": contributing_all,
                "corridor_stations": corridor,
                "off_corridor_stations": off_corridor,
                "peak_probability": round(float(peak_row.probability), 4),
                "peak_probability_at": pd.Timestamp(peak_row.timestamp).isoformat(),
            }
        )

    with open(OUT_DIR / "cloudburst_detection_result.json", "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
