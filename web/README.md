# Web UI — Sikkim Disaster Detection Monitor

A single Netlify-deployable npm project: vanilla HTML/CSS/JS frontend, and a **TypeScript data pipeline that generates the synthetic sensor data and runs the detection models at build time** — no Python, no external service, no committed multi-megabyte dataset to keep in sync. `npm run build` is the entire deploy; Netlify needs nothing but Node.

## Structure

```
web/
  index.html, css/app.css, js/app.js   the UI (unchanged vanilla frontend)
  pipeline/           TypeScript data generation + detection (see below)
  data/               output of `npm run generate-data` — committed to git as a fallback, but regenerated fresh on every build
  qa/smoke-test.mjs   headless-browser QA pass (Playwright)
  qa/run.mjs          starts a local server, runs the smoke test, tears it down
  tsconfig.json
  package.json
```

### The pipeline (`pipeline/`)

| File | Role |
|---|---|
| `stations.ts` | 7-station registry (real Sikkim locations) + epicenter + sim window constants |
| `rng.ts` | Seeded PRNG (mulberry32) — Node has no built-in seedable random |
| `mathUtils.ts` | Haversine distance, rolling mean/std/z-score, sigmoid, waveform helpers, naive-timestamp arithmetic |
| `cloudburst.ts` | Generates the cloudburst/GLOF sensor series **and** runs the rolling z-score fusion detector on it, in one pass |
| `earthquake.ts` | Generates the 1Hz mainshock+aftershock seismic series **and** runs the STA/LTA detector on it |
| `damage.ts` | Simulated computer-vision damage/infrastructure assessment — a 0-10 severity index per station, fed to the frontend's heat-map layer |
| `phase2.ts` | Phase 2 (Search & Connectivity) — generates the relay-deployment and search-sweep schedules embedded in each case |
| `cases.ts` | Turns a triggered detection into a Case object (the schema the UI reads) |
| `build.ts` | Orchestrator — runs both scenarios, writes the 10 JSON files straight into `data/` |

Run it directly:
```
npm run generate-data   # tsx pipeline/build.ts
npm run typecheck       # tsc --noEmit
```

