# Triage Pod

Built at Cal Hacks. An AI triage nurse for village health posts: it watches, listens in the
patient's own language and dialect (Cartesia), asks follow-up questions like a nurse, and tells
the doctor network what the patient needs. Across the network it forecasts supply needs and
proposes drone transfers before posts run out.

See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Run

```bash
cp .env.example .env.local   # add CARTESIA_API_KEY and ANTHROPIC_API_KEY
npm install
npm run dev
```
