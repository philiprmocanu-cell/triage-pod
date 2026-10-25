#!/bin/sh
# Builds the terrain-tracks environment: a Python venv with rasterio (reads the satellite COGs over
# HTTPS), scikit-image (least-cost paths), pyshp (roads/rivers fallback) and s2sphere (Open Buildings tiles).
# Needs Python 3.10+ (3.11 preferred) and ~1 GB of disk for the downloaded tiles in data/.
set -e
cd "$(dirname "$0")"
PY=python3
for c in python3.12 python3.11 python3.10 "$HOME/.local/bin/python3.11" "$HOME/.local/bin/python3.12"; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PY="$c"; break; fi
done
echo "Using $PY ($($PY --version))"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
mkdir -p data
echo "Smoke test (reads one DEM tile header over HTTPS):"
.venv/bin/python -c "import rasterio; ds=rasterio.open('https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S14_00_E031_00_DEM/Copernicus_DSM_COG_10_S14_00_E031_00_DEM.tif'); print(ds.width, ds.height, ds.crs)"
