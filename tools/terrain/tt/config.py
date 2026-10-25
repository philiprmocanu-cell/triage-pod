"""Knobs for the terrain-tracks tool: where data goes, how far we look, how each vehicle moves.

Everything here is a plain number a rider could argue with. Speeds are km/h on flat ground for
each ESA WorldCover class; the slope factor and the season rules live in cost.py.
"""
from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent          # tools/terrain
REPO = HERE.parent.parent                              # repo root
DATA = HERE / "data"                                   # downloads + per-post caches (gitignored)
OUT_DIR = Path(os.environ.get("TERRAIN_OUT", REPO / "data"))  # the app reads data/terrain-*.json

APP_URL = os.environ.get("TRIAGE_APP_URL", "http://localhost:3417")

# Working grid: Copernicus GLO-30 pixel size (1 arc-second).
RES_DEG = 1.0 / 3600.0
M_PER_DEG_LAT = 111_195.0

# How far from a post we look for villages (crow-flies) and the extra margin the grid keeps so
# paths may bend around a hill outside the search circle.
SEARCH_KM = 15.0
MARGIN_KM = 3.0

# Village clusters: Open Buildings points binned at this size; a cluster needs this many buildings.
CLUSTER_BIN_M = 200
CLUSTER_MIN_BUILDINGS = 12
CLUSTER_MIN_CELL_BUILDINGS = 3
CLUSTER_MIN_FROM_POST_KM = 1.5
CLUSTERS_PER_POST = 10
BUILDING_MIN_CONFIDENCE = 0.65

# A cluster counts as "served by a road" when the nearest routable road is closer than this.
ROAD_NEAR_M = 1000.0

# ESA WorldCover 2021 v200 class codes.
TREE, SHRUB, GRASS, CROP, BUILT, BARE, SNOW, WATER, WETLAND, MANGROVE, MOSS = 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100
COVER_WORD = {TREE: "trees", SHRUB: "shrub", GRASS: "grass", CROP: "cropland", BUILT: "built-up", BARE: "bare ground", WATER: "water", WETLAND: "wetland", MANGROVE: "mangrove", MOSS: "moss", SNOW: "snow", 0: "no data"}

# Flat-ground speeds in km/h. "road" is a mapped road or track (OpenStreetMap / OSRM geometry).
VEHICLES = {
    "motorbike": {
        "slope_limit_deg": 15.0,
        "road": 40.0,
        "cover": {BARE: 25.0, GRASS: 22.0, CROP: 14.0, BUILT: 15.0, SHRUB: 8.0, TREE: 6.0, WETLAND: 5.0, MOSS: 15.0, MANGROVE: 0.0, WATER: 0.0, SNOW: 0.0},
        "unknown": 8.0,
    },
    "bicycle": {
        "slope_limit_deg": 8.0,
        "road": 15.0,
        "cover": {BARE: 12.0, GRASS: 10.0, CROP: 7.0, BUILT: 10.0, SHRUB: 4.0, TREE: 3.0, WETLAND: 3.0, MOSS: 8.0, MANGROVE: 0.0, WATER: 0.0, SNOW: 0.0},
        "unknown": 4.0,
    },
}

# Sentinel-2 NDWI thresholds: above WET_OPEN is standing water, above WET_SOFT is soft/soggy ground.
NDWI_OPEN_WATER = 0.10
NDWI_SOFT = 0.0
S2_MAX_CLOUD = 25

# Drone pads: flat, open, dry, close to houses, and at least this many 30 m cells across.
PAD_MAX_SLOPE_DEG = 3.0
PAD_CELLS = 2             # 2 x 2 cells = roughly 60 m across
PAD_SEARCH_M = 300.0

DEM_URL = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{lat}_00_{lon}_00_DEM/Copernicus_DSM_COG_10_{lat}_00_{lon}_00_DEM.tif"
WORLDCOVER_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
STAC_URL = "https://earth-search.aws.element84.com/v1/search"
OPEN_BUILDINGS_URL = "https://storage.googleapis.com/open-buildings-data/v3/points_s2_level_4_gzip/{token}_buildings.csv.gz"
OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
OSRM_URL = "https://router.project-osrm.org"

# Eastern Province, Zambia (with margin): everything outside this box is dropped when caching buildings.
PROVINCE_BBOX = (29.8, -15.3, 34.1, -9.2)  # west, south, east, north
