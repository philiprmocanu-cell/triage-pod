"""Least-cost paths over the cost surface (one Dijkstra per vehicle and season, traced back to every cluster)."""
from __future__ import annotations

import numpy as np
from skimage.graph import MCP_Geometric

from . import config as C
from .grid import Grid, haversine_km


def route_all(cost: np.ndarray, grid: Grid, start_rc: tuple[int, int], targets: list[tuple[int, int]]):
    """Returns (cumulative seconds array, list of path index arrays or None per target)."""
    mcp = MCP_Geometric(cost, fully_connected=True, sampling=grid.cell_m)
    cum, _ = mcp.find_costs([start_rc], targets, find_all_ends=True)
    paths = []
    for t in targets:
        if not np.isfinite(cum[t]):
            paths.append(None)
            continue
        try:
            paths.append(np.array(mcp.traceback(t)))
        except Exception:
            paths.append(None)
    return cum, paths


def describe(path: np.ndarray, grid: Grid, slope: np.ndarray, cover: np.ndarray, roads: np.ndarray, rivers: np.ndarray | None, wet: np.ndarray, elev: np.ndarray) -> dict:
    """Length, slope, surface mix, crossings and a simplified line for one traced path."""
    r, c = path[:, 0], path[:, 1]
    lat, lng = grid.latlng(r, c)
    seg = haversine_km(lat[:-1], lng[:-1], lat[1:], lng[1:])
    length_km = float(seg.sum())
    s = slope[r, c]
    cv = cover[r, c]
    on_road = roads[r, c] > 0
    n = len(path)
    mix = {
        "road": float(on_road.mean()),
        "open": float((~on_road & np.isin(cv, [C.BARE, C.GRASS, C.BUILT])).mean()),
        "crop": float((~on_road & (cv == C.CROP)).mean()),
        "bush": float((~on_road & np.isin(cv, [C.SHRUB, C.TREE])).mean()),
        "wet": float((~on_road & ((cv == C.WETLAND) | wet[r, c])).mean()),
        "unknown": float((cv == 0).mean()),
    }
    # crossings: separate runs of river cells, wetland or wet ground along the path (off road)
    bad = (cv == C.WETLAND) | wet[r, c]
    if rivers is not None:
        bad |= rivers[r, c] > 0
    runs = int(np.sum(np.diff(np.concatenate([[0], bad.astype(np.int8)])) == 1))
    e = elev[r, c]
    climb = float(np.nansum(np.clip(np.diff(e), 0, None)))
    # simplified line: every third cell plus the ends (about 90 m spacing), max ~400 points
    step = max(3, n // 400)
    idx = np.unique(np.concatenate([np.arange(0, n, step), [n - 1]]))
    line = [[round(float(a), 5), round(float(b), 5)] for a, b in zip(lat[idx], lng[idx])]
    return {
        "lengthKm": round(length_km, 2),
        "maxSlopeDeg": round(float(np.nanmax(s)) if n else 0.0, 1),
        "meanSlopeDeg": round(float(np.nanmean(s)) if n else 0.0, 1),
        "climbM": int(climb),
        "surface": {k: round(v, 2) for k, v in mix.items()},
        "crossings": runs,
        "line": line,
    }


def confidence(desc: dict, vehicle: str, s2_coverage: float, roads_source: str) -> float:
    """0-1: how much to trust the line before a rider has done it. Starts high and loses points for the things 30 m data gets wrong."""
    limit = C.VEHICLES[vehicle]["slope_limit_deg"]
    mix = desc["surface"]
    c = 0.9
    c -= 0.30 * mix["bush"]            # thicket and trees hide fences, fallen trunks, thorn
    c -= 0.10 * mix["crop"]            # fields have owners and furrows
    c -= 0.35 * mix["wet"]             # soft ground is guesswork at 30 m
    c -= 0.20 * (desc["maxSlopeDeg"] / limit) ** 2
    c -= min(0.3, 0.08 * desc["crossings"])
    c -= 0.15 * (1.0 - s2_coverage)    # no clear satellite scene: wetness unknown
    c -= 0.10 * mix["unknown"]
    if roads_source != "osm":
        c -= 0.05                      # only the OSRM road geometries, not the whole OSM network
    c += 0.05 * mix["road"]
    return round(float(min(0.95, max(0.1, c))), 2)
