"""Every input, read keyless over HTTPS and warped onto the working grid.

- Copernicus DEM GLO-30 (AWS open data, COG per 1x1 degree)   -> elevation, slope
- ESA WorldCover 2021 v200 (AWS open data, 10 m)                -> land cover class
- Sentinel-2 L2A COGs via Element84 Earth Search STAC           -> NDWI wetness, dry and wet season
- Google Open Buildings v3 points (Google Cloud Storage)        -> where the houses are
- OpenStreetMap roads/rivers via Overpass, else OSRM geometries -> existing roads and tracks
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.vrt import WarpedVRT

from . import config as C
from .grid import Grid

GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", VSI_CACHE="TRUE", GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2", AWS_NO_SIGN_REQUEST="YES", CPL_VSIL_CURL_USE_HEAD="NO")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def _warp(url: str, grid: Grid, resampling: Resampling, band: int = 1, dtype=np.float32, nodata=None):
    """Read one remote COG warped onto the grid (EPSG:4326, 1 arc-second)."""
    with rasterio.Env(**GDAL_ENV):
        with rasterio.open(url) as src:
            kw = dict(crs="EPSG:4326", transform=grid.transform, width=grid.width, height=grid.height, resampling=resampling)
            if nodata is not None:
                kw["nodata"] = nodata
                kw["src_nodata"] = src.nodata if src.nodata is not None else nodata
            with WarpedVRT(src, **kw) as vrt:
                return vrt.read(band).astype(dtype)


# ---------------------------------------------------------------- elevation

def _dem_tiles(grid: Grid):
    for lat in range(math.floor(grid.south), math.ceil(grid.north)):
        for lon in range(math.floor(grid.west), math.ceil(grid.east)):
            la = f"{'S' if lat < 0 else 'N'}{abs(lat):02d}"
            lo = f"{'W' if lon < 0 else 'E'}{abs(lon):03d}"
            yield C.DEM_URL.format(lat=la, lon=lo)


def elevation(grid: Grid) -> np.ndarray:
    out = np.full((grid.height, grid.width), np.nan, np.float32)
    for url in _dem_tiles(grid):
        try:
            a = _warp(url, grid, Resampling.bilinear, nodata=-32767)
        except Exception as e:  # a tile over open ocean does not exist; here it should always exist
            log(f"  DEM tile missing/unreadable: {url.rsplit('/', 1)[-1]} ({e})")
            continue
        a[a <= -32000] = np.nan
        fill = np.isnan(out) & ~np.isnan(a)
        out[fill] = a[fill]
    return out


def slope_deg(elev: np.ndarray, grid: Grid) -> np.ndarray:
    dy_m, dx_m = grid.cell_m
    z = np.where(np.isnan(elev), np.nanmean(elev), elev)
    gy, gx = np.gradient(z, dy_m, dx_m)
    s = np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)
    s[np.isnan(elev)] = np.nan
    return s


# ---------------------------------------------------------------- land cover

def _wc_tiles(grid: Grid):
    for lat in range(math.floor(grid.south / 3) * 3, math.ceil(grid.north / 3) * 3, 3):
        for lon in range(math.floor(grid.west / 3) * 3, math.ceil(grid.east / 3) * 3, 3):
            yield C.WORLDCOVER_URL.format(tile=f"{'S' if lat < 0 else 'N'}{abs(lat):02d}{'W' if lon < 0 else 'E'}{abs(lon):03d}")


def landcover(grid: Grid) -> np.ndarray:
    out = np.zeros((grid.height, grid.width), np.uint8)
    for url in _wc_tiles(grid):
        try:
            a = _warp(url, grid, Resampling.mode, dtype=np.uint8, nodata=0)
        except Exception as e:
            log(f"  WorldCover tile unreadable: {url.rsplit('/', 1)[-1]} ({e})")
            continue
        fill = (out == 0) & (a != 0)
        out[fill] = a[fill]
    return out


# ---------------------------------------------------------------- Sentinel-2 wetness

def _season_windows(season: str):
    """Most recent dry (Aug 15-Oct 31) or wet (Feb 1-Apr 15) season that has already happened, then the year before."""
    today = dt.date.today()
    for back in (0, 1, 2):
        y = today.year - back
        if season == "dry":
            start, end = dt.date(y, 8, 15), dt.date(y, 10, 31)
        else:
            start, end = dt.date(y, 2, 1), dt.date(y, 4, 15)
        if start > today:
            continue
        yield f"{start.isoformat()}T00:00:00Z/{min(end, today).isoformat()}T23:59:59Z"


def _stac_items(bbox, window: str, limit=40):
    body = {"collections": ["sentinel-2-l2a"], "bbox": list(bbox), "datetime": window, "query": {"eo:cloud_cover": {"lt": C.S2_MAX_CLOUD}}, "limit": limit}
    r = requests.post(C.STAC_URL, json=body, timeout=60)
    r.raise_for_status()
    return r.json().get("features", [])


def ndwi(grid: Grid, season: str) -> tuple[np.ndarray, dict]:
    """Cloud-masked NDWI composite (mean over the best scene per MGRS tile). NaN where nothing valid."""
    acc = np.zeros((grid.height, grid.width), np.float32)
    n = np.zeros((grid.height, grid.width), np.int16)
    used = []
    for window in _season_windows(season):
        items = _stac_items(grid.bbox, window)
        if not items:
            continue
        best = {}
        for it in items:
            tile = it["properties"].get("grid:code") or it["properties"].get("s2:mgrs_tile") or it["id"][4:9]
            if tile not in best or it["properties"]["eo:cloud_cover"] < best[tile]["properties"]["eo:cloud_cover"]:
                best[tile] = it
        for tile, it in list(best.items())[:4]:
            a = it["assets"]
            try:
                g = _warp(a["green"]["href"], grid, Resampling.average, nodata=0)
                nir = _warp(a["nir"]["href"], grid, Resampling.average, nodata=0)
                scl = _warp(a["scl"]["href"], grid, Resampling.nearest, dtype=np.uint8, nodata=0)
            except Exception as e:
                log(f"  Sentinel-2 {it['id']} unreadable ({e})")
                continue
            valid = (g > 0) & (nir > 0) & ~np.isin(scl, [0, 1, 3, 8, 9, 10, 11])  # drop nodata, saturated, cloud shadow, clouds, cirrus, snow
            v = (g - nir) / np.maximum(g + nir, 1)
            acc[valid] += v[valid]
            n[valid] += 1
            used.append({"id": it["id"], "date": it["properties"]["datetime"][:10], "cloud": round(it["properties"]["eo:cloud_cover"], 1)})
        if used:
            break
    out = np.where(n > 0, acc / np.maximum(n, 1), np.nan).astype(np.float32)
    return out, {"season": season, "scenes": used, "coverage": float(np.mean(n > 0))}


# ---------------------------------------------------------------- buildings

def _s2_tokens(bbox):
    import s2sphere

    rect = s2sphere.LatLngRect.from_point_pair(s2sphere.LatLng.from_degrees(bbox[1], bbox[0]), s2sphere.LatLng.from_degrees(bbox[3], bbox[2]))
    cov = s2sphere.RegionCoverer()
    cov.min_level = 4
    cov.max_level = 4
    return sorted({c.to_token() for c in cov.get_covering(rect)})


def _download(url: str, dest: Path, label: str):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    log(f"  downloading {label} -> {dest.name}")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        t0 = time.time()
        with open(part, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                got += len(chunk)
                if total and time.time() - t0 > 15:
                    t0 = time.time()
                    log(f"    {got / 1e6:.0f} / {total / 1e6:.0f} MB")
    part.rename(dest)


def buildings_in_tile(token: str) -> np.ndarray:
    """All Open Buildings points of one level-4 S2 tile inside the province box: columns lat, lng, area m2, confidence."""
    cache = C.DATA / "buildings" / f"{token}_province.npy"
    if cache.exists():
        return np.load(cache)
    gz = C.DATA / "buildings" / f"{token}_buildings.csv.gz"
    if not gz.exists():
        _download(C.OPEN_BUILDINGS_URL.format(token=token), gz, f"Open Buildings tile {token}")
    w, s, e, n = C.PROVINCE_BBOX
    rows = []
    log(f"  filtering Open Buildings tile {token} to Eastern Province (one-time, a few minutes)")
    with gzip.open(gz, "rt") as f:
        header = f.readline().strip().split(",")
        ilat, ilng, iarea, iconf = header.index("latitude"), header.index("longitude"), header.index("area_in_meters"), header.index("confidence")
        for line in f:
            p = line.split(",")
            try:
                lat = float(p[ilat])
                lng = float(p[ilng])
            except (ValueError, IndexError):
                continue
            if s <= lat <= n and w <= lng <= e:
                rows.append((lat, lng, float(p[iarea]), float(p[iconf])))
    arr = np.array(rows, dtype=np.float32) if rows else np.zeros((0, 4), np.float32)
    np.save(cache, arr)
    return arr


def buildings(grid: Grid) -> np.ndarray:
    parts = []
    for tok in _s2_tokens(grid.bbox):
        b = buildings_in_tile(tok)
        if len(b):
            m = (b[:, 0] >= grid.south) & (b[:, 0] <= grid.north) & (b[:, 1] >= grid.west) & (b[:, 1] <= grid.east) & (b[:, 3] >= C.BUILDING_MIN_CONFIDENCE)
            parts.append(b[m])
    return np.concatenate(parts) if parts else np.zeros((0, 4), np.float32)


# ---------------------------------------------------------------- roads and rivers

ROAD_MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
ROAD_MINOR = {"unclassified", "residential", "service", "track", "road", "living_street"}
ROAD_PATH = {"path", "footway", "bridleway", "cycleway"}


_overpass_dead = False


def overpass(grid: Grid) -> dict | None:
    """Roads, tracks, paths and waterways inside the grid from OpenStreetMap. None when every mirror is down
    (then the rest of this process stops asking, so a 40-post run does not wait on it 40 times)."""
    global _overpass_dead
    import os

    if _overpass_dead or os.environ.get("TERRAIN_SKIP_OVERPASS"):
        return None
    s, w, n, e = grid.south, grid.west, grid.north, grid.east
    q = f'[out:json][timeout:45];(way["highway"]({s},{w},{n},{e});way["waterway"~"^(river|stream|canal|drain)$"]({s},{w},{n},{e}););out geom;'
    for url in C.OVERPASS_URLS:
        try:
            r = requests.post(url, data={"data": q}, timeout=(5, 50))
            if r.status_code != 200:
                log(f"  Overpass {url}: HTTP {r.status_code}")
                continue
            return r.json()
        except Exception as e:
            log(f"  Overpass {url}: {type(e).__name__}")
    _overpass_dead = True
    return None


def _rasterize_lines(lines, grid: Grid, value=1, out=None, all_touched=True):
    shapes = [({"type": "LineString", "coordinates": coords}, value) for coords in lines if len(coords) >= 2]
    if not shapes:
        return out if out is not None else np.zeros((grid.height, grid.width), np.uint8)
    arr = rasterize(shapes, out_shape=(grid.height, grid.width), transform=grid.transform, fill=0, all_touched=all_touched, dtype=np.uint8)
    if out is None:
        return arr
    out[arr > 0] = arr[arr > 0]
    return out


def roads_from_osm(osm: dict, grid: Grid):
    """Returns (roads raster: 0 none / 1 major / 2 minor / 3 path, rivers raster 0/1, bridge raster 0/1, list of named river names)."""
    major, minor, path, rivers, bridges = [], [], [], [], []
    names = set()
    for el in osm.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
        t = el.get("tags", {})
        hw = t.get("highway")
        if hw:
            (major if hw in ROAD_MAJOR else minor if hw in ROAD_MINOR else path).append(coords)
            if t.get("bridge") in ("yes", "viaduct") or t.get("ford") == "yes":
                bridges.append(coords)
        elif t.get("waterway"):
            rivers.append(coords)
            if t.get("name"):
                names.add(t["name"])
    roads = np.zeros((grid.height, grid.width), np.uint8)
    roads = _rasterize_lines(path, grid, 3, roads)
    roads = _rasterize_lines(minor, grid, 2, roads)
    roads = _rasterize_lines(major, grid, 1, roads)
    riv = _rasterize_lines(rivers, grid, 1, all_touched=False)
    br = _rasterize_lines(bridges, grid, 1)
    return roads, riv, br, sorted(names)


def osrm_route(lat1, lng1, lat2, lng2):
    """Road route (car profile) between two points: (km, minutes, [[lat,lng],...], snap distances m) or None."""
    url = f"{C.OSRM_URL}/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=geojson"
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=30)
            j = r.json()
            if j.get("code") == "Ok" and j.get("routes"):
                rt = j["routes"][0]
                pts = [[c[1], c[0]] for c in rt["geometry"]["coordinates"]]
                snaps = [wp.get("distance", 0.0) for wp in j.get("waypoints", [])]
                return rt["distance"] / 1000, rt["duration"] / 60, pts, snaps
            if j.get("code") in ("NoRoute", "NoSegment"):
                return None
        except Exception as e:
            log(f"  OSRM: {type(e).__name__} (try {attempt + 1})")
        time.sleep(1.5 * (attempt + 1))
    return None


def osrm_nearest_m(lat, lng):
    """Distance in metres from a point to the nearest routable road, or None when OSRM is down."""
    try:
        r = requests.get(f"{C.OSRM_URL}/nearest/v1/driving/{lng},{lat}?number=1", timeout=30)
        j = r.json()
        if j.get("code") == "Ok" and j.get("waypoints"):
            return float(j["waypoints"][0]["distance"])
    except Exception as e:
        log(f"  OSRM nearest: {type(e).__name__}")
    return None
