# Routes and carriers

The **Routes** tab (`/routes`) shows who carries every delivery and which road it follows, straight
from two SpacetimeDB tables (`carrier`, `route_plan`) plus `delivery_order` and `village`. Lines are
drawn on real roads and turn red where the flood check said *high*.

## What Zambia actually uses (and what we seeded)

| Kind | Operator in the table | Why it is there | Source |
| --- | --- | --- | --- |
| Truck ×3 (two hub trucks, one cold-chain van) | `ZAMMSA`, based at Chipata (hub) | ZAMMSA (Zambia Medicines and Medical Supplies Agency) runs regional hubs, Chipata among them, and trucks stock from the hub to district health offices and facilities. Its last-mile distribution has been tendered through the USAID PASCO programme (Chemonics). | [Chemonics RFP 465.002, last-mile distribution, Lusaka origin](https://chemonics.com/procurements/rfp-465-002-in-country-last-mile-distribution-of-health-commodities-lusaka-origin), [Chemonics RFP 465.001, hub level](https://chemonics.com/procurements/rfp-465-001-in-country-last-mile-distribution-of-health-commodities-hub-level), [UNDP: Chipata storage](https://www.undp.org/zambia/blog/building-resilient-health-system-one-warehouse-time), [USAID PASCO factsheet](https://uatweb.usaid.gov/sites/default/files/2024-09/PASCO-2024-Factsheet.pdf), [Zambia Monitor, hub dispatch](https://www.zambiamonitor.com/agency-initiates-k700-million-drug-distribution-to-rectify-stock-imbalances-in-hospitals/) |
| Pickup ×12 | `District Health Office <district>` (Chipata, Katete, Petauke, Sinda, Nyimba, Lundazi, Chadiza, Mambwe, Vubwi, Chama, Lumezi, Kasenengwa) | District Health Offices run the Land Cruiser / Hilux class vehicles that reach rural posts from the district town. One per district in the demo. | [PDU Zambia, Zimba district delivery](https://www.pdu.gov.zm/blog/stronger-rural-healthcare-in-zimba-a-story-of-partnership-and-delivery) |
| Motorbike ×7 | `CHA` (Community Health Assistants) at district towns | Riders for Health ran the Eastern and Southern Province motorbike fleet and its maintenance 2009-2016; the model stayed with the Ministry of Health. | [Borgen Project, motorcycle ambulances in Zambia](https://borgenproject.org/motorcycle-ambulances-in-zambia/), [Riders for Health background](https://atlantablackstar.com/2015/01/31/africa-group-using-motorcycles-deliver-health-care/) |
| Bicycle ×6 | `Community health worker (Buffalo bicycle)` at rural posts | World Bicycle Relief / World Vision / Orbis bicycle programmes for community health workers; a Mumbwa trial showed six more patient trips a month with a bicycle. | [Amref newsroom, bicycles as health equipment](https://newsroom.amref.org/blog/2025/11/bicycles-as-health-equipment-new-evidence-from-zambia-shows-mobility-strengthens-primary-care/), [World Vision Zambia bicycles](https://www.wvi.org/stories/zambia/world-vision-zambia-empowers-community-health-workers-bicycles) |
| Boat ×2 | `District Health Office Mambwe` / `Chama` (banana boats on the Luangwa) | Where the rains cut valley posts off from the road, the district crosses by boat. Seeded at Mfuwe and Chama, the two Luangwa valley districts in the demo. | Local practice; no national fleet list exists. |
| Drone ×2 | `proposed partner` | **No drone fleet operates in Zambia today.** A 2017 Ministry trial never went live and Zipline does not list Zambia among its countries. Drones are seeded so the plan can show what a partner would add, and the planner only picks one when a road is flooded and nothing on the ground can carry the load. | [Lusaka Times 2017, drone trial](https://www.lusakatimes.com/2017/01/17/zambia-start-using-drones-deliver-medicines-rural-areas/), [Zipline overview](https://en.wikipedia.org/wiki/Zipline_(drone_delivery_company)) |

Capacity, speed and cost per km are rough working numbers (ZMW/km), not quotes.

## Backend (SpacetimeDB module, `spacetime/spacetimedb/src/index.ts`)

- `carrier` (id, name, kind truck|pickup|motorbike|bicycle|boat|drone, operator, baseVillageId, capacityKg, speedKmh, costPerKm, status idle|out|down). Seeded on `init` and `reset_demo`.
- `route_plan` (id, orderId, carrierId, waypoints JSON `[[lat,lng],...]`, km, minutes, floodRisk low|medium|high, status planned|moving|done|rerouted, reason, createdAt). One plan per order.
- Reducer `plan_route(orderId, carrierId, waypoints, km, minutes, floodRisk, reason)`: replaces the order's plan; a reason starting with "Rerouted" (or a changed carrier/path) marks it `rerouted`; frees the old carrier.
- Reducer `log_agent(agent, villageName, text)`: a line in `agent_log`, village matched loosely like `report_visit`, 0 when none.
- `tick`: when an order departs its plan goes `moving` and the carrier `out`; when delivered the plan goes `done` and the carrier back to `idle` (if nothing else of theirs is moving).
- `reset_demo` clears `route_plan` and re-seeds `carrier`.

Helpers in `src/lib/spacetime.ts`: `planRoute({...})`, `logAgent(agent, village, text)`, `sqlRows(query)`.

## Roads

`src/lib/routes/router.ts`, in order:

1. **Google Routes API** when `GOOGLE_MAPS_API_KEY` is set in `.env.local` (not set today).
2. **OSRM public demo server** (OpenStreetMap roads, keyless, rate-limited): one request at a time with a pause, every pair cached in `data/routes.json`. The 39 hub-to-post roads are cached already (`POST /api/routes/warm`; `{ "pairs": "all" }` adds every post-to-post pair, several minutes). Post-to-post legs are otherwise fetched the first time they are needed.
3. **Straight line ×1.5** when neither answers.

Times come from each carrier's speed (`minutesFor`), not from the router's car time.

## Flooding

`src/lib/routes/flood.ts` calls the weather agent's `GET /api/weather/road?from=lat,lng&to=lat,lng` (`{ risk, reasons[] }`). If that route is missing or down the leg is treated as low with a note saying so. On top sits the test switch (`data/floods.json`): a leg starting or ending within 25 km of a flooded village is high.

When a leg is high the planner (`src/lib/routes/planner.ts`):
1. asks the router for an alternative road (`alternatives=true`) and checks both halves of it; if dry, uses it (`rerouted`);
2. otherwise switches to a carrier that does not need the road: motorbike (tracks), then boat (Luangwa posts), then drone (proposed, only if nothing on the ground can carry the weight), marked `rerouted` with the reason;
3. a heavy item (oxygen, IV fluids) with no alternative stays with the road vehicle, flood risk high, "waits for the water to drop".

## API

- `POST /api/routes/plan { orderId }` plans one order; `{ all: true }` every open order without a plan; `{ all: true, replan: true }` all of them again.
- `GET /api/routes` all plans with carriers and orders, router in use, cached pairs, flooded roads.
- `POST /api/routes/flood { village, on }` the test switch; re-plans every open order. `GET` lists flooded roads.
- `POST /api/routes/warm` fills the road cache.

## Carrier choice

Heavy items go by truck or pickup only. Anything else goes with the quickest idle carrier that can carry the weight, counting the drive from its base to the pickup point (a busy carrier is penalised an hour), cost per km as the tie-break. Within one village it is the village bicycle or motorbike. Drones are never picked on a dry day.
