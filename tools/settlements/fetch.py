#!/usr/bin/env python3
"""Every settlement in Eastern Province, Zambia — down to unnamed hamlets of a few houses — as one
compact JSON file for the live map.

Run:  tools/terrain/.venv/bin/python -I tools/settlements/fetch.py      (numpy + scipy for the house clusters;
      plain python3 works too but then skips the Open Buildings step)
Out:  public/settlements/eastern-province.json
      { sources, fetched, points: [{n?, la, ln, p, k?, h?}] }
        n  name (missing = unnamed hamlet; the page says "hamlet, 23 houses")
        la, ln  4 decimals (~11 m)
        p  people: the census/OSM population when one is known, else roofs × 2.0 (see PEOPLE_PER_HOUSE)
        k  city | town | village | hamlet (missing = hamlet) | locality
        h  houses seen from satellite (missing = the place came only from a gazetteer)
Raw downloads land in tools/settlements/raw/ (gitignored); a re-run works from them offline.

Sources, keyless:
  1. Province polygon: OpenStreetMap relation 318865 via Nominatim (polygon_geojson). Everything
     below is clipped to it — the bounding box alone would take in a strip of Malawi and Mozambique.
  2. OpenStreetMap places through the Overpass API (place=city|town|village|hamlet|locality). The
     public mirrors rate-limit hard; when all three refuse, the run goes on without OSM and says so
     in `sources`, and the next run picks it up.
  3. GeoNames ZM.txt, feature class P, admin1 = 03 (Eastern).
  4. Google Open Buildings v3 (every roof detected in satellite imagery, ~7 M points over the wider
     box): the two level-4 S2 tiles 191 and 193 that cover the province, reused from
     tools/terrain/data/buildings/ when the terrain tool already has them. Roofs are snapped to a
     150 m grid and touching cells joined (DBSCAN-like, link ≤ ~150–300 m); clusters of ≥ MIN_HOUSES
     roofs are one dot each, named from the nearest gazetteer place within 1 km when there is one.
Gazetteer points within 300 m of each other are one place (OSM first, then GeoNames).
"""
import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RAW = os.path.join(HERE, "raw")
TERRAIN_BUILDINGS = os.path.join(ROOT, "tools", "terrain", "data", "buildings")
OUT = os.path.join(ROOT, "public", "settlements", "eastern-province.json")

