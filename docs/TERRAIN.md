# Terrain tracks: new ways in, mapped from satellite

"Build new routes by mapping the flatlands from satellite." This is the tool that does it: for one health
post it looks at the ground within 15 km, finds the villages (clusters of houses), and proposes a motorbike
line and a bicycle line to each one across the flat, dry, open ground, for the dry season and the wet
season. It also marks candidate drone landing pads. Trucks are never proposed; these are tracks, not roads.

Everything comes from free data with no key or login. A line is a proposal until a rider has done it with a GPS.

## Where to see it

- The **Tracks** tab (`/tracks`): a satellite globe with the 40 posts, the villages picked for the chosen
  post, dashed proposed lines (blue motorbike, green bicycle; brighter = more confident) and purple
  diamonds for drone pads. A side list shows each track's length, time, steepest slope, climb, wet
  crossings and why it was kept. "Generate for <post>" runs the tool for that post (2 to 6 minutes).
- `GET /api/terrain/tracks` (optionally `?village=<id>`): all tracks, pads and per-post summaries. 404 with a
  plain message until the tool has run once.
- `POST /api/terrain/generate?village=<id>`: runs the tool for one post (10-minute cap, one at a time),
  appends its output to `data/terrain.log`, answers with that post's summary.

## Running it by hand

```sh
tools/terrain/setup.sh                                   # once: venv + packages, ~1 min
tools/terrain/.venv/bin/python tools/terrain/terrain_tracks.py --list          # the 40 posts
tools/terrain/.venv/bin/python tools/terrain/terrain_tracks.py --village 29    # Jumbe
tools/terrain/.venv/bin/python tools/terrain/terrain_tracks.py --missing       # every post not done yet
tools/terrain/.venv/bin/python tools/terrain/terrain_tracks.py --all           # everything again
```

The post list comes from the running app (`/api/weather/outlook`), else from SpacetimeDB
(`spacetime sql ... FROM village`), or pass `--lat --lng --name` for any point.

Outputs (merged per post, so re-running one post replaces only its own lines):

- `data/terrain-tracks.json`: `[{ fromVillageId, fromName, toCluster {lat,lng,buildings}, vehicle, season,
  lengthKm, minutes, maxSlopeDeg, meanSlopeDeg, climbM, crossings, surface {road,open,crop,bush,wet,unknown},
  roadKm, roadMinutes, roadNearM, reason, confidence 0-1, status: "proposed", line: [[lat,lng],...] }]`
- `data/terrain-pads.json`: `[{ villageId, atPost, cluster?, lat, lng, slopeDeg, cover, sizeM, distanceM, score, near, buildings, status }]`
- `data/terrain-meta.json`: per-post summary (villages picked, lines dropped and why, Sentinel-2 scenes used,
  land-cover mix, roads source, the speed rules) plus the source list.
- `tools/terrain/data/`: downloaded tiles and a per-post cache of the satellite inputs (`cache/post-<id>.npz`),
  all gitignored. `--refresh` ignores the cache.

First run for a post: 2 to 6 minutes (Sentinel-2 reads dominate). With cached inputs: about 1 minute.
The Open Buildings tiles are downloaded once (two tiles cover the province, 180 MB + 280 MB).

## The data, and whether it worked without a key (checked 2026-10-24)

| Source | Used for | Keyless? |
|---|---|---|
| Copernicus DEM GLO-30 (AWS open data, COG per 1x1 degree) | elevation, slope per 30 m cell | yes, plain HTTPS range reads |
| ESA WorldCover 2021 v200 (AWS open data, 10 m) | land cover: tree, shrub, grass, crop, built, bare, water, wetland | yes |
| Sentinel-2 L2A COGs via Element84 Earth Search STAC | NDWI wetness, best clear scene per MGRS tile, dry season (Aug 15 to Oct 31) and wet season (Feb 1 to Apr 15) | yes |
| Google Open Buildings v3 points (Google Cloud Storage) | house points, binned at 200 m into village clusters | yes |
| OpenStreetMap via Overpass | roads, tracks, paths, rivers, bridges | yes in principle, but on 2026-10-24 every public mirror refused (overpass-api.de connection refused, kumi and private.coffee HTTP 429, openstreetmap.fr white-list only) |
| OSRM demo server (router.project-osrm.org) | road route post to village (km, minutes, geometry) and nearest-road distance for each village | yes |

When Overpass is down the tool uses the OSRM road geometries (post to each village) as the road layer, so the
road network in the cost surface is partial and no river lines are known; `roadsSource` in the summary says
which happened, and confidence drops 0.05. When Overpass answers, the whole OSM network in the box is used,
rivers count as crossings, and a road tagged bridge or ford crosses water.

Geofabrik's Zambia shapefile was considered as a road fallback and rejected: 720 MB.

## The cost rules (plain words)

Each 30 m cell gets a speed for each vehicle; the path is the one with the least total time (Dijkstra over
the grid, 8 neighbours, metres-aware).

- **Motorbike**: road 40 km/h, bare ground 25, grass 22, cropland 14, built-up 15, shrub 8, trees 6,
  wetland 5 (closed in the wet season). Slope limit 15 degrees.
- **Bicycle**: road 15 km/h, bare 12, grass 10, cropland 7, built-up 10, shrub 4, trees 3, wetland 3
  (closed in the wet season). Slope limit 8 degrees.
- Slope below the limit slows the vehicle down linearly to a quarter of its speed at the limit; above the
  limit the cell is impassable. Mapped roads keep at least their road speed, a steep road still slows.
