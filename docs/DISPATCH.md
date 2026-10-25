# The dispatch brain: how the Chipata distribution centre decides what to send

Code: `src/lib/dispatch/plan.ts` (the rules), `src/lib/dispatch/state.ts` (reads the live network), `src/lib/dispatch/explain.ts` (words), `src/app/api/dispatch/{plan,execute,log}/route.ts` (the API), the "Dispatch" section at the top of `/government`.

No model makes a decision. The planner is deterministic: the same shelves, visits, forecast and fleet always give the same plan. Claude is only asked, on request, to word the explanation (the same pattern as the officer's briefing).

## What it reads

| Input | Where from |
|---|---|
| Every post's shelf against what it must hold (`MIN_STOCK`, the same numbers as the module and the government table) | SpacetimeDB `stock`, `village` |
| What is already on its way (undelivered restocks) and what pods have asked for (undelivered patient orders) | `delivery_order` |
| Red visits open at a post (in the last 2 hours, or while their order is still moving) | `visit` |
| Who is due a vaccine dose at each post (Zambia's schedule) | `patient` |
| The season calendar: when the rains usually start, the weeks that usually close the road, cut-off days a month, the malaria peak | `GET /api/weather/seasons` (ten years of ERA5 rain; down → no seasonal shipments, the plan says so in `seasonSource`) |
| Malaria outlook six weeks out, flood risk today and over the fortnight, the day the roads may close and why, rain forecast | `GET /api/weather/outlook` (Open-Meteo forecast, GloFAS river, satellite flood water). If that route is down, the planner reads the last 30 days from `GET /api/satellite` forward: rain and warm nights now mean malaria in 2–6 weeks, a very wet day means the road is at risk, and the next fortnight is assumed like the last. |
| The fleet: name, kind, operator, base, capacity, speed, cost, status | SpacetimeDB `carrier` (ZAMMSA trucks, district pickups, CHA motorbikes, CHW bicycles, Luangwa boats, proposed drones). If the table is not published, the planner's own list of the same real fleet (`fallbackFleet`). |

## The rules, in order

1. **Emergency** — a red visit is open at the post, or a life-saving item is at zero (rectal artesunate, ceftriaxone, ORS, ACT). Send **now**, by the **fastest** carrier that can carry the load and reach the post. The shipment replaces what the pod's own order took and fills every life-saving item back to its target. A post whose road is under water is only served by boat or drone.
2. **Urgent** — a pod asked and the order has not landed, with no red visit: today, fastest carrier.
3. **Pre-position** — the weather route names a day inside 14 days when the roads may close, and the demand expected over a 3-week closure is more than the shelf holds. Demand = population × weekly rate × 3 weeks, where the malaria rate is 1 / 3.5 / 8 cases per 1,000 per week for a low / medium / high outlook (Eastern Province runs about 300 cases per 1,000 a year), tests are 1.5 per case, severe cases 5%, plus diarrhoea (ORS, zinc) at 3 per 1,000 per week when standing water is around, pneumonia (amoxicillin) and every vaccine dose due. Send by two days before the closure, cheapest carrier.
3b. **Pre-position (seasonal)** — from the ten-year calendar (`GET /api/weather/seasons`, docs/WEATHER.md),
   not the 16-day forecast: when a post's typical closure weeks begin within **6 weeks**
   (`SEASON_HORIZON_DAYS` = 42) and the closure has not ended, stock it for its usual cut-off days
   (`ceil(cutOffDaysInSeason / 7) + 1` weeks, never under 3 nor over 8) at the **high** malaria rate when the
   malaria peak falls inside the closure window (else at least medium), diarrhoea at the wet rate, pneumonia
   and every vaccine dose due. `sendBy` = first closure week − 7 days (`SEASON_LEAD_DAYS`); if that has
   passed, today ("send now"). Priority "pre-position (seasonal)", ranked below forecast pre-positioning
   and above routine; skipped where the forecast rule already made a shipment for the post. Rides the
   batched runs like routine.

   On 24 Oct 2026 the plan shows **2 seasonal shipments**, both in the Luangwa valley where the closure
   weeks start 25 Nov (31 days away): Mfuwe (10,000 people; 476 malaria tests, 14 rectal artesunate,
   72 zinc, 251 paracetamol, 60 amoxicillin; 4 weeks for its 18 cut-off days; malaria peak 13 Jan → 10 Mar
   inside the closure, so the high rate) and Kakumbi, both **send by 18 Nov**, on run F with the Mambwe
   DHO pickup. Every other post's road usually closes from 16–30 Dec or later, so their seasonal
   shipments fall due from 9 Nov onward (the planner's wording says which is first). Nothing is "due now"
   on 24 Oct; a 6-week horizon with rains that start in late November means the first trucks leave in
   mid-November.

4. **Outbreak outlook** — a medium outlook raises the post's targets for malaria tests, ACT, rectal artesunate and the R21 vaccine by 1.5×, a high outlook by 2×. (Bed nets are not a tracked stock item; add one to the module if the province wants them planned too.)
5. **Routine** — top every other item up to its (raised) minimum, within a week. Routine and pre-position shipments are batched into **one run per area** (each post is grouped with the nearest district centre): a ZAMMSA truck out of Chipata or that district's own pickup (which first drives to the hub to load), whichever costs less for the whole trip. Pickups from other districts stay home.
6. **Weights and what can fly** — every unit has a weight (`ITEM_KG`; a vaccine shipment adds a 2.5 kg cold box). A carrier is only picked when the load fits. Oxygen, IV fluids and blood never go by drone (and posts never hold them). Drones in the table are a *proposed* partner: never relied on while anything real can reach the post, but every shipment says what a drone would have done ("would do it in 42 min, 68 min sooner").
7. **Stock to send from** — the hub first; a post with idle surplus lends instead when it is nearer than the hub and keeps at least twice its own minimum (the real Zambian pattern: Lundazi and Petauke sit on last quarter's push). Items nobody has are listed under "could not be met".
8. **The fleet's day** — each carrier has 10 hours of driving; the plan spreads emergencies and runs across the fleet and says how many trips fall outside today.

Ranking: emergencies (red visit first, then the number of life-saving items at zero, then a cut-off post, then population) > urgent > pre-position (sooner closure, higher risk, worse outlook, more people) > pre-position (seasonal) (sooner closure, malaria peak inside it, more cut-off days, more people) > routine (more items at zero, worse outlook).

**Emergency mode** (the red banner) is on when any post is cut off or any red visit is open.

## The API

- `POST /api/dispatch/plan` `{ explain?: "claude" }` → `{ plan, explanation, explainedBy }`. `GET` works too. The plan is saved to `data/dispatch.json`.
- `POST /api/dispatch/execute` `{ shipmentIds: ["emergency-10", ...] }` or `{ which: "urgent" | "all" }` → places the orders, asks `/api/routes/plan` for a route for each new order, writes one `Dispatch planner` line per shipment with `log_agent`, and returns `{ executed, orders, routed, logged, notes }`. Shipment ids are `${priority}-${villageId}`, so the plan is recomputed from the live tables at execution and the shipment is placed as it stands then.
- `GET /api/dispatch/log` → the planner's lines from `agent_log` merged with its file, newest first.

## The Season calendar strip

Under "Roads: cut-off countdown" in the Dispatch section: one row per post whose road usually
closes, sorted by closure date. The bar runs 1 October → 30 June: the wet season in blue, each
typical closure week in red (darker where more of the ten years closed), a dotted green line where the
malaria peak begins, an amber tick at the seasonal send-by date, a white line for today; the label
gives the closure start and the usual cut-off days a season. A violet dot marks posts whose seasonal
shipment is in the plan. Hover a row for the dates and the confidence. The footer says how many
seasonal shipments are due, or which post's road closes first and when its truck must leave.

## Execute and the routes

- `restock` exists in the module as `restock(toVillageId, fromVillageId, item, qty, reason)`; execute
  now calls it with five arguments (it used to send four and was refused), passing the lender the plan
  chose or the hub. No visit rows are added any more.
- Orders whose shipments ride one batched run with **two or more posts** are planned together as a
  multi-stop run (`POST /api/routes/plan { run }`, docs/ROUTES.md): one road from the base through the
  stops in nearest-neighbour-then-2-opt order, one route_plan per order with "run A stop 2 of 4" in
  its reason, drawn once on the Routes page. The execute answer lists them in `notes` and `runs`.
  Checked 24 Oct 2026: run A (Katete, Kagoro, Kafumbwe) placed 50 restock orders and one 144.4 km
  road, ~204 min by the Chipata DHO pickup.

## What is stubbed today

- When `log_agent` is missing the lines go to `data/dispatch.json` and the pages show them from there; when `/api/routes/plan` is missing orders are placed without a route.
- The seasonal calendar is estimated from a reanalysis (docs/WEATHER.md): the district's own record of closures should replace its two tuning constants.

## Asks for the module

- Optional: a `bed net` stock item, so rule 4 can raise nets too.
