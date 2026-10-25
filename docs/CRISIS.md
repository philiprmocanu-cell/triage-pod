# The crisis drill: "the rainy-season week from hell"

The **Crisis** tab (`/crisis`) runs the hardest situation the province could plausibly face, on the
real tables, and shows the dispatch brain and the route planner working it out. Nothing on the page
is staged: the situation is written into SpacetimeDB by one reducer, the planners read it back like
any other day, and every number on the screen is a table row or a planner result.

Code: `spacetime/spacetimedb/src/index.ts` (tables `road_block`, `crisis`; reducers `start_crisis`,
`clear_crisis`), `src/lib/dispatch/crisis.ts` (the orchestrator and the measuring),
`src/app/api/crisis/{run,status}/route.ts`, `src/app/crisis/page.tsx`. The route planner's part is in
`src/lib/routes/flood.ts` (blocks) and `src/lib/routes/planner.ts` (unreachable stops, down carriers).

## The situation (level 3)

`start_crisis(level)` builds it in **one transaction**, so the planner meets all of it at once:

| What | Where | How it shows in the tables |
| --- | --- | --- |
| Malaria cluster (3 red, 6 yellow) | Lundazi/Chama posts: Egichikeni, Mwase, Kanyanga, Chikwa, Mapamba, Chama, Chasefu, Lumezi, Lumezi Mission | `visit` rows (summary starts with "Drill:"), patient orders for RDT, ACT, rectal artesunate; those three items set to **0** at each post |
| Cholera-like diarrhoea (3 red, 2 yellow) | Luangwa valley: Mfuwe, Kakumbi, Jumbe, Kamoto, Msoro | ORS ×4, zinc, IV fluids for the red ones; ORS and zinc at 0 |
| Child pneumonia (1 red, 3 yellow) | Petauke district: Minga, Nyamphande, Ukwimi, Nyanje | amoxicillin, ceftriaxone, an oxygen cylinder (18 kg, road only) for the red one; amoxicillin and ceftriaxone at 0 |
| Two pregnancy bleeds needing blood by road | Katete (Mercy Banda), Vubwi (Violet Kunda) | Blood (O negative) ×2 and IV fluids ×2, hub-only items, truck or pickup only |
| Snakebite | Kacholola (far south-west, 300 km of road) | wound kit, IV fluids, paracetamol |
| Fever and diarrhoea visits across the middle | Chadiza, Sinda, Chimtende, Zingalume, Mlolo | yellow visits |
| Idle surplus intact | Lundazi (30 RDT, 20 ACT, 24 paracetamol), Petauke (30 ORS, 20 zinc, 16 amoxicillin) | so the planner can lend from them instead of trucking from Chipata |
| Three carriers in the workshop | ZAMMSA hub truck 1, DHO pickup Mambwe, CHA motorbike Chama | `carrier.status = down`; never picked anywhere |
| Six roads under water, one at risk | Chipata→Mfuwe and Jumbe→Mfuwe (Luangwa crossings), Lundazi→Chama and Chipata→Chama (the D103 dirt road), Chama→Chikwa, Katete→Kafumbwe (the ford); Msoro→Jumbe medium | `road_block` rows, 72 hours |

Level 1 is the Luangwa valley alone (two crossings, the Mambwe pickup down); level 2 adds the malaria
cluster, the D103 and the Chama motorbike. Simulation and the in-module agents are switched **off**,
so only the dispatch planner and the route planner act. Checked 24 Oct 2026: level 3 = **26 posts hit,
10 red and 16 yellow visits, 69 patient orders, 42 shelves emptied, 7 blocked legs, 3 carriers down.**

`clear_crisis` opens the roads, brings the carriers back, deletes the drill's visits, recalls its
undelivered orders (stock already loaded goes back on the shelf it left) and drops their route plans;
delivered stock stays where it arrived. `reset_demo` clears both tables as well. Start after Clear works
without restarting anything; Start while a drill is active clears it first.

## How the blocks are honoured (the real part)

The Routes page's "Flood the Katete road" switch works by writing a village into `data/floods.json`
and treating any leg within 25 km as high. The crisis generalises that into a table:

- `road_block(legFromVillageId, legToVillageId, risk high|medium, reason, until)`; the route planner's
  flood check (`floodRisk` in flood.ts) reads it through `sqlRows` (cached 1.5 s) and, when both ends of
  a leg sit at the block's two posts (either way round, within 12 km), the leg takes the block's level
  on top of the weather and surface answer. Expired rows are ignored.
- The router's **alternative road** is a different road, so its halves do not match the block and can
  pass (that is how the Chama orders got through: 438 km via another road instead of 331).
- A multi-stop run whose leg is still high after the alternative is tried **drops that stop**: its orders
  are planned one by one (`planOrder`: motorbike on the tracks, boat on the Luangwa, drone as a proposed
  partner, or a heavy load that waits for the water), and the tour is built again without it. A boat
  now serves any post within 20 km of its landing (Kakumbi is 7 km from the Mfuwe boat). One stop is
  still a run (one leg, drawn once), so an emergency to one post is one trip however many items it has.