**This is a full rewrite, not a wrapper around the Python version** — it was a line-by-line, module-by-module port (same formulas, same calibrated thresholds/weights/windows, same event timeline), verified against the original by comparing outputs: trigger timestamps match exactly (`2023-10-04T01:20:00` cloudburst, `2023-10-04T09:15:12` earthquake — both depend mainly on fixed event-schedule constants, not RNG), and the same stations end up in the cloudburst corridor and earthquake confirmation set. Exact sensor values differ slightly from the old Python output since the RNG algorithm is different (mulberry32 vs numpy's PCG64) — this was never a goal; only the calibrated *behavior* needed to carry over, and it did.

One deliberate simplification versus the Python version: no intermediate CSV/debug files. Generation and detection now run on the same in-memory arrays in a single process, so there's no CSV round-trip to replicate — the pipeline emits exactly the 8 JSON files the frontend fetches, nothing else.

## Local dev

```
npm install
npm run dev        # generates data, then serves on http://localhost:8000
```

## Deploying on Netlify

The repo root has a `netlify.toml`:
```toml
[build]
  base = "web"
  publish = "."
  command = "npm run build"
```
Connect the repo in Netlify — `npm install && npm run build` runs entirely on Node (no Python, no other language runtime, no external data source). Push to the connected branch to redeploy; the data regenerates fresh every time from the pipeline source, deterministically (same seeds → same output).

## How the UI is wired to real data

- **Timeline**: both `cloudburst_frames.json` and `earthquake_frames.json` share an identical 720-entry, 10-minute grid spanning 2023-10-02 00:00 → 2023-10-06 23:50 — the UI scrubber/playhead is just an index (0-719) into that shared grid.
- **Playback speed**: a slider (log scale, 0.05×-2000×) plus two synced number inputs — type a speed multiplier directly, or type a target "finish in N seconds" and the app back-solves the multiplier (`speed = (TOTAL_FRAMES-1)/(6*seconds)`, since 6 frames/sec is the fps at 1×). Whichever field you touch last wins; the other one and the slider update to match.
- **Station risk color**: the max of each station's cloudburst and earthquake per-station probability (`*_station_probability_frames.json`, output by the detection models themselves) — not an ad-hoc UI threshold on raw sensor units.
- **Gauges**: a 5-frame rolling median of the regional probability curves, purely for a calmer live display (see QA notes below) — the underlying raw curve and all trigger/case logic are untouched.
- **Case reveal**: cases (`cases.json`) become visible in the UI the moment the timeline's current frame timestamp reaches each case's real `detected_at`.
- **Case detail → Phase 1**: real model name/params/summary, the actual contributing/corridor stations, and real sensor readings at the detection frame.
- **Case detail → Phase 2 (Search & Connectivity)**: fully simulated, not a placeholder. `pipeline/phase2.ts` generates, per case, a relay-deployment schedule (Network Extender drones daisy-chaining from the edge of the still-working network into the disaster corridor, one hop at a time — ordered by descending basin_km for the cloudburst corridor, or by ascending distance from the epicenter for the earthquake) and a search-sweep schedule per affected zone (start/complete times, a bounded random survivor count with individual discovery timestamps). Phase 2 has no separate detection model of its own — **all of its live state (pending/active/complete, connectivity %, survivors found so far) is derived purely by comparing the current playhead timestamp against these real schedule timestamps**, the exact same pattern Phase 1's case-reveal already uses. `computePhase2()` in `app.js` is the single source of truth for this, called fresh every render tick so progress keeps advancing while you're looking at either the Cases list or an open Case Detail during playback — not just the instant you open it. Relay markers appear on the live Monitor map the moment their real `deploy_at` passes (and stay — a landed relay doesn't move), with a dashed line tracing the growing chain; a station pulses blue while its search zone is actively being swept.
- Phase 3 remains an explicit placeholder — not simulated yet.
- **Damage heat map**: a hand-rolled canvas heat layer (`createHeatCanvas` in `app.js`) — a real soft, full-coverage green→yellow→orange→red gradient wash, toggleable via the `Damage heat map` checkbox bottom-right, plus a static miniature version (CSS-blurred blobs at each station's real relative position) in Case Detail's Phase 1 tab. This simulates a computer-vision damage-assessment pass — there's no real imagery, so severity (0-10) comes directly from each station's own ("tower") raw physical sensor magnitude: rainfall + water-level rise for cloudburst, seismic amplitude for earthquake (`pipeline/damage.ts`). It's deliberately a separate metric from the detection probability above it — one answers "is this statistically anomalous," the other "how physically severe does it look" — not the same signal recolored.

  This went through two third-party-library attempts first (`leaflet.heat`), both abandoned after producing artifacts that trace back to the plugin's undocumented internals: an intensity normalization that turned out to be zoom-dependent (workaround: stack overlapping points — itself then interacted badly with the plugin's other undocumented behavior, a low-zoom cell-bucketing optimization, producing visible hard rectangular/circular seams once station influence radii overlapped). The custom renderer draws each station as a true canvas `createRadialGradient` on an offscreen alpha buffer (composited with `'lighter'` so overlapping stations sum smoothly, no grid bucketing anywhere), then colorizes the accumulated alpha through the same gradient used for the legend. Full control, no hidden internals, no seams.

Timestamps are treated as plain fixed-width ISO strings throughout (never parsed through `Date()` in the browser), since they're naive local (Sikkim) times with no timezone suffix. The pipeline's own date arithmetic uses `Date.UTC()`/`getUTC*()` consistently as an arbitrary internal representation — never the visitor's local timezone — so generation is reproducible regardless of where `npm run build` executes (a real concern once Netlify runs it in some unknown-timezone build container).

## QA

```
npm run qa
```
Runs a headless-Chromium (Playwright) pass against the real served app — see inline comments in `qa/smoke-test.mjs` for exactly what's checked. Screenshots land in `qa/shots/` (gitignored).

This suite (plus the TS pipeline's own output comparison against the original Python version) caught real bugs during development; see git history / prior notes for the pre-TypeScript-rewrite bug list (fractional frame-index lookups, a Leaflet blend-mode isolation issue, an under-sized STA window, mobile header overflow, a `[hidden]` CSS-specificity bug). All fixes carried forward into this version.

## What happened to the Python pipeline?

`data-pipeline/` (Python) is still in the repo, untouched, but **no longer used by anything** — the deployment is now 100% TypeScript/Node. It's kept only because deleting validated work that was never committed to git is unrecoverable; delete it whenever you're comfortable doing so (`rm -rf data-pipeline requirements.txt` at the repo root, plus the `.venv/` entry in `.gitignore` if you don't keep any other Python around).
