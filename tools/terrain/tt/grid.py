"""The working grid: a lat/lng box around one post at 1 arc-second (about 30 m) cells."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from rasterio.transform import from_origin

from .config import M_PER_DEG_LAT, MARGIN_KM, RES_DEG, SEARCH_KM


@dataclass
class Grid:
    west: float
    north: float
    east: float
    south: float
    width: int
    height: int
    lat0: float  # post latitude, for metre scaling

    @property
    def transform(self):
        return from_origin(self.west, self.north, RES_DEG, RES_DEG)

    @property
    def bbox(self):
        return (self.west, self.south, self.east, self.north)

    @property
    def cell_m(self):
        """(dy, dx) metres of one cell."""
        return (RES_DEG * M_PER_DEG_LAT, RES_DEG * M_PER_DEG_LAT * math.cos(math.radians(self.lat0)))

    def rc(self, lat: float, lng: float) -> tuple[int, int]:
        r = int((self.north - lat) / RES_DEG)
        c = int((lng - self.west) / RES_DEG)
        return (min(max(r, 0), self.height - 1), min(max(c, 0), self.width - 1))

    def latlng(self, r, c):
        """Cell centres; works on arrays."""
        lat = self.north - (np.asarray(r) + 0.5) * RES_DEG
        lng = self.west + (np.asarray(c) + 0.5) * RES_DEG
        return lat, lng

    def contains(self, lat: float, lng: float) -> bool:
        return self.south <= lat <= self.north and self.west <= lng <= self.east


def grid_for(lat: float, lng: float, search_km: float = SEARCH_KM, margin_km: float = MARGIN_KM) -> Grid:
    half_km = search_km + margin_km
    dlat = half_km * 1000 / M_PER_DEG_LAT
    dlng = half_km * 1000 / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    west = math.floor((lng - dlng) / RES_DEG) * RES_DEG
    east = math.ceil((lng + dlng) / RES_DEG) * RES_DEG
    south = math.floor((lat - dlat) / RES_DEG) * RES_DEG
    north = math.ceil((lat + dlat) / RES_DEG) * RES_DEG
    width = int(round((east - west) / RES_DEG))
    height = int(round((north - south) / RES_DEG))
    return Grid(west, north, east, south, width, height, lat)


def haversine_km(lat1, lng1, lat2, lng2):
    lat1, lng1, lat2, lng2 = map(np.radians, (lat1, lng1, lat2, lng2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(a))
