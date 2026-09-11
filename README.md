# ResQ

Phase 1 (Detection & Surveillance) of a disaster-response system: synthetic sensor data for two Sikkim disaster scenarios, statistical detection models that turn sensor streams into a disaster probability, and a web UI that plays the whole thing back as a time-lapse.

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

This covers Phase 1 only: detection (sensor fusion → probability → case creation) and the monitoring UI. Phase 2 (Search & Connectivity) and Phase 3 (Relief Delivery) are represented as explicit pending placeholders in the Case model and UI, not yet simulated.
