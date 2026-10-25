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

The Routes page header says which it is: "Roads: OpenStreetMap (free). Add GOOGLE_MAPS_API_KEY to
.env.local for Google's live traffic and road closures." The Google path (`google()` in router.ts,
Routes API v2 `computeRoutes` with GeoJSON polylines and alternatives) is kept ready and switches
on by itself when the key exists; no key was present on 24 Oct 2026, so it is untested live.

## Road surface (what is under the wheels)

`src/lib/routes/surface.ts`, cached in `data/surfaces.json` under the same pair key as `routes.json`.
For every cached road, OSRM is asked once more for the OSM **node ids** along it
(`annotations=nodes,distance`), and the public OSM API (`api.openstreetmap.org/api/0.6/node/<id>/ways`,
keyless, about a second a call) says which way the truck is on there and its tags
(`highway=trunk|primary|secondary|tertiary|unclassified|track`, `surface=asphalt|gravel|unpaved|…`).
The road is sampled at 1 km, then every 4 km; a way already fetched covers every later sample inside
it, so the 86 km Chipata–Katete trunk road costs about ten lookups (18 s). Per route:
`{ pavedKm, gravelKm, trackKm, unknownKm, assumedKm, gravelMeasuredKm, trackMeasuredKm, worstSurface, roads[] }`.

- `assumedKm`: OSM has a road class but no `surface` tag there, so the class is guessed (trunk/primary
  paved, secondary gravel, the rest dirt/track) and the panel says so: "(8 km assumed from the road class)".
- `worstSurface` is the worst class that covers a real stretch: at least 2 km that OSM *tags* as such,
  or a quarter of the road counting the assumed km. The untagged town streets at either end of a trunk
  road do not make it a dirt road.
- Why not Overpass: `overpass-api.de` refused connections from the venue's network on 24 Oct 2026 and
  every mirror timed out or had no Zambia data; the OSM API itself answered at once.

**Folded into the flood check** (`applySurface` in flood.ts): a dirt/track road under the same rain
scores **one level worse** (low → medium, medium → high) whenever the wettest day of the trip's window
or the last 72 h reach 10 mm; gravel one level worse only once the weather alone is already medium.
Dry season: a dirt road is just a slow road. A road not yet measured is measured in the background when
first planned and counted at the next re-check.

Example, 24 Oct 2026: Chipata → Katete **85.8 km: 81 paved, 5 dirt/track (5 km assumed from the road
class)**, roads Kafula Road, T4, Luapula Road; worst surface *paved* (the 5 km are untagged town
streets). Chipata → Chama **331 km: 207 paved, 4 gravel, 120 dirt/track (13 km assumed)**, M12 then
D103 the valley road, 111 km of it tagged dirt in OSM; worst surface *track*, so under rain that leg
scores one level worse. Across the 41 measured roads (39 from the hub plus two run legs): 7 paved at worst, 3 gravel, 31 with a real dirt stretch. The
Routes side panel prints the line under every planned route.

- `GET /api/routes/surface` every measured pair; `POST { all: true }` measures every cached road
  (about 12 minutes for 40 roads, safe to repeat: hits cost nothing; `refresh: true` re-measures);
  `POST { from: [lat,lng], to: [lat,lng] }` one road now.

## Multi-stop runs

When the dispatch planner batches several posts into one truck or pickup run, execute asks
`POST /api/routes/plan { run: { id: "A", orderIds: [...], carrierId } }` (`planRun`):

1. the base is where the orders leave from (the hub, or a lending post); the stops are the distinct
   destination posts, ordered **nearest-neighbour then 2-opt** (`orderStops`, straight-line km);
2. each leg gets its own road, flood check and surface; a leg that comes back high tries the router's
   alternative road (and is marked re-routed); the run carries its worst leg;
3. **one route_plan per order**, all with the whole tour as waypoints, the run's km and minutes
   (carrier speed + 20 min a stop) and the shared id in `reason`: `run A stop 2 of 4 (Chipata → Katete → Kagoro → Kafumbwe): …`.

The Routes page groups plans by that id and draws the run **once**, with numbered teal stop markers at
each post and a "run A · stop 2/4" badge on each order's row. Example, 24 Oct 2026: run A, Chipata →
Katete → Kagoro → Kafumbwe, 50 restock orders, 28.65 kg, 144.4 km, ~204 min by the Chipata DHO pickup,
flood risk low (0 mm in 72 h, 0 mm forecast).

## What the Routes page draws

