"""Per-vehicle, per-season cost surface: seconds to cross one metre of each cell.

Rules, in plain words:
- A mapped road or track is the cheapest cell for both vehicles (major roads a little faster than tracks, paths slower).
- Off road the land cover sets the speed: bare ground and grass are easy, cropland middling (field edges, furrows),
  shrub and trees slow, wetland very slow in the dry season and closed in the wet season.
- Open water (WorldCover water, or NDWI above 0.10 in that season's satellite scene) is impassable unless a road crosses it (a bridge).
- Slope above the vehicle's limit (15 degrees motorbike, 8 degrees bicycle) is impassable; below the limit the speed drops with the slope.
- In the wet season soggy ground (NDWI above 0 in the wet-season scene) halves the speed, cropland and grass slow down (mud),
  and wetland closes.
"""
from __future__ import annotations

import numpy as np

from . import config as C


def cost_surface(cover: np.ndarray, slope: np.ndarray, roads: np.ndarray, ndwi: np.ndarray | None, vehicle: str, season: str) -> np.ndarray:
    v = C.VEHICLES[vehicle]
    speed = np.full(cover.shape, v["unknown"], np.float32)  # km/h
    for cls, kmh in v["cover"].items():
        speed[cover == cls] = kmh
    if season == "wet":
        speed[cover == C.CROP] *= 0.6
        speed[cover == C.GRASS] *= 0.8
        speed[cover == C.WETLAND] = 0.0
    water = cover == C.WATER
    soft = np.zeros(cover.shape, bool)
    if ndwi is not None:
        known = ~np.isnan(ndwi)
        water |= known & (ndwi > C.NDWI_OPEN_WATER)
        if season == "wet":
            soft = known & (ndwi > C.NDWI_SOFT) & (ndwi <= C.NDWI_OPEN_WATER)
    speed[water] = 0.0
    speed[soft] *= 0.5

    # slope: linear slowdown to a quarter speed at the limit, then impassable
    limit = v["slope_limit_deg"]
    s = np.where(np.isnan(slope), limit, slope)
    factor = np.clip(1.0 - 0.75 * (s / limit), 0.25, 1.0).astype(np.float32)
    speed *= factor
    speed[s > limit] = 0.0

    # roads win over everything, including water (a mapped road across water is a bridge or a ford)
    road_kmh = v["road"]
    road_speed = np.select([roads == 1, roads == 2, roads == 3], [road_kmh, road_kmh * 0.8, road_kmh * 0.45], 0.0).astype(np.float32)
    # a steep road is still slow
    road_speed *= np.clip(1.0 - 0.5 * (s / limit), 0.35, 1.0)
    on_road = roads > 0
    speed[on_road] = np.maximum(speed[on_road], road_speed[on_road])

    sec_per_m = np.full(cover.shape, np.inf, np.float32)
    ok = speed > 0.05
    sec_per_m[ok] = 3600.0 / (speed[ok] * 1000.0)
    return sec_per_m


def surface_words(vehicle: str) -> str:
    v = C.VEHICLES[vehicle]
    c = v["cover"]
    return (
        f"{vehicle}: road {v['road']:.0f} km/h, bare {c[C.BARE]:.0f}, grass {c[C.GRASS]:.0f}, cropland {c[C.CROP]:.0f}, "
        f"shrub {c[C.SHRUB]:.0f}, trees {c[C.TREE]:.0f}, wetland {c[C.WETLAND]:.0f} (closed when wet); slope limit {v['slope_limit_deg']:.0f} degrees; water closed."
    )
