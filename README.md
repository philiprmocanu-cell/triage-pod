# Triage Pod

Built at Cal Hacks. An AI triage nurse for village health posts: it watches, listens in the
patient's own language (Grok Voice), asks follow-up questions like a nurse, and tells
the doctor network what the patient needs. Across the network it forecasts supply needs and
proposes drone transfers before posts run out.

See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Run

```bash
cp .env.example .env.local   # add XAI_API_KEY (Grok Voice) and ANTHROPIC_API_KEY
npm install
npm run dev
```

Mac app (native window, no browser tab):

```bash
npm run app          # from this folder
npm run app:pack     # builds dist-app/mac-arm64/Triage Pod.app
```

The packaged app still uses this project folder (Next.js, `.env.local`, SpacetimeDB). Double-click it; it starts the local stack and opens a window.