BBOX = (-15.0, 30.0, -10.5, 33.8)  # south, west, north, east
KINDS = ("city", "town", "village", "hamlet", "locality")
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
GEONAMES = "https://download.geonames.org/export/dump/ZM.zip"
NOMINATIM = "https://nominatim.openstreetmap.org/lookup?osm_ids=R318865&format=json&polygon_geojson=1"
OPEN_BUILDINGS = "https://storage.googleapis.com/open-buildings-data/v3/points_s2_level_4_gzip/{token}_buildings.csv.gz"
S2_TILES = ("191", "193")
UA = "triage-pod-settlements/1 (health-post map for Eastern Province; github triage-pod)"
DEDUP_M = 300.0
CELL_M = 150.0  # roof clustering grid
MIN_HOUSES = 3
MIN_CONFIDENCE = 0.65
NAME_WITHIN_M = 1000.0
PEOPLE_PER_HOUSE = 2.0  # per detected roof: kitchens, granaries and shops are roofs too; 2.0 lands the province near its 2022 census (~2.4 M)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http(url, data=None, timeout=240):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- province polygon
def province_polygons():
    """List of rings [(lng, lat), ...] (outer rings only) of Eastern Province."""
    cache = os.path.join(RAW, "province.json")
    if not os.path.exists(cache):
        log("nominatim: province polygon")
        with open(cache, "wb") as f:
            f.write(http(NOMINATIM, timeout=60))
    with open(cache, "rb") as f:
        d = json.load(f)
    g = d[0]["geojson"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    rings = []
    for poly in polys:
        ring = [(float(x), float(y)) for x, y in poly[0]]
        step = max(1, len(ring) // 6000)  # ~6k vertices is plenty for a province border (vertices are ~100 m apart)
        rings.append(ring[::step] + [ring[0]])
    return rings


def point_in_ring(lng, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def inside_province(lng, lat, rings):
    return any(point_in_ring(lng, lat, r) for r in rings)


def inside_province_np(lngs, lats, rings):
    """Vectorised ray casting over many points: bool array."""
    import numpy as np

    res = np.zeros(len(lngs), dtype=bool)
    for ring in rings:
        xs = np.array([p[0] for p in ring]); ys = np.array([p[1] for p in ring])
        xj, yj = np.roll(xs, 1), np.roll(ys, 1)
        inside = np.zeros(len(lngs), dtype=bool)
        step = 2000
        for a in range(0, len(lngs), step):
            lx = lngs[a:a + step, None]; ly = lats[a:a + step, None]
            cond = (ys[None, :] > ly) != (yj[None, :] > ly)
            with np.errstate(divide="ignore", invalid="ignore"):
                x_at = (xj - xs)[None, :] * (ly - ys[None, :]) / ((yj - ys)[None, :]) + xs[None, :]
            hits = cond & (lx < x_at)
            inside[a:a + step] = (hits.sum(axis=1) % 2) == 1
        res |= inside
    return res


# ---------------------------------------------------------------- OpenStreetMap
def overpass_query(selector, where):
    kinds = "|".join(KINDS)
    return f"""[out:json][timeout:55];
{selector}
(
  node["place"~"^({kinds})$"]{where};
  way["place"~"^({kinds})$"]{where};
);
out center tags;"""


def fetch_osm():
    """(elements, how) — how is 'province polygon', 'bounding box', 'cache' or 'unavailable'."""
    cache = os.path.join(RAW, "osm-eastern.json")
    if os.environ.get("SETTLEMENTS_SKIP_OSM") and not os.path.exists(cache):
        log("overpass: skipped (SETTLEMENTS_SKIP_OSM set)")
        return [], "unavailable"
    if os.path.exists(cache):
        with open(cache, "rb") as f:
            d = json.load(f)
        return d["elements"], d.get("_how", "cache")
    attempts = [
        ("province polygon", overpass_query('area["ISO3166-2"="ZM-03"]->.a;', "(area.a)")),
        ("bounding box", overpass_query("", "(%s,%s,%s,%s)" % BBOX)),
    ]
    for how, q in attempts:
        for url in OVERPASS:
            try:
                log(f"overpass: {how} via {url}")
                raw = http(url, data=urllib.parse.urlencode({"data": q}).encode(), timeout=60)
                d = json.loads(raw)
                els = d.get("elements", [])
                if len(els) < 50:
                    log(f"  only {len(els)} elements, trying the next form")
                    break
                d["_how"] = how
                with open(cache, "w") as f:
                    json.dump(d, f)
                return els, how
            except Exception as e:  # noqa: BLE001
                log(f"  failed: {str(e)[:120]}")
                time.sleep(2)
    log("overpass: every mirror refused; going on without OSM (re-run later to add it)")
    return [], "unavailable"


def pop_of(tags):
    p = tags.get("population")
    if not p:
        return None
    digits = "".join(ch for ch in p if ch.isdigit())
    return int(digits) if digits else None


def osm_points(elements):
    pts = []
    for e in elements:
        t = e.get("tags", {})
        name = t.get("name") or t.get("name:en") or t.get("official_name")
        if not name:
            continue
        if e["type"] == "node":
            la, ln = e.get("lat"), e.get("lon")
        else:
            c = e.get("center") or {}
            la, ln = c.get("lat"), c.get("lon")
        if la is None or ln is None:
            continue
        pts.append({"n": name.strip(), "la": float(la), "ln": float(ln), "p": pop_of(t), "k": t.get("place", "village"), "src": "osm"})
    return pts


# ---------------------------------------------------------------- GeoNames
GN_KIND = {"PPLC": "city", "PPLA": "town", "PPLA2": "town", "PPLA3": "village", "PPLA4": "village", "PPL": "village", "PPLX": "locality", "PPLL": "locality", "PPLF": "hamlet", "PPLQ": "locality", "PPLW": "locality", "PPLS": "village", "STLMT": "hamlet"}


def fetch_geonames():
    cache = os.path.join(RAW, "ZM.zip")
    if not os.path.exists(cache):
        log("geonames: downloading ZM.zip")
        with open(cache, "wb") as f:
            f.write(http(GEONAMES))
    with zipfile.ZipFile(cache) as z:
        txt = z.read("ZM.txt").decode("utf-8")
    pts = []
    for line in io.StringIO(txt):
        c = line.rstrip("\n").split("\t")
        if len(c) < 15 or c[6] != "P":
            continue
        # No admin1 filter: Chama District moved to Muchinga Province in 2011 but its posts are part
        # of this network and inside the OSM province polygon, which does the clipping below.
        kind = GN_KIND.get(c[7], "village")
        pop = int(c[14]) if c[14].isdigit() and int(c[14]) > 0 else None
        pts.append({"n": c[1].strip(), "la": float(c[4]), "ln": float(c[5]), "p": pop, "k": kind, "src": "geonames"})
    pts.sort(key=lambda p: -(p["p"] or 0))  # a populated entry wins a 300 m tie over an empty one with the same spot
    return pts


# ---------------------------------------------------------------- the 40 posts
def post_points():
    """The health posts the app itself names (src/lib/network.ts POSTS): first pick for a cluster's name,
    so the dot under 'Katete' on the map is called Katete and not a GeoNames twin at the same spot."""
    import re

    path = os.path.join(ROOT, "src", "lib", "network.ts")
    try:
        with open(path, encoding="utf-8") as f:
            ts = f.read()
    except OSError:
        return []
    pts = []
    for m in re.finditer(r'\{\s*id:\s*"[^"]+",\s*name:\s*"([^"]+)",\s*lat:\s*(-?[\d.]+),\s*lng:\s*(-?[\d.]+),(?:\s*hub:\s*true,)?\s*population:\s*(\d+)', ts):
        name = re.sub(r" \(.*\)$", "", m.group(1))
        pts.append({"n": name, "la": float(m.group(2)), "ln": float(m.group(3)), "p": int(m.group(4)), "k": "town" if int(m.group(4)) >= 6000 else "village", "src": "posts"})
    return pts


# ---------------------------------------------------------------- Open Buildings
def building_points():
    """numpy array (lat, lng) of every roof with confidence ≥ MIN_CONFIDENCE in BBOX, or None without numpy."""
    try:
        import numpy as np
    except ImportError:
        log("open buildings: numpy missing — skipping house clusters (run with tools/terrain/.venv/bin/python)")
        return None
    import gzip

    s, w, n, e = BBOX
    parts = []
    for tok in S2_TILES:
        npy = os.path.join(TERRAIN_BUILDINGS, f"{tok}_province.npy")
        if os.path.exists(npy):
            a = np.load(npy)  # lat, lng, area, confidence — terrain tool's province-box filter
            log(f"open buildings: tile {tok} from terrain cache, {len(a):,} roofs")
        else:
            gz = os.path.join(TERRAIN_BUILDINGS, f"{tok}_buildings.csv.gz")
            if not os.path.exists(gz):
                gz = os.path.join(RAW, f"{tok}_buildings.csv.gz")
            if not os.path.exists(gz):
                log(f"open buildings: downloading tile {tok} (hundreds of MB)")
                with open(gz, "wb") as f:
                    f.write(http(OPEN_BUILDINGS.format(token=tok), timeout=1800))
            log(f"open buildings: reading tile {tok}")
            rows = []
            with gzip.open(gz, "rt") as f:
                header = f.readline().strip().split(",")
                ilat, ilng, iconf = header.index("latitude"), header.index("longitude"), header.index("confidence")
                for line in f:
                    p = line.split(",")
                    try:
                        lat, lng = float(p[ilat]), float(p[ilng])
                    except (ValueError, IndexError):
                        continue
                    if s <= lat <= n and w <= lng <= e:
                        rows.append((lat, lng, 0.0, float(p[iconf])))
            a = np.array(rows, dtype=np.float32) if rows else np.zeros((0, 4), np.float32)
        m = (a[:, 0] >= s) & (a[:, 0] <= n) & (a[:, 1] >= w) & (a[:, 1] <= e) & (a[:, 3] >= MIN_CONFIDENCE)
        parts.append(a[m][:, :2].astype(np.float64))
    pts = np.concatenate(parts) if parts else None
    if pts is not None:
        log(f"open buildings: {len(pts):,} roofs in the box at confidence ≥ {MIN_CONFIDENCE}")
    return pts


def cluster_roofs(pts, rings):
    """Snap roofs to a CELL_M grid, join touching cells, keep clusters of ≥ MIN_HOUSES inside the province.
    Returns a list of {la, ln, h} sorted by houses, largest first."""
    import numpy as np
    from scipy import ndimage

    s, w, n, e = BBOX
    dlat = CELL_M / 111320.0
    dlng = CELL_M / (111320.0 * math.cos(math.radians((s + n) / 2)))
    rows = ((pts[:, 0] - s) / dlat).astype(np.int64)
    cols = ((pts[:, 1] - w) / dlng).astype(np.int64)
    H, W = int((n - s) / dlat) + 2, int((e - w) / dlng) + 2
    occ = np.zeros((H, W), dtype=bool)
    occ[rows, cols] = True
    labels, count = ndimage.label(occ, structure=np.ones((3, 3), dtype=int))
    log(f"open buildings: {occ.sum():,} occupied {int(CELL_M)} m cells → {count:,} clusters")
    lab = labels[rows, cols]
    houses = np.bincount(lab, minlength=count + 1)
    la = np.bincount(lab, weights=pts[:, 0], minlength=count + 1) / np.maximum(houses, 1)
    ln = np.bincount(lab, weights=pts[:, 1], minlength=count + 1) / np.maximum(houses, 1)
    keep = np.nonzero(houses >= MIN_HOUSES)[0]
    keep = keep[keep != 0]
    log(f"open buildings: {len(keep):,} clusters with ≥ {MIN_HOUSES} houses; clipping to the province")
    inside = inside_province_np(ln[keep], la[keep], rings)
    keep = keep[inside]
    order = np.argsort(-houses[keep])
    keep = keep[order]
    return [{"la": float(la[i]), "ln": float(ln[i]), "h": int(houses[i])} for i in keep]


# ---------------------------------------------------------------- merge
def dist_m(a_la, a_ln, b_la, b_ln):
    r = 6371000.0
    p1, p2 = math.radians(a_la), math.radians(b_la)
    dl = math.radians(b_ln - a_ln)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, h)))


