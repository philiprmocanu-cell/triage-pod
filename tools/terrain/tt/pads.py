"""Drone landing pads: flat (<3 degrees), open (bare or grass), dry in both seasons, at least 2x2 cells (~60 m), within 300 m of houses."""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from . import config as C
from .grid import Grid, haversine_km


def pad_mask(slope: np.ndarray, cover: np.ndarray, wet_dry: np.ndarray, wet_wet: np.ndarray, roads: np.ndarray) -> np.ndarray:
    ok = (slope < C.PAD_MAX_SLOPE_DEG) & np.isin(cover, [C.BARE, C.GRASS]) & ~wet_dry & ~wet_wet & (roads == 0)
    # every cell of a PAD_CELLS x PAD_CELLS block must qualify
    return ndimage.minimum_filter(ok.astype(np.uint8), size=C.PAD_CELLS, mode="constant", cval=0).astype(bool)


def best_pad(mask: np.ndarray, slope: np.ndarray, cover: np.ndarray, grid: Grid, lat: float, lng: float, label: str, buildings: int) -> dict | None:
    r0, c0 = grid.rc(lat, lng)
    dy_m, dx_m = grid.cell_m
    ry = int(math.ceil(C.PAD_SEARCH_M / dy_m))
    rx = int(math.ceil(C.PAD_SEARCH_M / dx_m))
    rs, re = max(0, r0 - ry), min(grid.height, r0 + ry + 1)
    cs, ce = max(0, c0 - rx), min(grid.width, c0 + rx + 1)
    sub = mask[rs:re, cs:ce]
    if not sub.any():
        return None
    rr, cc = np.nonzero(sub)
    rr = rr + rs
    cc = cc + cs
    plat, plng = grid.latlng(rr, cc)
    dist_m = haversine_km(lat, lng, plat, plng) * 1000
    inside = dist_m <= C.PAD_SEARCH_M
    if not inside.any():
        return None
    rr, cc, plat, plng, dist_m = rr[inside], cc[inside], plat[inside], plng[inside], dist_m[inside]
    s = slope[rr, cc]
    bare = (cover[rr, cc] == C.BARE).astype(np.float32)
    # score: flatter and barer is better, closer to the houses is better (but not on top of them)
    score = 0.5 * (1 - s / C.PAD_MAX_SLOPE_DEG) + 0.25 * bare + 0.25 * (1 - dist_m / C.PAD_SEARCH_M)
    i = int(np.argmax(score))
    size_m = C.PAD_CELLS * min(dy_m, dx_m)
    return {
        "lat": round(float(plat[i]), 5),
        "lng": round(float(plng[i]), 5),
        "slopeDeg": round(float(s[i]), 1),
        "cover": C.COVER_WORD.get(int(cover[rr[i], cc[i]]), "unknown"),
        "sizeM": int(size_m),
        "distanceM": int(dist_m[i]),
        "score": round(float(score[i]), 2),
        "near": label,
        "buildings": int(buildings),
        "status": "proposed",
    }
