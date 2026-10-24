#!/bin/sh
# Installs the Mosquito listener's classifier: the Oxford HumBug MozzBNN repo (MIT), its 8-species
# model (in the repo) and the HumBugDB mosquito-detection model (GitHub release v1.0), in a venv.
# Needs Python 3.9+ (macOS system python3 is fine) and ~1 GB of disk (TensorFlow + the repo's WAVs).
set -e
cd "$(dirname "$0")"
[ -d MozzBNN ] || git clone --depth 1 https://github.com/HumBug-Mosquito/MozzBNN.git
MODEL=MozzBNN/Code/models/BNN/neurips_2021_humbugdb_keras_bnn_best.hdf5
[ -f "$MODEL" ] || curl -sL -o "$MODEL" https://github.com/HumBug-Mosquito/HumBugDB/releases/download/v1.0/neurips_2021_humbugdb_keras_bnn_best.hdf5
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
echo "Smoke test:"
.venv/bin/python classify.py samples/anopheles-arabiensis-ihi-tanzania.wav