class Grid:
    def __init__(self, cell_m):
        self.cell = cell_m / 111000.0
        self.g = {}

    def key(self, la, ln):
        return (int(ln // self.cell), int(la // self.cell))

    def add(self, p):
        self.g.setdefault(self.key(p["la"], p["ln"]), []).append(p)

    def near(self, la, ln, within_m, weigh=False):
        """Nearest free point within `within_m`; with weigh=True a place with a known population
        wins over a nearer unknown one (a 60,000-roof blob is the district town, not its suburb)."""
        gx, gy = self.key(la, ln)
        r = int(math.ceil(within_m / 111000.0 / self.cell))
        best, bs = None, float("inf")
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for q in self.g.get((gx + dx, gy + dy), ()):
                    if q.get("_claimed"):
                        continue
                    d = dist_m(la, ln, q["la"], q["ln"])
                    if d > within_m:
                        continue
                    score = d / (1 + math.log10(1 + (q["p"] or 0))) if weigh else d
                    if score < bs:
                        best, bs = q, score
        return best


def dedupe(points):
    """Keep the first point in each 300 m cluster (input order = trust order); merge population."""
    grid = Grid(DEDUP_M)
    kept = []
    for p in points:
        twin = grid.near(p["la"], p["ln"], DEDUP_M)
        if twin:
            if twin["p"] is None and p["p"] is not None:
                twin["p"] = p["p"]
            continue
        grid.add(p)
        kept.append(p)
    return kept


def in_bbox(p):
    s, w, n, e = BBOX
    return s <= p["la"] <= n and w <= p["ln"] <= e


def main():
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    rings = province_polygons()
    log(f"province polygon: {sum(len(r) for r in rings)} vertices in {len(rings)} ring(s)")

    osm_els, how = fetch_osm()
    osm = [p for p in osm_points(osm_els) if in_bbox(p) and inside_province(p["ln"], p["la"], rings)]
    log(f"osm: {len(osm)} named places inside the province ({how})")
    gn = [p for p in fetch_geonames() if in_bbox(p) and inside_province(p["ln"], p["la"], rings)]
    log(f"geonames: {len(gn)} populated places inside the province")
    rank = {"city": 0, "town": 1, "village": 2, "hamlet": 3, "locality": 4}
    osm.sort(key=lambda p: (rank.get(p["k"], 9), -(p["p"] or 0)))
    seeds = [p for p in post_points() if in_bbox(p)]
    log(f"posts: {len(seeds)} health-post names from src/lib/network.ts")
    named = dedupe(seeds + osm + gn)
    log(f"gazetteer: {len(named)} distinct named places")

    roofs = building_points()
    clusters = cluster_roofs(roofs, rings) if roofs is not None else []

    # Name each cluster from the nearest free gazetteer point within 1 km (biggest clusters choose first).
    grid = Grid(NAME_WITHIN_M)
    for p in named:
        grid.add(p)

    def kind_for(houses, base="hamlet"):
        by_size = "city" if houses >= 15000 else "town" if houses >= 1500 else "village" if houses >= 40 else "hamlet"
        order = ["hamlet", "locality", "village", "town", "city"]
        return by_size if order.index(by_size) > order.index(base if base in order else "hamlet") else base
    out = []
    named_clusters = 0
    for c in clusters:
        # A blob of 60,000 roofs is several km across: let its name come from further out.
        reach = min(8000.0, max(NAME_WITHIN_M, 60.0 * math.sqrt(c["h"])))
        hit = grid.near(c["la"], c["ln"], reach, weigh=c["h"] >= 300)
        people = int(round(c["h"] * PEOPLE_PER_HOUSE))
        if hit:
            hit["_claimed"] = True
            named_clusters += 1
            out.append({"n": hit["n"], "la": c["la"], "ln": c["ln"], "p": hit["p"] or people, "k": kind_for(c["h"], hit["k"]), "h": c["h"]})
        else:
            out.append({"la": c["la"], "ln": c["ln"], "p": people, "k": kind_for(c["h"]), "h": c["h"]})
    leftover = 0
    for p in named:
        if p.get("_claimed"):
            continue
        leftover += 1
        out.append({"n": p["n"], "la": p["la"], "ln": p["ln"], "p": p["p"] or 0, "k": p["k"]})

    def compact(p):
        q = {"la": round(p["la"], 4), "ln": round(p["ln"], 4), "p": p["p"]}
        if p.get("n"):
            q["n"] = p["n"]
        if p.get("k") and p["k"] != "hamlet":
            q["k"] = p["k"]
        if p.get("h"):
            q["h"] = p["h"]
        return q

    out = [compact(p) for p in out]
    out.sort(key=lambda p: (-(p.get("h") or 0), p["la"], p["ln"]))
    from_osm = sum(1 for p in named if p["src"] == "osm")
    from_posts = sum(1 for p in named if p["src"] == "posts")
    sources = {
        "osm": from_osm, "osmArea": how, "geonames": len(named) - from_osm - from_posts, "posts": from_posts,
        "openBuildings": {"clusters": len(clusters), "named": named_clusters, "unnamed": len(clusters) - named_clusters, "minHouses": MIN_HOUSES, "cellM": CELL_M, "roofs": int(len(roofs)) if roofs is not None else 0},
        "gazetteerOnly": leftover, "peoplePerHouse": PEOPLE_PER_HOUSE, "polygon": "OSM relation 318865 via Nominatim",
    }
    with open(OUT, "w") as f:
        json.dump({"sources": sources, "fetched": time.strftime("%Y-%m-%d"), "points": out}, f, ensure_ascii=False, separators=(",", ":"))
    kinds = {}
    for p in out:
        kinds[p.get("k", "hamlet")] = kinds.get(p.get("k", "hamlet"), 0) + 1
    log(f"wrote {len(out):,} settlements → {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) / 1e6:.2f} MB)")
    log(f"  named places: {len(named)} ({from_osm} OSM, {len(named) - from_osm - from_posts} GeoNames, {from_posts} post names); house clusters: {len(clusters):,} ({named_clusters:,} named, {len(clusters) - named_clusters:,} unnamed); gazetteer-only points: {leftover}")
    log(f"  by kind: {kinds}; total people (census where known, else houses × {PEOPLE_PER_HOUSE}): {sum(p['p'] for p in out):,}")


if __name__ == "__main__":
    main()
