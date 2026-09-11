# ResQ

Phases 1 and 2 of a disaster-response system: synthetic sensor data for two Sikkim disaster scenarios, statistical detection models that turn sensor streams into a disaster probability (Phase 1 — Detection & Surveillance), simulated relay-deployment and search-and-rescue schedules once a disaster is detected (Phase 2 — Search & Connectivity), and a web UI that plays the whole thing back as a time-lapse.

**100% JavaScript/TypeScript, one Netlify-deployable package.** Data generation, the detection models, and the UI all live in `web/` and run on Node — no Python, no separate services, nothing to keep in sync by hand.

## Structure

```
web/                Netlify-deployable npm project (base of netlify.toml)
  pipeline/            TypeScript: synthetic data generation + detection models -> probability + trigger
  data/                pipeline output (committed as a fallback; regenerated fresh on every build)
  index.html, css/, js/  the UI (vanilla HTML/CSS/JS + Leaflet)
  qa/                  headless-browser QA pass (Playwright)
  README.md            full details: pipeline architecture, model explanations, deploy, QA

data-pipeline/      superseded Python version — untouched, unused by the deployment, kept only
                    because it predates git history in this repo. Safe to delete; see web/README.md.

netlify.toml         build = "npm run build" (base: web) -> Node only, no other runtime needed
```

## Quickstart

```
cd web
npm install
npm run dev   # generates the synthetic data + runs detection, then serves on http://localhost:8000
```

To deploy: push to a git remote and connect the repo in Netlify — `netlify.toml` handles the rest (see `web/README.md`).

## Scope

- **Phase 1 (Detection & Surveillance)** — complete: sensor fusion → probability → case creation, plus a simulated damage/infrastructure heat map.
- **Phase 2 (Search & Connectivity)** — complete: relay-deployment daisy-chain and search-and-rescue sweeps, fully simulated and driven live off the timeline (not a placeholder).
- **Phase 3 (Relief Delivery)** — not started; represented as an explicit pending placeholder in the Case model and UI.
