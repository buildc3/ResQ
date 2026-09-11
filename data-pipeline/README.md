# Synthetic Sensor Data — Step 1

Two independent disaster scenarios, both spanning **2023-10-02 00:00 to 2023-10-06 23:50 IST**, generated for the SkyLink Relief / ResQ Phase 1 detection pipeline and its time-lapse UI. No real sensor network of this kind was deployed during the real Sikkim event — all values are physically plausible synthetic data for demo purposes, not recorded measurements.

## Setup

```
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd data-pipeline
python export_stations.py
python generate_cloudburst.py
python generate_earthquake.py
```

## Stations (`output/stations.json`)

7 sensor stations across Sikkim (`stations.py`): Lachen, Chungthang, Mangan, Dikchu, Singtam (along the Teesta / South Lhonak Lake basin, with `basin_km` = distance downstream from the lake) plus Gangtok and Gyalshing as off-path reference stations.

## Scenario 1 — Cloudburst / GLOF (`generate_cloudburst.py`)

South-Lhonak-Lake-style glacial lake outburst flood. 10-minute resolution, all stations, for the full 5 days.

**Sensors:** `rainfall_mm_hr`, `water_level_m` (river/lake stations only), `soil_moisture_pct`, `ground_tremor_index` (0-1, landslide proxy).

**Injected event:**
- Localized cloudburst intensifies over the upper catchment (Lachen/Chungthang/Mangan get 70-90mm/hr peaks; other stations 15-30mm/hr) centered on Oct 3, 21:00.
- Landslide tremor spike at Lachen ~Oct 4, 01:30, triggering a lake-level surge/breach.
- The flood wave propagates downstream at ~15 km/h, producing a fast-rise/slow-recession hydrograph at each river station, attenuating with distance:

  | Station | Distance downstream | Surge onset |
  |---|---|---|
  | Lachen | 0 km | 01:30 |
  | Chungthang | 18 km | 02:42 |
  | Mangan | 32 km | 03:38 |
  | Dikchu | 55 km | 05:10 |
  | Singtam | 70 km | 06:10 |

**Outputs:** `cloudburst_raw.csv` (model input, long format), `cloudburst_frames.json` (uniform 10-min frames, nested by station — direct UI time-lapse input), `cloudburst_event_metadata.json` (ground-truth timings for validating the detector).

## Scenario 2 — Earthquake (`generate_earthquake.py`)

Independent synthetic mainshock + 18 Omori-decayed aftershocks over the same window, epicenter near Mangan.

**Sensor:** `seismic_amplitude`, generated continuously at 1Hz for the full 5 days (ambient noise plus superimposed event wavelets — not a mixed-resolution baseline/burst switch; see the note on why in Step 2 below). Per-station P-wave arrival lag (6 km/s) and amplitude attenuation are both distance-from-epicenter driven — verified in the output: Mangan (closest, ~4km) peaks at 0.78, decaying outward to Singtam/Gyalshing (~0.33).

**Outputs:** `earthquake_raw.csv.gz` (~3M rows at 1Hz, gzipped to ~15MB), `earthquake_frames.json` (uniform 10-min max-binned frames for the UI), `earthquake_event_metadata.json` (epicenter, origin time, full event catalog with per-event amplitude/timing).

## Step 2 — Detection models

```
python detect_cloudburst.py
python detect_earthquake.py
python generate_cases.py
```

**Cloudburst (`detect_cloudburst.py`)** — rolling z-score anomaly fusion. Per station, positive anomalies in rainfall rate, water-level rate-of-rise, and tremor are z-scored against a trailing 24h baseline (never against future data), weighted-summed, and sigmoid-mapped to a 0-1 probability. Regional probability is the max across stations; a case triggers only once it stays ≥0.8 for 3 consecutive 10-minute samples (30 min sustained). Result: **triggers 2023-10-04T01:20:00** at Lachen, 10 minutes into the tremor/surge onset, peaking at 1.0 by 01:40.

**Earthquake (`detect_earthquake.py`)** — STA/LTA trigger, the standard seismological detection algorithm (10s short-term average vs 60s long-term average; ratio ≥4 sigmoid-mapped to probability). A case triggers only once ≥2 stations cross 0.8 within 30 seconds of each other, matching real wave-propagation delay. Result: **triggers 2023-10-04T09:15:12**, 12 seconds after the true mainshock origin (09:15:00) — Chungthang and Mangan confirm first, consistent with their proximity to the epicenter. Also produces a simple amplitude-weighted-centroid epicenter estimate from the confirming stations.

Real bugs surfaced and were fixed during this step and the later enterprise QA pass, worth knowing if the models get retuned:
1. A naive time-offset rolling mean over mixed-resolution seismic data (sparse 1-min baseline + dense 1s bursts) is sample-count-weighted, not time-weighted — a single fresh burst sample could dominate a 60s window average the instant it arrived, or a random jump between two sparse baseline points could look like an event. Fixed by generating earthquake ambient noise continuously at 1Hz for the full 5 days (events superimposed on top) instead of switching resolutions.
2. `pd.read_csv(..., parse_dates=[...])` silently left the earthquake timestamp column as `object` dtype because burst timestamps carry sub-second precision while baseline ones don't (mixed format) — fixed with explicit `pd.to_datetime(..., format="ISO8601")`.
3. Even with continuous 1Hz generation, a 2-sample (2s) STA window was too small to average out half-normal ambient noise — sampling variance alone occasionally pushed the ratio above the trigger threshold by chance, giving a noisy ~30% median "quiet baseline" reading in the UI gauge. Real STA windows are similarly several seconds for exactly this reason; widened to 10 samples, dropping the quiet-period median to ~3.7%.

**Outputs:** `{scenario}_probability.csv` (10-min regional probability curve, for the UI's gauge), `{scenario}_probability_by_station.csv` (per-station detail — event-window-scoped for earthquake, since the full 1Hz series is ~3M rows), `{scenario}_detection_result.json` (trigger time, contributing stations, model params).

## Step 3 — Case generation

```
python generate_cases.py
```

Reads both `*_detection_result.json` files; for each triggered scenario, emits a `Case` object into `output/cases.json` — the artifact the future UI reads. Each case carries `phase_1` (populated: model, params, summary) plus empty `phase_2`/`phase_3` slots (`status: "pending"`) for later phases to fill in.

Note: the cloudburst case's `contributing_stations` currently lists only Lachen — the other downstream stations show real surges in the raw data but didn't individually cross the 0.8 per-station threshold against their own baseline. Worth revisiting if a wider "affected corridor" is wanted in the case location.

## Not yet built

The web app / UI — pending, after this output is reviewed.
