"""Village clusters from Open Buildings points: bin houses at 200 m, join touching bins, keep real settlements."""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from . import config as C
from .grid import Grid, haversine_km


def find_clusters(b: np.ndarray, grid: Grid, post_lat: float, post_lng: float) -> list[dict]:
    if len(b) == 0:
        return []
    bin_deg_lat = C.CLUSTER_BIN_M / C.M_PER_DEG_LAT
    bin_deg_lng = bin_deg_lat / math.cos(math.radians(grid.lat0))
    rows = ((grid.north - b[:, 0]) / bin_deg_lat).astype(int)
    cols = ((b[:, 1] - grid.west) / bin_deg_lng).astype(int)
    h = int(math.ceil((grid.north - grid.south) / bin_deg_lat)) + 1
    w = int(math.ceil((grid.east - grid.west) / bin_deg_lng)) + 1
    rows = np.clip(rows, 0, h - 1)
    cols = np.clip(cols, 0, w - 1)
    counts = np.zeros((h, w), np.int32)
    np.add.at(counts, (rows, cols), 1)
    mask = counts >= C.CLUSTER_MIN_CELL_BUILDINGS
    labels, n = ndimage.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return []
    lab_per_building = labels[rows, cols]
    out = []
    for k in range(1, n + 1):
        m = lab_per_building == k
        cnt = int(m.sum())
        if cnt < C.CLUSTER_MIN_BUILDINGS:
            continue
        lat = float(b[m, 0].mean())
        lng = float(b[m, 1].mean())
        d = float(haversine_km(post_lat, post_lng, lat, lng))
        out.append({"lat": round(lat, 5), "lng": round(lng, 5), "buildings": cnt, "km": round(d, 2), "roofAreaM2": int(b[m, 2].sum())})
    return out


def pick_clusters(clusters: list[dict], search_km: float) -> list[dict]:
    """Within the search circle, not the post's own village, biggest first (road-less ones first when known)."""
    keep = [c for c in clusters if C.CLUSTER_MIN_FROM_POST_KM <= c["km"] <= search_km]
    keep.sort(key=lambda c: (-int((c.get("roadM") or 0) > C.ROAD_NEAR_M), -c["buildings"]))
    return keep[: C.CLUSTERS_PER_POST]
