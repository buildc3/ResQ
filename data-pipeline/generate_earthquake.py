"""Synthetic sensor data generator: earthquake scenario.

A hypothetical mainshock + aftershock sequence on a synthetic North-Sikkim
epicenter, independent of the cloudburst scenario, over the same Oct 2-6 2023
demo window. Not tied to any real recorded earthquake.

Ambient seismic noise is generated continuously at 1Hz for the full 5 days
(not a sparse baseline switched to dense bursts) and event wavelets are
superimposed on top of it, matching how a real seismometer's signal is noise
plus event, continuously sampled. An earlier mixed-resolution version (sparse
baseline held flat, dense bursts spliced in) produced artificial step-jumps
at every resolution change that a ratio-based detector misread as events —
continuous generation avoids that class of artifact entirely.

Per-station P-wave arrival lag and amplitude attenuation are both a function
of great-circle distance from the synthetic epicenter. Aftershock timing
follows an Omori-law-like decay (many soon after the mainshock, tapering off
over ~48h); magnitudes decay similarly with noise.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from stations import STATIONS, SIM_START, SIM_END, EARTHQUAKE_EPICENTER
from utils import haversine_km, damped_sine_burst

OUT_DIR = Path(__file__).parent / "output"
STEP_SECONDS = 1
SEED = 7

ORIGIN_TIME = pd.Timestamp("2023-10-04 09:15:00")
P_WAVE_KM_PER_S = 6.0
ATTENUATION_KM = 20.0
MAINSHOCK_AMPLITUDE = 1.0
MAINSHOCK_DURATION_S = 180
N_AFTERSHOCKS = 18
AFTERSHOCK_WINDOW_HOURS = 48.0
AMBIENT_NOISE_STD = 0.02


def attenuated_amplitude(base_amplitude, distance_km):
    return base_amplitude / (1 + distance_km / ATTENUATION_KM)


def build_event_catalog(rng):
    """Mainshock + Omori-decayed aftershocks: list of (time, amplitude, duration_s)."""
    events = [{"time": ORIGIN_TIME, "amplitude": MAINSHOCK_AMPLITUDE, "duration_s": MAINSHOCK_DURATION_S, "kind": "mainshock"}]
    u = np.sort(rng.uniform(0.05, 1.0, N_AFTERSHOCKS))  # avoid near-zero offsets colliding with the mainshock
    offset_hours = AFTERSHOCK_WINDOW_HOURS * u ** 3  # skew early, Omori-like clustering
    for oh in offset_hours:
        amp = MAINSHOCK_AMPLITUDE * 0.5 * np.exp(-oh / 10.0) * rng.uniform(0.3, 1.0)
        dur = int(np.clip(30 + 60 * (amp / MAINSHOCK_AMPLITUDE), 20, 90))
        events.append(
            {
                "time": ORIGIN_TIME + pd.Timedelta(hours=oh),
                "amplitude": max(amp, 0.03),
                "duration_s": dur,
                "kind": "aftershock",
            }
        )
    return events


def build_station_series(station, events, full_index, rng):
    distance_km = haversine_km(station["lat"], station["lon"], EARTHQUAKE_EPICENTER["lat"], EARTHQUAKE_EPICENTER["lon"])
    n = len(full_index)
    amplitude = np.abs(rng.normal(0, AMBIENT_NOISE_STD, n))

    for ev in events:
        lag_s = distance_km / P_WAVE_KM_PER_S
        arrival = ev["time"] + pd.Timedelta(seconds=lag_s)
        amp_at_station = attenuated_amplitude(ev["amplitude"], distance_km)
        wave = damped_sine_burst(
            n_samples=ev["duration_s"],
            sample_rate_hz=1.0 / STEP_SECONDS,
            amplitude=amp_at_station,
            freq_hz=rng.uniform(1.0, 2.5),
            decay_per_s=3.0 / ev["duration_s"],
            rng=rng,
        )
        start_pos = full_index.searchsorted(arrival)
        end_pos = min(start_pos + len(wave), n)
        amplitude[start_pos:end_pos] += wave[: end_pos - start_pos]

    return pd.DataFrame(
        {
            "timestamp": full_index,
            "seismic_amplitude": np.round(amplitude, 5),
            "station_id": station["id"],
            "station_name": station["name"],
            "lat": station["lat"],
            "lon": station["lon"],
            "distance_from_epicenter_km": round(distance_km, 2),
        }
    )


def main():
    OUT_DIR.mkdir(exist_ok=True)
    full_index = pd.date_range(start=SIM_START, end=SIM_END, freq=f"{STEP_SECONDS}s")
    rng = np.random.default_rng(SEED)

    events = build_event_catalog(rng)
    station_series = [build_station_series(s, events, full_index, rng) for s in STATIONS]
    raw = pd.concat(station_series, ignore_index=True).sort_values(["timestamp", "station_id"])
    raw.to_csv(OUT_DIR / "earthquake_raw.csv.gz", index=False, compression="gzip")

    frame_step = 10
    frame_idx = pd.date_range(start=SIM_START, end=SIM_END, freq=f"{frame_step}min")
    binned = (
        raw.set_index("timestamp")
        .groupby("station_id")["seismic_amplitude"]
        .resample(f"{frame_step}min")
        .max()
        .reset_index()
    )
    ui_frames = []
    for ts in frame_idx:
        row = binned[binned.timestamp == ts]
        stations_payload = {}
        for s in STATIONS:
            val = row[row.station_id == s["id"]]["seismic_amplitude"]
            stations_payload[s["id"]] = {"seismic_amplitude": None if val.empty or pd.isna(val.iloc[0]) else float(val.iloc[0])}
        ui_frames.append({"timestamp": ts.isoformat(), "stations": stations_payload})
    with open(OUT_DIR / "earthquake_frames.json", "w") as f:
        json.dump(ui_frames, f, indent=2)

    metadata = {
        "scenario": "earthquake",
        "label": "Synthetic North Sikkim mainshock + aftershock sequence",
        "sim_start": SIM_START,
        "sim_end": SIM_END,
        "epicenter": EARTHQUAKE_EPICENTER,
        "origin_time": ORIGIN_TIME.isoformat(),
        "p_wave_km_per_s": P_WAVE_KM_PER_S,
        "n_aftershocks": N_AFTERSHOCKS,
        "aftershock_window_hours": AFTERSHOCK_WINDOW_HOURS,
        "ambient_noise_std": AMBIENT_NOISE_STD,
        "events": [
            {"time": e["time"].isoformat(), "amplitude": round(e["amplitude"], 4), "kind": e["kind"]}
            for e in events
        ],
        "station_distances_km": {
            s["id"]: round(haversine_km(s["lat"], s["lon"], EARTHQUAKE_EPICENTER["lat"], EARTHQUAKE_EPICENTER["lon"]), 2)
            for s in STATIONS
        },
        "seed": SEED,
        "disclaimer": "Synthetic values for demo purposes; not a real recorded earthquake.",
    }
    with open(OUT_DIR / "earthquake_event_metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"rows: {len(raw)}  stations: {raw.station_id.nunique()}")
    print(f"mainshock + {N_AFTERSHOCKS} aftershocks; peak amplitude by station:")
    print(raw.groupby("station_id")["seismic_amplitude"].max().sort_values(ascending=False))


if __name__ == "__main__":
    main()
