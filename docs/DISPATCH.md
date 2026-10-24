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
| Malaria outlook six weeks out, flood risk today and over the fortnight, the day the roads may close and why, rain forecast | `GET /api/weather/outlook` (Open-Meteo forecast, GloFAS river, satellite flood water). If that route is down, the planner reads the last 30 days from `GET /api/satellite` forward: rain and warm nights now mean malaria in 2–6 weeks, a very wet day means the road is at risk, and the next fortnight is assumed like the last. |
| The fleet: name, kind, operator, base, capacity, speed, cost, status | SpacetimeDB `carrier` (ZAMMSA trucks, district pickups, CHA motorbikes, CHW bicycles, Luangwa boats, proposed drones). If the table is not published, the planner's own list of the same real fleet (`fallbackFleet`). |

## The rules, in order

1. **Emergency** — a red visit is open at the post, or a life-saving item is at zero (rectal artesunate, ceftriaxone, ORS, ACT). Send **now**, by the **fastest** carrier that can carry the load and reach the post. The shipment replaces what the pod's own order took and fills every life-saving item back to its target. A post whose road is under water is only served by boat or drone.
2. **Urgent** — a pod asked and the order has not landed, with no red visit: today, fastest carrier.
3. **Pre-position** — the weather route names a day inside 14 days when the roads may close, and the demand expected over a 3-week closure is more than the shelf holds. Demand = population × weekly rate × 3 weeks, where the malaria rate is 1 / 3.5 / 8 cases per 1,000 per week for a low / medium / high outlook (Eastern Province runs about 300 cases per 1,000 a year), tests are 1.5 per case, severe cases 5%, plus diarrhoea (ORS, zinc) at 3 per 1,000 per week when standing water is around, pneumonia (amoxicillin) and every vaccine dose due. Send by two days before the closure, cheapest carrier.
4. **Outbreak outlook** — a medium outlook raises the post's targets for malaria tests, ACT, rectal artesunate and the R21 vaccine by 1.5×, a high outlook by 2×. (Bed nets are not a tracked stock item; add one to the module if the province wants them planned too.)
5. **Routine** — top every other item up to its (raised) minimum, within a week. Routine and pre-position shipments are batched into **one run per area** (each post is grouped with the nearest district centre): a ZAMMSA truck out of Chipata or that district's own pickup (which first drives to the hub to load), whichever costs less for the whole trip. Pickups from other districts stay home.
6. **Weights and what can fly** — every unit has a weight (`ITEM_KG`; a vaccine shipment adds a 2.5 kg cold box). A carrier is only picked when the load fits. Oxygen, IV fluids and blood never go by drone (and posts never hold them). Drones in the table are a *proposed* partner: never relied on while anything real can reach the post, but every shipment says what a drone would have done ("would do it in 42 min, 68 min sooner").
7. **Stock to send from** — the hub first; a post with idle surplus lends instead when it is nearer than the hub and keeps at least twice its own minimum (the real Zambian pattern: Lundazi and Petauke sit on last quarter's push). Items nobody has are listed under "could not be met".
8. **The fleet's day** — each carrier has 10 hours of driving; the plan spreads emergencies and runs across the fleet and says how many trips fall outside today.

Ranking: emergencies (red visit first, then the number of life-saving items at zero, then a cut-off post, then population) > urgent > pre-position (sooner closure, higher risk, worse outlook, more people) > routine (more items at zero, worse outlook).

**Emergency mode** (the red banner) is on when any post is cut off or any red visit is open.

## The API

- `POST /api/dispatch/plan` `{ explain?: "claude" }` → `{ plan, explanation, explainedBy }`. `GET` works too. The plan is saved to `data/dispatch.json`.
- `POST /api/dispatch/execute` `{ shipmentIds: ["emergency-10", ...] }` or `{ which: "urgent" | "all" }` → places the orders, asks `/api/routes/plan` for a route for each new order, writes one `Dispatch planner` line per shipment with `log_agent`, and returns `{ executed, orders, routed, logged, notes }`. Shipment ids are `${priority}-${villageId}`, so the plan is recomputed from the live tables at execution and the shipment is placed as it stands then.
- `GET /api/dispatch/log` → the planner's lines from `agent_log` merged with its file, newest first.

## What is stubbed today

- The module has no `restock(toVillageId, item, qty, reason)` reducer. Execute places each shipment through `report_visit` with patient name "<post> health post pre-position", urgency green: the module then creates `kind: patient` orders from the nearest place that has the item and **adds a green visit row** for the post (it shows up in the patient count). The source village the plan chose (a lender's idle stock) cannot be honoured on this path; `report_visit` picks its own. Village names are matched loosely by the module ("Lumezi Mission" can land on "Lumezi"); execute checks that an order appeared for the right post and says so if not.
- When `log_agent` is missing the lines go to `data/dispatch.json` and the pages show them from there; when `/api/routes/plan` is missing orders are placed without a route.

## Asks for the module (Routes agent)

- `restock(toVillageId: u32, item: string, qty: u32, reason: string)` — creates one `kind: restock` order to the post (source: the hub, or the nearest post with enough stock), no visit row. With it, execute stops using `report_visit` and the lender choice can be honoured (add an optional `fromVillageId`).
- Optional: a `bed net` stock item, so rule 4 can raise nets too.