- No text on the map by default: posts are quiet grey dots (the hub green and named; small posts get
  their name only when zoomed in), **amber while an order is open for them or a pod visit is in**,
  the same rule as the live map. Clicking a road or a carrier opens a small panel at the bottom left
  (order, carrier, km, flood level, surface, the planner's reason; for a carrier, where it is and
  the roads it is on); the side list carries everything else.
- Roads are FatLine paths on the ground (`pathStroke` 0.55, a run 0.6, the picked one 0.9, done 0.4),
  coloured by carrier kind, red where the flood check said high; when one is picked the rest dim.
- Idle carriers are small dots fanned around their base post; only a moving carrier gets its letter
  icon, placed on its road from the order's own `departedAt` / `travelSeconds` with the same formula
  and clock as the live map's movers, so both pages agree on where the truck is.
- Posts, carriers, stop numbers and roads all sit at one height (`GROUND_ALT` 0.004), anchored at
  their centre, so nothing hovers over the land.
- Settlements: if `GET /api/settlements` exists (another agent's layer) every small village is drawn
  as a grey 0.15° point with no label; when it answers 404 the layer is simply skipped (it was absent
  on 24 Oct 2026).

## Automatic re-planning (the route watcher)

`POST /api/routes/recheck` (`recheckAll`) scores every `route_plan` that is not `done` against the
current `/api/weather/road` answer plus the measured surface. A leg that moved to **high** is planned
again (alternative road, else a carrier that does not need the road) and marked `rerouted`, with a
"Route watcher" line in the agent log ("Re-check: …"); a level that merely shifted (low ↔ medium) is
written on the plan without touching the carrier or the road (plans already `moving` are only touched
when they go high). Runs are checked leg by leg (the tour is in their reason) and re-planned whole.
Answer: `{ at, checked, rerouted[], changed[], errors[] }`; `GET` returns the last result.

Triggers:

| When | Who |
| --- | --- |
| every 10 minutes while the Routes page is open | the page (`RECHECK_EVERY_MS`) |
| as soon as the weather cache has been refreshed (the page polls `GET /api/weather/outlook?meta=1` every minute and re-checks when `fetchedAt` changes) | the page |
| 4 s after the page opens | the page |
| the "re-check now" button | the officer |
| a new plan, the "Plan routes" button, the flood switch | the planner, as before |

The header shows "Last re-check 17:41 · 12 routes · 1 rerouted". Measured 24 Oct 2026: 50 live routes
(one run) re-checked in 0.6 s with the weather cache warm; nothing re-routed on a dry day.

## Flooding

`src/lib/routes/flood.ts` calls the weather agent's `GET /api/weather/road?from=lat,lng&to=lat,lng` (`{ risk, reasons[] }`). If that route is missing or down the leg is treated as low with a note saying so. On top sits the test switch (`data/floods.json`): a leg starting or ending within 25 km of a flooded village is high.

When a leg is high the planner (`src/lib/routes/planner.ts`):
1. asks the router for an alternative road (`alternatives=true`) and checks both halves of it; if dry, uses it (`rerouted`);
2. otherwise switches to a carrier that does not need the road: motorbike (tracks), then boat (Luangwa posts), then drone (proposed, only if nothing on the ground can carry the weight), marked `rerouted` with the reason;
3. a heavy item (oxygen, IV fluids) with no alternative stays with the road vehicle, flood risk high, "waits for the water to drop".

## API

- `POST /api/routes/plan { orderId }` plans one order; `{ all: true }` every open order without a plan; `{ all: true, replan: true }` all of them again; `{ run: { id, orderIds[], carrierId? } }` a multi-stop run.
- `GET /api/routes` all plans with carriers and orders, each plan's `surface` (summed over the legs for a run) and `run { id, stop, of, tour }`, router in use, whether a Google key is set, cached and surfaced pairs, flooded roads, the watcher's `lastRecheck`.
- `POST /api/routes/recheck` the route watcher (above); `GET` its last result.
- `GET/POST /api/routes/surface` road surfaces (above).
- `POST /api/routes/flood { village, on }` the test switch; re-plans every open order. `GET` lists flooded roads.
- `POST /api/routes/warm` fills the road cache.

## Carrier choice

Heavy items go by truck or pickup only. Anything else goes with the quickest idle carrier that can carry the weight, counting the drive from its base to the pickup point (a busy carrier is penalised an hour), cost per km as the tie-break. Within one village it is the village bicycle or motorbike. Drones are never picked on a dry day.
