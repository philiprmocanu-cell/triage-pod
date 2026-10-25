"""terrain-tracks: propose off-road motorbike and bicycle tracks and drone pads for one health post, from free satellite data.

    python -m tt --village 29            # one post (Jumbe)
    python -m tt --all                   # every post, one after the other
    python -m tt --list                  # the posts the app knows

Writes <repo>/data/terrain-tracks.json, terrain-pads.json and terrain-meta.json (merging with what is already there).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
import time

import numpy as np
import requests

from . import config as C
from .clusters import find_clusters, pick_clusters
from .cost import cost_surface, surface_words
from .grid import grid_for, haversine_km
from .pads import best_pad, pad_mask
from .paths import confidence, describe, route_all
from .sources import buildings, elevation, landcover, log, ndwi, osrm_nearest_m, osrm_route, overpass, roads_from_osm, slope_deg, _rasterize_lines

VEHICLES = ("motorbike", "bicycle")
SEASONS = ("dry", "wet")
OFFROAD_WALK_KMH = {"motorbike": 12.0, "bicycle": 6.0}  # getting from the end of the road to the houses


# ---------------------------------------------------------------- posts

def load_posts() -> list[dict]:
    try:
        j = requests.get(f"{C.APP_URL}/api/weather/outlook", timeout=20).json()
        posts = [{"id": int(p["villageId"]), "name": p["name"], "lat": float(p["lat"]), "lng": float(p["lng"])} for p in j["posts"]]
        if posts:
            return posts
    except Exception as e:
        log(f"app not reachable for the post list ({type(e).__name__}); trying SpacetimeDB")
    try:
        out = subprocess.run(["spacetime", "sql", "--server", "local", "podnet", "SELECT id, name, lat, lng FROM village"], capture_output=True, text=True, timeout=30).stdout
        posts = []
        for line in out.splitlines():
            parts = [p.strip().strip('"') for p in line.split("|")]
            if len(parts) >= 4 and parts[0].isdigit():
                posts.append({"id": int(parts[0]), "name": parts[1], "lat": float(parts[2]), "lng": float(parts[3])})
        if posts:
            return posts
    except Exception as e:
        log(f"SpacetimeDB not reachable either ({type(e).__name__})")
    sys.exit("No post list: start the app (npm run dev) or SpacetimeDB, or pass --lat/--lng/--name.")


# ---------------------------------------------------------------- inputs with a per-post cache

def inputs_for(post: dict, refresh: bool):
    grid = grid_for(post["lat"], post["lng"])
    cache = C.DATA / "cache" / f"post-{post['id']}.npz"
    meta_path = cache.with_suffix(".json")
    if cache.exists() and meta_path.exists() and not refresh:
        z = np.load(cache)
        meta = json.loads(meta_path.read_text())
        log(f"  inputs from cache ({cache.name})")
        return grid, z["elev"], z["slope"], z["cover"], z["ndwi_dry"], z["ndwi_wet"], meta
    t = time.time()
    log(f"  grid {grid.width} x {grid.height} cells of ~30 m, box {grid.west:.3f}..{grid.east:.3f} E, {grid.south:.3f}..{grid.north:.3f} N")
    elev = elevation(grid)
    log(f"  elevation: {np.nanmin(elev):.0f}-{np.nanmax(elev):.0f} m, {np.isnan(elev).mean() * 100:.1f}% missing ({time.time() - t:.0f}s)")
    slope = slope_deg(elev, grid)
    cover = landcover(grid)
    vals, cnt = np.unique(cover, return_counts=True)
    mix = {C.COVER_WORD.get(int(v), str(v)): round(float(c) / cover.size, 3) for v, c in zip(vals, cnt)}
    log(f"  land cover: {mix} ({time.time() - t:.0f}s)")
    nd_dry, m_dry = ndwi(grid, "dry")
    log(f"  Sentinel-2 dry season: {len(m_dry['scenes'])} scene(s), {m_dry['coverage'] * 100:.0f}% clear ({time.time() - t:.0f}s)")
    nd_wet, m_wet = ndwi(grid, "wet")
    log(f"  Sentinel-2 wet season: {len(m_wet['scenes'])} scene(s), {m_wet['coverage'] * 100:.0f}% clear ({time.time() - t:.0f}s)")
    meta = {"cover": mix, "s2": {"dry": m_dry, "wet": m_wet}, "elevRange": [float(np.nanmin(elev)), float(np.nanmax(elev))]}
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, elev=elev, slope=slope, cover=cover, ndwi_dry=nd_dry, ndwi_wet=nd_wet)
    meta_path.write_text(json.dumps(meta))
    return grid, elev, slope, cover, nd_dry, nd_wet, meta


# ---------------------------------------------------------------- one post

def run_post(post: dict, refresh: bool = False, search_km: float = C.SEARCH_KM) -> dict:
    t0 = time.time()
    log(f"== {post['name']} (#{post['id']}) at {post['lat']}, {post['lng']}")
    grid, elev, slope, cover, nd_dry, nd_wet, meta = inputs_for(post, refresh)
    wet_dry = ~np.isnan(nd_dry) & (nd_dry > C.NDWI_OPEN_WATER)
    wet_wet = ~np.isnan(nd_wet) & (nd_wet > C.NDWI_OPEN_WATER)

    # houses -> village clusters
    b = buildings(grid)
    clusters = find_clusters(b, grid, post["lat"], post["lng"])
    log(f"  {len(b)} buildings, {len(clusters)} clusters in the box ({time.time() - t0:.0f}s)")
    cands = sorted([c for c in clusters if C.CLUSTER_MIN_FROM_POST_KM <= c["km"] <= search_km], key=lambda c: -c["buildings"])[: C.CLUSTERS_PER_POST * 3]
    for c in cands:
        c["roadM"] = osrm_nearest_m(c["lat"], c["lng"])
        time.sleep(0.15)
    picked = pick_clusters(cands, search_km)
    log(f"  {len(picked)} villages to connect: " + ", ".join(f"{c['buildings']} houses {c['km']} km{' no road' if (c['roadM'] or 0) > C.ROAD_NEAR_M else ''}" for c in picked))

    # roads: the whole OSM network when Overpass answers, else the OSRM road geometries post -> village
    osm = overpass(grid)
    rivers = None
    river_names: list[str] = []
    if osm is not None:
        roads, rivers, bridges, river_names = roads_from_osm(osm, grid)
        roads_source = "osm"
        log(f"  OpenStreetMap: {int((roads > 0).sum())} road cells, {int((rivers > 0).sum())} river cells ({len(river_names)} named)")
    else:
        roads = np.zeros(cover.shape, np.uint8)
        roads_source = "osrm"
        log("  Overpass down: using OSRM road geometries only (no river lines)")
    road_routes = {}
    for i, c in enumerate(picked):
        rr = osrm_route(post["lat"], post["lng"], c["lat"], c["lng"])
        road_routes[i] = rr
        if rr is not None and roads_source == "osrm":
            roads = _rasterize_lines([[(p[1], p[0]) for p in rr[2]]], grid, 2, roads)
        time.sleep(0.2)
    # the post's own access road: so a path may start on it
    if roads_source == "osrm":
        r0, c0 = grid.rc(post["lat"], post["lng"])
        roads[max(0, r0 - 1) : r0 + 2, max(0, c0 - 1) : c0 + 2] = np.maximum(roads[max(0, r0 - 1) : r0 + 2, max(0, c0 - 1) : c0 + 2], 2)

    # least-cost paths
    start = grid.rc(post["lat"], post["lng"])
    targets = [grid.rc(c["lat"], c["lng"]) for c in picked]
    tracks = []
    dropped = []
    s2_cov = min(meta["s2"]["dry"]["coverage"], meta["s2"]["wet"]["coverage"])
    for vehicle in VEHICLES:
        for season in SEASONS:
            nd = nd_dry if season == "dry" else nd_wet
            wet = wet_dry if season == "dry" else wet_wet
            cost = cost_surface(cover, slope, roads, nd, vehicle, season)
            if not np.isfinite(cost[start]):
                # the post sits on a cell the rules call impassable (built-up on a steep cell, say): open it
                cost[start] = 3600.0 / (C.VEHICLES[vehicle]["road"] * 1000.0)
            cum, paths = route_all(cost, grid, start, targets)
            for i, (c, p) in enumerate(zip(picked, paths)):
                if p is None or len(p) < 2:
                    dropped.append({"village": c, "vehicle": vehicle, "season": season, "why": "no passable line within the slope and water rules"})
                    continue
                d = describe(p, grid, slope, cover, roads, rivers, wet, elev)
                minutes = float(cum[targets[i]]) / 60.0
                rr = road_routes.get(i)
                road_min = road_km = None
                if rr is not None:
                    km, car_min, _, snaps = rr
                    tail_m = snaps[-1] if snaps else 0.0
                    road_km = round(km + tail_m / 1000, 2)
                    base = car_min * 1.1 if vehicle == "motorbike" else km / C.VEHICLES["bicycle"]["road"] * 60
                    road_min = round(base + (tail_m / 1000) / OFFROAD_WALK_KMH[vehicle] * 60, 1)
                no_road = (c["roadM"] or 0) > C.ROAD_NEAR_M or rr is None
                faster = road_min is not None and minutes < road_min * 0.95
                if not (no_road or faster):
                    dropped.append({"village": c, "vehicle": vehicle, "season": season, "why": f"the road is as quick ({road_min} min by road vs {minutes:.0f} off road)"})
                    continue
                if no_road:
                    reason = f"no road reaches this village (nearest mapped road {int(c['roadM'] or 0)} m away)" if rr is not None else "no road route at all"
                else:
                    reason = f"{road_min - minutes:.0f} min quicker than the road ({road_min} min, {road_km} km)"
                conf = confidence(d, vehicle, s2_cov, roads_source)
                tracks.append(
                    {
                        "id": f"{post['id']}-{i}-{vehicle}-{season}",
                        "fromVillageId": post["id"],
                        "fromName": post["name"],
                        "toCluster": {"lat": c["lat"], "lng": c["lng"], "buildings": c["buildings"]},
                        "vehicle": vehicle,
                        "season": season,
                        "lengthKm": d["lengthKm"],
                        "minutes": round(minutes, 1),
                        "maxSlopeDeg": d["maxSlopeDeg"],
                        "meanSlopeDeg": d["meanSlopeDeg"],
                        "climbM": d["climbM"],
                        "crossings": d["crossings"],
                        "surface": d["surface"],
                        "roadKm": road_km,
                        "roadMinutes": road_min,
                        "roadNearM": None if c["roadM"] is None else int(c["roadM"]),
                        "reason": reason,
                        "confidence": conf,
                        "status": "proposed",
                        "line": d["line"],
                    }
                )
    log(f"  {len(tracks)} tracks kept, {len(dropped)} dropped ({time.time() - t0:.0f}s)")

    # drone pads: one per village and one at the post
    mask = pad_mask(slope, cover, wet_dry, wet_wet, roads)
    pads = []
    p0 = best_pad(mask, slope, cover, grid, post["lat"], post["lng"], f"{post['name']} post", 0)
    if p0:
        pads.append({"villageId": post["id"], "atPost": True, **p0})
    for c in picked:
        p = best_pad(mask, slope, cover, grid, c["lat"], c["lng"], f"village of {c['buildings']} houses, {c['km']} km from {post['name']}", c["buildings"])
        if p:
            pads.append({"villageId": post["id"], "atPost": False, "cluster": {"lat": c["lat"], "lng": c["lng"], "buildings": c["buildings"]}, **p})
    log(f"  {len(pads)} drone pads ({time.time() - t0:.0f}s)")

    summary = {
        "villageId": post["id"],
        "name": post["name"],
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "seconds": round(time.time() - t0),
        "grid": {"width": grid.width, "height": grid.height, "bbox": grid.bbox},
        "buildings": int(len(b)),
        "clustersInBox": len(clusters),
        "villages": picked,
        "tracks": len(tracks),
        "pads": len(pads),
        "dropped": dropped,
        "roadsSource": roads_source,
        "rivers": river_names,
        "cover": meta["cover"],
        "sentinel2": meta["s2"],
        "rules": [surface_words(v) for v in VEHICLES],
    }
    return {"tracks": tracks, "pads": pads, "summary": summary}


# ---------------------------------------------------------------- output files

def merge_out(result: dict):
    C.OUT_DIR.mkdir(parents=True, exist_ok=True)
    vid = result["summary"]["villageId"]

    def merge(name: str, items: list, key: str):
        path = C.OUT_DIR / name
        old = []
        if path.exists():
            try:
                old = json.loads(path.read_text())
            except json.JSONDecodeError:
                old = []
        keep = [x for x in old if x.get(key) != vid]
        path.write_text(json.dumps(keep + items, separators=(",", ":")))
        return len(keep) + len(items)

    n_t = merge("terrain-tracks.json", result["tracks"], "fromVillageId")
    n_p = merge("terrain-pads.json", result["pads"], "villageId")
    mp = C.OUT_DIR / "terrain-meta.json"
    meta = {"posts": {}, "sources": SOURCES}
    if mp.exists():
        try:
            meta = json.loads(mp.read_text())
        except json.JSONDecodeError:
            pass
    meta.setdefault("posts", {})[str(vid)] = result["summary"]
    meta["sources"] = SOURCES
    meta["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    mp.write_text(json.dumps(meta, indent=1))
    log(f"  wrote {C.OUT_DIR / 'terrain-tracks.json'} ({n_t} tracks total), terrain-pads.json ({n_p} pads total)")


SOURCES = [
    {"name": "Copernicus DEM GLO-30", "use": "elevation and slope, 30 m", "url": "https://copernicus-dem-30m.s3.amazonaws.com/", "keyless": True},
    {"name": "ESA WorldCover 2021 v200", "use": "land cover, 10 m, read at 30 m", "url": "https://esa-worldcover.s3.eu-central-1.amazonaws.com/", "keyless": True},
    {"name": "Sentinel-2 L2A via Earth Search (Element84)", "use": "NDWI wetness, dry and wet season scenes", "url": "https://earth-search.aws.element84.com/v1", "keyless": True},
    {"name": "Google Open Buildings v3", "use": "building points -> village clusters", "url": "https://storage.googleapis.com/open-buildings-data/", "keyless": True},
    {"name": "OpenStreetMap via Overpass", "use": "roads, tracks, rivers (when a mirror answers)", "url": "https://overpass-api.de/", "keyless": True},
    {"name": "OSRM demo server", "use": "road route and nearest-road distance; road geometries when Overpass is down", "url": "https://router.project-osrm.org/", "keyless": True},
]


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(prog="terrain-tracks", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--village", type=int, help="post id (village id in the app)")
    ap.add_argument("--all", action="store_true", help="every post the app knows")
    ap.add_argument("--missing", action="store_true", help="every post that has no result in terrain-meta.json yet")
    ap.add_argument("--list", action="store_true", help="print the posts and exit")
    ap.add_argument("--refresh", action="store_true", help="ignore the cached satellite inputs for this post")
    ap.add_argument("--search-km", type=float, default=C.SEARCH_KM, help="how far from the post to look for villages (default 15)")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lng", type=float)
    ap.add_argument("--name", type=str)
    a = ap.parse_args(argv)

    if a.lat is not None and a.lng is not None:
        posts = [{"id": a.village or 0, "name": a.name or "custom", "lat": a.lat, "lng": a.lng}]
    else:
        posts = load_posts()
    if a.list:
        for p in posts:
            print(f"{p['id']:3d}  {p['name']:24s} {p['lat']:9.4f} {p['lng']:9.4f}")
        return 0
    if a.all or a.missing:
        todo = posts
        if a.missing:
            mp = C.OUT_DIR / "terrain-meta.json"
            done = set(json.loads(mp.read_text()).get("posts", {}).keys()) if mp.exists() else set()
            todo = [p for p in posts if str(p["id"]) not in done]
            log(f"{len(todo)} posts still to do")
    elif a.village is not None:
        todo = [p for p in posts if p["id"] == a.village]
        if not todo:
            sys.exit(f"no post with id {a.village}; use --list")
    else:
        ap.error("pass --village <id>, --all, --missing, or --list")

    for p in todo:
        try:
            res = run_post(p, refresh=a.refresh, search_km=a.search_km)
        except Exception as e:
            log(f"!! {p['name']} failed: {type(e).__name__}: {e}")
            if len(todo) == 1:
                raise
            continue
        merge_out(res)
        s = res["summary"]
        print(json.dumps({"villageId": s["villageId"], "name": s["name"], "tracks": s["tracks"], "pads": s["pads"], "villages": len(s["villages"]), "seconds": s["seconds"], "roadsSource": s["roadsSource"],
                          "examples": [{"to": f"{t['toCluster']['buildings']} houses", "vehicle": t["vehicle"], "season": t["season"], "km": t["lengthKm"], "min": t["minutes"], "maxSlope": t["maxSlopeDeg"], "crossings": t["crossings"], "confidence": t["confidence"], "why": t["reason"]} for t in res["tracks"][:6]]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
