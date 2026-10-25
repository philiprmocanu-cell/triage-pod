#!/usr/bin/env python3
"""Every settlement in Eastern Province, Zambia, as one small JSON file for the globe.

Run:  python3 -I tools/settlements/fetch.py            (standard library only, no key, ~1 minute)
Out:  public/settlements/eastern-province.json         [{n, la, ln, p, k}] — name, lat, lng,
      population or null, kind (city|town|village|hamlet|locality), 4 decimals.
Raw downloads land in tools/settlements/raw/ (gitignored) so a re-run can work offline.

Sources, in order of trust:
  1. OpenStreetMap through the Overpass API: every place=city|town|village|hamlet|locality inside
     the province polygon (OSM area ISO3166-2=ZM-03). If Overpass cannot resolve the area it falls
     back to the bounding box lat -15.0..-10.5, lng 30.0..33.8, which also catches a strip of
     Malawi and Mozambique — the count line says which one was used.
  2. GeoNames ZM.txt (free dump), feature class P, admin1 = 03 (Eastern). Adds the villages OSM
     does not have; a GeoNames point within 300 m of an OSM point is dropped as the same place.
"""
import io
import json
import math
import os
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(ROOT, "public", "settlements", "eastern-province.json")

BBOX = (-15.0, 30.0, -10.5, 33.8)  # south, west, north, east
KINDS = ("city", "town", "village", "hamlet", "locality")
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
GEONAMES = "https://download.geonames.org/export/dump/ZM.zip"
UA = "triage-pod-settlements/1 (health-post map; contact: github triage-pod)"
DEDUP_M = 300.0


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http(url, data=None, timeout=240):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- OpenStreetMap
def overpass_query(selector):
    kinds = "|".join(KINDS)
    return f"""[out:json][timeout:200];
{selector}
(
  node["place"~"^({kinds})$"]{{F}};
  way["place"~"^({kinds})$"]{{F}};
  relation["place"~"^({kinds})$"]{{F}};
);
out center tags;"""


def fetch_osm():
    """Returns (elements, how) — how is 'province polygon' or 'bounding box'."""
    cache = os.path.join(RAW, "osm-eastern.json")
    if os.path.exists(cache):
        with open(cache, "rb") as f:
            d = json.load(f)
        return d["elements"], d.get("_how", "cache")
    attempts = [
        ("province polygon", overpass_query('area["ISO3166-2"="ZM-03"]->.a;').replace("{F}", "(area.a)")),
        ("province polygon", overpass_query('area["admin_level"="4"]["name"="Eastern Province"]["is_in:country_code"="ZM"]->.a;').replace("{F}", "(area.a)")),
        ("bounding box", overpass_query("").replace("{F}", "(%s,%s,%s,%s)" % BBOX)),
    ]
    for how, q in attempts:
        for url in OVERPASS:
            try:
                log(f"overpass: {how} via {url}")
                raw = http(url, data=q.encode("utf-8"))
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
                log(f"  failed: {e}")
                time.sleep(3)
    raise SystemExit("Overpass gave nothing; try again in a minute")


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
        if c[10] != "03":  # admin1 code 03 = Eastern Province
            continue
        kind = GN_KIND.get(c[7], "village")
        pop = int(c[14]) if c[14].isdigit() and int(c[14]) > 0 else None
        pts.append({"n": c[1].strip(), "la": float(c[4]), "ln": float(c[5]), "p": pop, "k": kind, "src": "geonames"})
    return pts


# ---------------------------------------------------------------- merge
def dist_m(a, b):
    r = 6371000.0
    p1, p2 = math.radians(a["la"]), math.radians(b["la"])
    dphi = p2 - p1
    dl = math.radians(b["ln"] - a["ln"])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def dedupe(points):
    """Keep the first point in each 300 m cluster (input order = trust order); merge population."""
    cell = DEDUP_M / 111000.0  # degrees per cell, roughly
    grid = {}
    kept = []
    for p in points:
        gx, gy = int(p["ln"] // cell), int(p["la"] // cell)
        twin = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in grid.get((gx + dx, gy + dy), ()):
                    if dist_m(p, q) <= DEDUP_M:
                        twin = q
                        break
                if twin:
                    break
            if twin:
                break
        if twin:
            if twin["p"] is None and p["p"] is not None:
                twin["p"] = p["p"]
            continue
        grid.setdefault((gx, gy), []).append(p)
        kept.append(p)
    return kept


def in_bbox(p):
    s, w, n, e = BBOX
    return s <= p["la"] <= n and w <= p["ln"] <= e


def main():
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    osm_els, how = fetch_osm()
    osm = osm_points(osm_els)
    log(f"osm: {len(osm)} named places ({how})")
    gn = [p for p in fetch_geonames() if in_bbox(p)]
    log(f"geonames: {len(gn)} populated places in Eastern")
    rank = {"city": 0, "town": 1, "village": 2, "hamlet": 3, "locality": 4}
    osm.sort(key=lambda p: (rank.get(p["k"], 9), -(p["p"] or 0)))
    merged = dedupe(osm + gn)
    from_osm = sum(1 for p in merged if p["src"] == "osm")
    from_gn = len(merged) - from_osm
    out = [{"n": p["n"], "la": round(p["la"], 4), "ln": round(p["ln"], 4), "p": p["p"], "k": p["k"]} for p in merged]
    out.sort(key=lambda p: (p["la"], p["ln"]))
    with open(OUT, "w") as f:
        json.dump({"sources": {"osm": from_osm, "osmArea": how, "geonames": from_gn}, "fetched": time.strftime("%Y-%m-%d"), "points": out}, f, ensure_ascii=False, separators=(",", ":"))
    kinds = {}
    for p in out:
        kinds[p["k"]] = kinds.get(p["k"], 0) + 1
    log(f"wrote {len(out)} settlements ({from_osm} OSM + {from_gn} GeoNames-only) → {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB)")
    log(f"by kind: {kinds}")


if __name__ == "__main__":
    main()