- Carriers with status `down` are never picked, forced or not, in the dispatch planner or the route
  planner.
- The route watcher (`recheckAll`) leaves alone a plan that is already re-routed around a *standing*
  block (status rerouted, or a reason starting "Rerouted", when the only thing high on its direct road
  is the block): before this it re-planned those every ten minutes.

## The orchestrator (`POST /api/crisis/run { level }`)

Six timed steps, kept in memory and in `data/crisis.json` (so the dev server reloading a module cannot
lose them); `GET /api/crisis/status` returns them as they happen, with the crisis row, the blocked legs
and their road geometry.

1. **Start the crisis**: `start_crisis` reducer; counts read back from the tables.
2. **Run the dispatch planner**: `loadState` + `planDispatch`, unchanged rules (docs/DISPATCH.md).
   One change in `state.ts`: stock promised to an order that has not departed yet (the module takes it
   off the shelf two seconds after the order) is no longer counted as available, so the hub cannot be
   promised below zero.
3. **Place the orders, emergencies first**: `restock` per item in the plan's rank order.
4. **Plan the roads**: the plan's batched runs as multi-stop runs (a lender's orders ride their own run
   from the lender: "A2"); every emergency becomes one trip per post ("E7"), the pod's patient orders
   for that post riding along; four trips planned at a time.
5. **Re-check every live route** (`recheckAll`).
6. **Measure**: one *trip* = one carrier on one road (a run counts once); the **naive plan** = every
   order its own trip straight from the hub on the direct road by a district pickup at 60 km/h plus 20
   min to load, using the same cached OSRM roads. Minutes saved = naive minutes − planned minutes.

## Measured 24 Oct 2026, level 3, from a clean `reset_demo`

```
1. Start the crisis                108 ms   26 posts hit: 10 red, 16 yellow; 69 patient orders; 46 shelves emptied;
                                            7 roads blocked (6 under water); 3 carriers in the workshop.
2. Run the dispatch planner        5.1 s    78 shipments for 39 posts: 37 emergency, 2 pre-position, 39 routine;
                                            2564 items, 293.6 kg; 11 batched runs; Lundazi lends 30, Petauke lends 37.
3. Place the orders                6.2 s    772 restock orders; 38 leave from a lending post, not the hub.
4. Plan the roads                 15.8 s    70 trips: 12 multi-stop runs (39 stops) + 58 direct trips; 3 legs on the
                                            alternative road; Mfuwe, Kakumbi, Chama, Kafumbwe unreachable by road.
5. Re-check every live route       0.2 s    765 live routes re-checked: 0 re-routed, 0 changed level.
6. Measure                         1.9 s    83 trips for 841 orders: 11,005 km, 298 h
                                            vs 833 naive trips: 123,854 km, 2,342 h  →  112,849 km, 2,044 h saved.
                                            Whole run 29.3 s.
```

26 carriers used (11 pickups, 2 trucks, 6 motorbikes, 5 bicycles, 2 boats); 67 units lent between
posts (Petauke to 11 posts, Lundazi to 9). What the road could not reach: Mfuwe and Kakumbi (the
Luangwa crossing) went by CHA motorbike on the tracks and the Mfuwe banana boat (IV fluids by boat,
the rest by motorbike); Chama went round the washed-out D103 on the router's alternative road (438 km
instead of 331); Kafumbwe, cut off from Katete by the ford, was served from Chipata on its own direct
road (a different pair in the model). The two blood deliveries left Chipata by pickup on dry roads.
Exact counts move a little between runs because the seed's shelves are random (`reset_demo`).

Timing: the first runs took 68–147 s because the route watcher on an open Routes page re-checked on
every plan and `GET /api/routes` was rebuilt per plan; both are memoised now (2 s and, for the weather
part of a leg's flood check, 30 s per road pair), and the watcher no longer re-plans routes already
around a standing block. 29 s with seven other tabs polling the dev server.

## The page

Dark mission-control grid: a Start button with a level selector and Clear; the orchestrator's steps
with their timings (polled every second while it runs); eight counters that tick from the page's own
subscriptions (posts lit, requests open, orders, routes drawn, carriers out, km planned, re-routed,
delivered); the resources table (hub shelf now → waiting → moving → arrived, and what was lent, per
item); "How it found a way" (every blocked leg with the planner's outcome on it); posts the road could
not reach; the globe (every planned road, a run drawn once, blocked legs in red, re-routed roads in
green, moving carriers on the order's own clock, posts pulsing red or amber by their worst open visit);
and the versus-naive bars (km, trips, hours).

## What is estimated, honestly

- The *naive* plan is a definition (one pickup per order from the hub), not something anybody does.
- Weights are the planner's working numbers (`ITEM_KG`); carrier speeds and capacities are rough.
- A `road_block` is a leg between two posts: a different road pair to the same post is not blocked
  unless it has its own row (Kafumbwe from Chipata). The alternative road OSRM offers is accepted
  when its halves are dry; nobody checks that it does not cross the same river.
- The 72-hour `until` is a drill setting; the district would write the real one.
- The scenario is fictional; the posts, fleet, roads and surfaces are the real ones the rest of the app uses.
