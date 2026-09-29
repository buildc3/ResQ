# ResQ

A live convective-storm nowcasting system — built for **SIH26084** ("Convective-scale nowcasting for Thunderstorms, Hail & Cloudbursts, 0-6hr", Ministry of Earth Sciences). Detects a storm forming *before* it matures, zones the ground for cloudburst/hail/downburst risk, and counts down time-to-impact for real towns — all SIMULATED, running against the real October 2023 Sikkim event.

A secondary "Response Module" — the project's original drone Detection → Connectivity → Relief demo — still exists unchanged, kept for reference, outside this problem statement's scope.

## Why this exists (SIH26084)

- The problem statement asks for a system that fuses radar + satellite + lightning on a common grid and flags a storm **before** it's already a storm — from cloud-top cooling and low-level convergence, ahead of reflectivity/lightning maturity.
- A concrete gap motivated this: a naive rainfall-threshold detector only fires on the *flood wave*, hours after the real rain peak — too late to be a nowcast. The convective-initiation (CI) detector exists specifically to catch the precursor signals instead.
- Four hazard outputs per the PS: lightning strike density, hail probability, downburst velocity, cloudburst rainfall threshold — computed per grid cell for the current frame.
- Real india-relevant grounding: the same October 2023 Sikkim event the project has always modeled, retold from the storm's own genesis instead of its downstream flood consequence.

```mermaid
flowchart LR
    S["Simulated radar + satellite + lightning\n(reflectivity, IR cooling, convergence)"] --> CI{{"CI detector:\nrolling z-score per grid cell"}}
    CI -->|"cluster of cells confirms"| CASE(["Convective-initiation Case\n(before radar/lightning maturity)"])
    CASE --> HZ["Hazard zoning\n(current frame): cloudburst rain,\nhail proxy, downburst proxy, lightning density"]
    CASE --> TTI["Time-to-Impact\nfor named towns"]
    TTI --> ALERT(["In-app alert log\n(SMS-style message, not dispatched)"])
```

*CI detection must fire before the storm's own ground-truth maturity time — the demo proves this with a live "N minutes before maturity" stat, not a claim.*

## What's real, what's simulated

| | Real | Simulated / proxy |
|---|---|---|
| Event | Oct 2023 Sikkim storm/flood, geography (real Teesta corridor + town coordinates) | Radar reflectivity, satellite IR, lightning flashes — no real feed |
| Detection method | Rolling z-score → sigmoid → sustained-trigger (real statistical pattern, same one used for the response module's cloudburst/earthquake models) | — |
| Cloudburst rain rate | Z-R relation (Marshall-Palmer, Z=200·R^1.6 — **not re-verified against a primary source this session, TO BE VERIFIED**) applied to simulated reflectivity | Threshold (≥100mm/hr) — **also TO BE VERIFIED against a primary IMD source** |
| Hail probability, downburst velocity | — | Explicit **PROXY** heuristics (no public labelled hail/downburst dataset for India exists to calibrate against — stated plainly in-app) |
| Lightning strike density | Direct count of simulated flashes (not a proxy) | The flashes themselves are simulated |
| Downstream GLOF flood TTI | Real formula (basin_km ÷ flood-wave speed), reused unchanged from the Response Module | — |
| Storm-cell TTI | — | Computed from this simulated event's own known track/steering vector — not a general forecast, labeled as such in the UI |
| Forecast lead time (T+10min…T+6h) | Grid + time-axis structure exists | **No forecast engine yet** — the lead-time slider shows an honest "not implemented" placeholder past T+0, never fabricated numbers |
| Real data-source adapters (INSAT, IMD DWR, lightning network) | Documented interface + schema (`web/pipeline/sources/`) | Stubs only — not wired to any live feed; access terms marked TO BE VERIFIED |

## How it's built

- 100% TypeScript/JavaScript, one Netlify-deployable package. No Python, no backend, no database.
- Convective nowcast and Response Module share one build-time pipeline and one 720-frame, 10-minute-resolution timeline — the storm is generated on the identical time grid as the flood/earthquake scenarios, so one playhead drives all three.

```
web/                Netlify-deployable npm project (netlify.toml's build base)
  pipeline/            TypeScript: sensor + storm generation, detection models, hazards, TTI
    sources/             documented real-data-adapter interface — stubs only, not wired
  data/                pipeline output (JSON) — regenerated fresh every build
  index.html/css/js    the frontend: vanilla HTML/CSS/JS + Leaflet, no framework
  qa/                  headless-browser QA (Playwright) — 71 automated checks
  README.md            architecture deep-dive: algorithms, data schema, UI wiring

netlify.toml         build = "npm run build" (base: web) — Node only
```

### Convective initiation (CI) detection

- A ~1.5km grid over the same real geography the Response Module already uses.
- A single seeded storm scenario re-tells Oct 3-4, 2023 as a convective cloudburst over the upper Teesta — cloud-top cooling and low-level convergence begin ~2-3 hours before the storm's own reflectivity/lightning maturity.
- Per grid cell: rolling z-score of cooling rate + convergence, an **adaptive per-cell threshold** calibrated from that cell's own quiet-period noise (the same calibration idea already proven in the Response Module's cloudburst/earthquake models), sigmoid → probability.
- A small cluster of neighboring cells (≥3) must confirm together — the spatial equivalent of "multiple stations must agree."
- On confirmation: a Case is created, with a live "detected N minutes before maturity" stat computed against the storm's own ground-truth maturity timestamp.

### Frontend

- Nowcast is the default view: a grid canvas layer (toggle between reflectivity, convergence, cloud-top cooling, CI probability, and current-frame hazard zoning), a Convective Initiation status panel, a Time-to-Impact panel per named town, and an in-app alert log.
- The lead-time slider (T+0…T+6h) is honest about what doesn't exist yet — past T+0 it shows a "forecast engine not yet implemented" note, never invented numbers.
- Response Module (station map, cloudburst/earthquake cases, drone Phase 1-3) is one nav tab away, fully intact, clearly labeled legacy.
- Accessible: colorblind-safe shape redundancy, full keyboard operability, `prefers-reduced-motion` support — carried over to every new control.

## Getting started

```
cd web
npm install
npm run dev   # generates data + runs detection, serves on http://localhost:8000
npm run qa    # headless-browser QA pass (71 checks)
```

- Deploy: push to a git remote, connect the repo in Netlify — `netlify.toml` handles the rest, no manual env vars needed.
- Full architecture deep-dive: **[web/README.md](web/README.md)** — file-by-file pipeline responsibilities, data schema, exact UI-to-data wiring.

## Scope

**Built (Milestone 1):** grid + time-axis structure, the simulated storm scenario, CI detection with a live before-maturity proof, current-frame hazard zoning (cloudburst/hail-proxy/downburst-proxy/lightning-density), downstream GLOF flood TTI (real) + storm-cell TTI (from simulated ground truth) + in-app alert log, and the full original Response Module (drone Detection → Connectivity → Relief), unchanged.

**Deferred to a future milestone (documented, not built):**
- General vision-based multi-frame cell tracking and a real 0-6h forecast engine that projects hazard fields forward with decaying skill (the lead-time slider's placeholder exists for this).
- A verification panel (POD/FAR/CSI skill metrics vs. lead time).
- Any ConvLSTM/U-Net model.
- Live SMS dispatch (Twilio or otherwise) — the alert log is in-app only.
- Real INSAT/IMD-DWR/lightning-network data ingestion — `web/pipeline/sources/` documents the interface but every loader is a stub.
