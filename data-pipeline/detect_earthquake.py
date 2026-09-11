"""Earthquake detection: STA/LTA trigger, the standard seismological algorithm.

Per station, the ratio of short-term average signal energy (2s) to long-term
average (60s) spikes when a wave arrives; the ratio is sigmoid-mapped to a
0-1 probability. A case is only confirmed once at least MIN_STATIONS distinct
stations cross TRIGGER_PROB within CONFIRM_WINDOW of each other, consistent
with real wave-propagation delay across the network (avoids single-station
noise false-triggering). Input is a uniform 1Hz series per station, so plain
fixed-size rolling windows are used directly (no resampling needed).
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from stations import STATIONS
from detection_utils import sigmoid

OUT_DIR = Path(__file__).parent / "output"

STA_SAMPLES = 10  # 10s at 1Hz — a 2-sample window is too small to average out
                  # half-normal ambient noise (real STA windows are several
                  # seconds for the same reason); 2 samples let sampling
                  # variance alone push the ratio above trigger_ratio by chance
LTA_SAMPLES = 60  # 60s
SIGMOID_K = 1.5
TRIGGER_RATIO = 4.0
TRIGGER_PROB = 0.8
MIN_STATIONS = 2
CONFIRM_WINDOW_SECONDS = 30
FRAME_STEP_MINUTES = 10
DEBUG_WINDOW_BEFORE_S = 15
DEBUG_WINDOW_AFTER_S = 200


def station_probability(df):
    df = df.sort_values("timestamp")
    amp = df["seismic_amplitude"].abs().reset_index(drop=True)
    sta = amp.rolling(STA_SAMPLES, min_periods=STA_SAMPLES).mean()
    lta = amp.rolling(LTA_SAMPLES, min_periods=LTA_SAMPLES).mean().replace(0, np.nan)
    ratio = (sta / lta).fillna(0.0)
    probability = sigmoid(ratio - TRIGGER_RATIO, k=SIGMOID_K)
    return pd.DataFrame({"timestamp": df.timestamp.values, "ratio": ratio.values, "probability": probability.values})


def find_confirmed_trigger(events):
    """events: sorted list of (timestamp, station_id) crossings. Returns (confirm_time, stations) or None."""
    for i in range(len(events)):
        window_start = events[i][0]
        window_end = window_start + pd.Timedelta(seconds=CONFIRM_WINDOW_SECONDS)
        in_window = [e for e in events[i:] if e[0] <= window_end]
        stations_in_window = {sid for _, sid in in_window}
        if len(stations_in_window) >= MIN_STATIONS:
            confirm_time = max(t for t, sid in in_window if sid in stations_in_window)
            return confirm_time, sorted(stations_in_window)
    return None, []


def main():
    raw = pd.read_csv(OUT_DIR / "earthquake_raw.csv.gz")
    raw["timestamp"] = pd.to_datetime(raw["timestamp"], format="ISO8601")
    metadata = json.load(open(OUT_DIR / "earthquake_event_metadata.json"))
    event_times = [pd.Timestamp(e["time"]) for e in metadata["events"]]

    per_station = {}
    debug_rows = []
    for sid, group in raw.groupby("station_id"):
        prob = station_probability(group)
        prob["station_id"] = sid
        per_station[sid] = prob

        prob_indexed = prob.set_index("timestamp")
        for et in event_times:
            window = prob_indexed.loc[
                et - pd.Timedelta(seconds=DEBUG_WINDOW_BEFORE_S) : et + pd.Timedelta(seconds=DEBUG_WINDOW_AFTER_S)
            ]
            if not window.empty:
                debug_rows.append(window.reset_index().assign(station_id=sid, event_time=et.isoformat()))

    pd.concat(debug_rows, ignore_index=True).drop_duplicates(["timestamp", "station_id"]).sort_values(
        ["station_id", "timestamp"]
    ).to_csv(OUT_DIR / "earthquake_probability_by_station.csv", index=False)

    all_prob = pd.concat(per_station.values(), ignore_index=True)
    crossings = sorted(
        (pd.Timestamp(t), sid)
        for t, sid in all_prob.loc[all_prob.probability >= TRIGGER_PROB, ["timestamp", "station_id"]].values.tolist()
    )
    confirm_time, confirming_stations = find_confirmed_trigger(crossings)

    binned = (
        all_prob.set_index("timestamp")
        .groupby("station_id")["probability"]
        .resample(f"{FRAME_STEP_MINUTES}min")
        .max()
        .reset_index()
    )
    regional = binned.groupby("timestamp")["probability"].max()
    regional_df = regional.rename_axis("timestamp").reset_index(name="probability")
    regional_df.to_csv(OUT_DIR / "earthquake_probability.csv", index=False)

    # UI-friendly JSON mirrors (avoids a client-side CSV parser).
    with open(OUT_DIR / "earthquake_regional_probability.json", "w") as f:
        json.dump(
            [{"timestamp": pd.Timestamp(t).isoformat(), "probability": round(float(p), 4)} for t, p in zip(regional_df.timestamp, regional_df.probability)],
            f,
        )
    frame_idx = pd.date_range(
        start=raw.timestamp.min().floor(f"{FRAME_STEP_MINUTES}min"),
        end=raw.timestamp.max().ceil(f"{FRAME_STEP_MINUTES}min"),
        freq=f"{FRAME_STEP_MINUTES}min",
    )
    station_ids = sorted(all_prob.station_id.unique())
    station_prob_frames = []
    for ts in frame_idx:
        row = binned[binned.timestamp == ts]
        stations_payload = {}
        for sid in station_ids:
            val = row[row.station_id == sid]["probability"]
            stations_payload[sid] = None if val.empty or pd.isna(val.iloc[0]) else round(float(val.iloc[0]), 4)
        station_prob_frames.append({"timestamp": ts.isoformat(), "stations": stations_payload})
    with open(OUT_DIR / "earthquake_station_probability_frames.json", "w") as f:
        json.dump(station_prob_frames, f)

    result = {
        "scenario": "earthquake",
        "model": "sta_lta_multistation",
        "params": {
            "sta_samples": STA_SAMPLES,
            "lta_samples": LTA_SAMPLES,
            "sigmoid_k": SIGMOID_K,
            "trigger_ratio": TRIGGER_RATIO,
            "trigger_probability": TRIGGER_PROB,
            "min_confirming_stations": MIN_STATIONS,
            "confirm_window_seconds": CONFIRM_WINDOW_SECONDS,
        },
        "triggered": confirm_time is not None,
    }

    if confirm_time is not None:
        at_confirm = all_prob[all_prob.timestamp == confirm_time]
        peak_row = all_prob.loc[all_prob.probability.idxmax()]
        station_lookup = {s["id"]: s for s in STATIONS}

        weights = all_prob[all_prob.station_id.isin(confirming_stations)].groupby("station_id")["probability"].max()
        lat_est = sum(weights[s] * station_lookup[s]["lat"] for s in confirming_stations) / weights.sum()
        lon_est = sum(weights[s] * station_lookup[s]["lon"] for s in confirming_stations) / weights.sum()

        result.update(
            {
                "detected_at": pd.Timestamp(confirm_time).isoformat(),
                "confirming_stations": confirming_stations,
                "probability_at_detection": round(float(at_confirm.probability.max()), 4),
                "peak_probability": round(float(peak_row.probability), 4),
                "peak_probability_at": pd.Timestamp(peak_row.timestamp).isoformat(),
                "peak_probability_station": peak_row.station_id,
                "estimated_epicenter": {"lat": round(lat_est, 4), "lon": round(lon_est, 4)},
            }
        )

    with open(OUT_DIR / "earthquake_detection_result.json", "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