- Water (WorldCover water, or NDWI above 0.10 in that season's scene) is impassable unless a mapped road
  crosses it.
- Wet season: cropland at 60 % speed and grass at 80 % (mud), soggy ground (NDWI above 0) at half speed,
  wetland closed.
- Villages: Open Buildings points with confidence at least 0.65, binned at 200 m; bins with at least 3
  houses joined into clusters; clusters of at least 12 houses, 1.5 to 15 km from the post; up to 10 per post,
  road-less ones first, then biggest.
- A track is kept only if **no road reaches the village** (nearest routable road more than 1 km away, or
  OSRM finds no route) or the track is **at least 5 % quicker than the road** (road time = OSRM car time
  x 1.1 for a motorbike, distance at 15 km/h for a bicycle, plus the walk from the end of the road).
- **Confidence** starts at 0.9 and loses points for bush along the line (hides fences, trunks, thorn),
  cropland (owners, furrows), wet ground, slope near the limit, crossings, cloudy satellite scenes, missing
  data and the partial road layer; it gains a little for the share on mapped roads. Range 0.1 to 0.95.
- **Drone pads**: every cell of a 2 x 2 block (about 60 m across) must be under 3 degrees, bare ground or
  grass, dry in both seasons and off the road; the best block within 300 m of the village (flatter, barer,
  closer) is kept, plus one at the post.

## Example: Jumbe (post 29), first run

```
== Jumbe (#29) at -13.3, 31.92
  grid 1198 x 1166 cells of ~30 m, box 31.754..32.086 E, -13.462..-13.138 N
  elevation: 523-839 m, 0.0% missing (28s)
  land cover: trees 22%, shrub 39%, grass 31%, cropland 7%
  Sentinel-2 dry season: 2 scenes (2026-10-22, 0% cloud), 100% clear
  Sentinel-2 wet season: 2 scenes (2026-04-07, 7-8% cloud), 92% clear
  10042 buildings, 77 clusters in the box
  10 villages to connect: 30 houses 12.59 km no road, 2376 houses 8.85 km, 351 houses 14.74 km, ...
  Overpass down: using OSRM road geometries only (no river lines)
  21 tracks kept, 19 dropped (69s)
  11 drone pads
```

Kept, for example:

- motorbike, dry, to the 30-house village 12.6 km south: 14.4 km, 46 min, steepest 4.4 degrees, 0 crossings,
  confidence 0.80: no road reaches this village (nearest mapped road 2.5 km away).
- motorbike, dry, to the 2,376-house village: 11.8 km, 24 min, steepest 5 degrees, confidence 0.86: 6 min
  quicker than the road (29.7 min, 11.1 km).
- motorbike, dry, to a 321-house village: 16.0 km, 39 min, confidence 0.84: 17 min quicker than the road
  (56 min, 22.3 km).
- bicycle, dry, to the 30-house village: 14.3 km, 105 min, confidence 0.76 (no road); the other bicycle lines
  were dropped because the road was as quick at bicycle speeds.

Mfuwe (post 8) through the API: 12 tracks and 9 pads from 10 villages in 260 s.

## Honest limits

- **30 m cells miss gullies.** A donga two metres wide and three deep is invisible at this resolution; so is
  a single boulder field. Slope is averaged over 30 m.
- **Land cover does not show fences, ownership or hedges.** Cropland is somebody's field. A thorn fence
  around a kraal is "grass" to the satellite.
- **Seasonal streams are in no dataset.** The wet-season Sentinel-2 scene is one clear day in February to
  April; a stream that runs for a week after a storm will not be in it. "0 wet crossings" means none were seen.
- **Roads are only as good as OpenStreetMap**, and on the day this was built only the OSRM routes were
  available, not the whole network. A village 1 km from a "road" may be on a track OSM does not know.
- **Open Buildings** counts roofs, not people; a school, a church and a kraal are all buildings.
- **Times are flat-ground estimates** with simple slowdowns; a rider will know better after one trip.
- **Pads** are flat, open and dry by satellite. They are not checked for trees at the edge, power lines,
  livestock or whether the chief agrees.

A line here is a proposal until a rider has done it with a GPS. When they have, the track should move from
`status: "proposed"` to a real carrier route in the Routes tab.

## Files

- `tools/terrain/`: `setup.sh`, `requirements.txt`, `terrain_tracks.py` (entry), package `tt/`
  (`config.py` rules and URLs, `grid.py`, `sources.py` all readers, `cost.py`, `clusters.py`, `paths.py`,
  `pads.py`, `main.py`), `.gitignore` for the venv and downloads.
- `src/lib/terrain/index.ts`: types, JSON readers, the one-at-a-time runner (child process, 10-minute cap).
- `src/app/api/terrain/tracks/route.ts`, `src/app/api/terrain/generate/route.ts`.
- `src/app/tracks/page.tsx`: the globe page.

## What is left

- Overpass was down while this was built; when it answers, the same code uses the whole OSM network and the
  river lines (crossings then include real rivers). Nothing to change, just re-run with `--refresh` not needed
  (roads are not cached).
- The batch over all 40 posts runs post by post (`--missing`); each needs its satellite reads once.
- A "done it with GPS" button that turns a proposal into a carrier route, and a GPX export for the rider.
- A finer DEM where it matters (none free at 10 m for Zambia yet) and a flow-accumulation pass to guess
  seasonal stream lines from the DEM itself.
- The batch and the API both write the same JSON files; run one or the other at a time.
