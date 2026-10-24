#!/usr/bin/env python
"""Mosquito wingbeat classifier for Triage Pod's "Mosquito listener".

Runs the published HumBug (University of Oxford) Bayesian CNN models from
https://github.com/HumBug-Mosquito/MozzBNN and https://github.com/HumBug-Mosquito/HumBugDB
(MIT licence) on a short WAV clip:

  * mosquito event detection  — neurips_2021_humbugdb_keras_bnn_best.hdf5 (2 classes: noise / mosquito)
  * species classification    — Win_30_Stride_5_2021_07_31_03_25_35-e69accuracy0.9608.hdf5
                                (8 classes, HumBugDB Task 2, Tanzania cup recordings)

plus a plain FFT pass that reports the fundamental wingbeat frequency and its harmonics.

The feature pipeline (8 kHz, 128-band log-mel in dB, per-clip normalisation, 30-frame windows)
is copied from MozzBNN/Code/lib/util.py so the models see exactly what they were trained on.
The .hdf5 files store their MC-dropout layers as Keras Lambda layers with Python 3.7 bytecode,
which Python 3.9 cannot unmarshal, and they are laid out channels-first, which TensorFlow cannot
run on a CPU. `load_bnn` rebuilds the same network channels-last with an explicit always-on
Dropout layer and loads the original weights; the maths is unchanged.

Usage:
  classify.py clip.wav              -> one JSON object on stdout
  classify.py --serve               -> read one JSON line {"path": "..."} per request from stdin,
                                       write one JSON line per result (keeps TensorFlow warm)
"""
import json
import os
import sys
import time

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import warnings

warnings.filterwarnings("ignore")

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "MozzBNN", "Code", "models", "BNN")
DETECT_MODEL = os.path.join(MODELS, "neurips_2021_humbugdb_keras_bnn_best.hdf5")
SPECIES_MODEL = os.path.join(MODELS, "Win_30_Stride_5_2021_07_31_03_25_35-e69accuracy0.9608.hdf5")

# HumBugDB notebooks/species_classification.ipynb, in the model's output order.
SPECIES = [
    "Anopheles arabiensis",
    "Culex pipiens complex",
    "Aedes aegypti",
    "Anopheles funestus s.s.",
    "Anopheles squamosus",
    "Anopheles coustani",
    "Mansonia uniformis",
    "Mansonia africanus",
]

SR = 8000
N_MELS = 128
HOP = 512
WIN = 30  # frames -> 30 * 512 / 8000 = 1.92 s
STEP = 5
MC_SAMPLES = 10
RATE = 0.2


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- models


def load_bnn(path):
    import h5py
    from tensorflow import keras

    class MCDropout(keras.layers.Dropout):
        """Dropout that stays on at prediction time (the Bayesian part of the BNN)."""

        def call(self, inputs, training=None):  # noqa: ARG002
            return super().call(inputs, training=True)

    with h5py.File(path, "r") as f:
        cfg = json.loads(f.attrs["model_config"])
    for layer in cfg["config"]["layers"]:
        name = layer["class_name"]
        c = layer["config"]
        if name == "Lambda":  # K.dropout(x, level=0.2) in the original
            layer["class_name"] = "MCDropout"
            layer["config"] = {"name": c["name"], "rate": RATE, "trainable": False, "dtype": "float32"}
        if name in ("Conv2D", "MaxPooling2D", "Flatten"):
            c["data_format"] = "channels_last"
        if "batch_input_shape" in c:
            c["batch_input_shape"] = [None, WIN, N_MELS, 1]
    cfg["class_name"] = "Sequential"
    model = keras.models.model_from_json(json.dumps(cfg), custom_objects={"MCDropout": MCDropout})
    model.load_weights(path, by_name=True)
    return model


_models = {}


def models():
    if not _models:
        t = time.time()
        _models["detect"] = load_bnn(DETECT_MODEL)
        _models["species"] = load_bnn(SPECIES_MODEL)
        log(f"models loaded in {time.time() - t:.1f}s")
    return _models


# ---------------------------------------------------------------- features


def load_audio(path):
    import librosa

    y, _ = librosa.load(path, sr=SR, mono=True)
    return y.astype(np.float32)


def windows(y):
    """MozzBNN util.get_feat + reshape_feat: log-mel dB, normalised per clip, 30-frame windows."""
    import librosa

    need = HOP * WIN + HOP  # at least one full window
    if len(y) < need:
        y = np.tile(y, int(np.ceil(need / max(len(y), 1))))[:need]
    feat = librosa.feature.melspectrogram(y=y, sr=SR, n_mels=N_MELS)
    feat = librosa.power_to_db(feat, ref=np.max)
    feat = (feat - np.mean(feat)) / (np.std(feat) + 1e-9)
    frames = feat.T  # (time, mels)
    n = frames.shape[0]
    starts = list(range(0, n - WIN + 1, STEP)) or [0]
    X = np.stack([frames[s : s + WIN] for s in starts])
    return X[..., None].astype(np.float32)  # (windows, 30, 128, 1)


def bnn_predict(model, X):
    outs = np.stack([model.predict(X, verbose=0) for _ in range(MC_SAMPLES)])  # (mc, windows, classes)
    mean = outs.mean(axis=(0, 1))
    per_window = outs.mean(axis=0)  # (windows, classes)
    # predictive entropy of the averaged prediction: 0 = certain, log2(classes) = clueless
    p = np.clip(mean, 1e-9, 1)
    entropy = float(-(p * np.log2(p)).sum())
    return mean, per_window, entropy


# ---------------------------------------------------------------- plain FFT


def wingbeat_fft(y):
    """Welch-averaged power spectrum; fundamental = strongest harmonic-product peak in 250–1000 Hz."""
    from scipy.signal import welch

    f, P = welch(y, fs=SR, nperseg=2048, noverlap=1536)
    P = P + 1e-12
    band = (f >= 250) & (f <= 1000)
    # harmonic product spectrum over 3 harmonics, interpolating the higher ones onto the base grid
    hps = np.log(P[band])
    for k in (2, 3):
        hps = hps + np.log(np.interp(f[band] * k, f, P))
    i = int(np.argmax(hps))
    f0 = float(f[band][i])
    # refine to the local peak of the raw spectrum within ±12 Hz
    near = (f >= f0 - 12) & (f <= f0 + 12)
    f0 = float(f[near][np.argmax(P[near])])
    p0 = float(P[near].max())
    harmonics = []
    for k in (2, 3, 4):
        fk = f0 * k
        if fk > SR / 2 - 50:
            break
        win = (f >= fk - 25) & (f <= fk + 25)
        pk = float(P[win].max())
        harmonics.append({"hz": round(float(f[win][np.argmax(P[win])])), "relativeDb": round(10 * np.log10(pk / p0), 1)})
    total = float(P[f >= 50].sum())
    ratio = float(P[band].sum() / total) if total > 0 else 0.0
    return {
        "fundamentalHz": round(f0),
        "fundamentalDbAboveMedian": round(10 * np.log10(p0 / float(np.median(P[f >= 50]))), 1),
        "harmonics": harmonics,
        "bandEnergyRatio": round(ratio, 3),
    }


# ---------------------------------------------------------------- classify


def classify(path):
    t0 = time.time()
    y = load_audio(path)
    duration = round(len(y) / SR, 2)
    if len(y) < SR // 4:
        return {"error": "clip shorter than 0.25 s", "durationS": duration}
    m = models()
    X = windows(y)
    det_mean, det_windows, det_entropy = bnn_predict(m["detect"], X)
    p_mosq = float(det_mean[1])
    sp_mean, _, sp_entropy = bnn_predict(m["species"], X)
    order = np.argsort(sp_mean)[::-1]
    top = int(order[0])
    fft = wingbeat_fft(y)
    label = SPECIES[top]
    return {
        "mosquito": p_mosq >= 0.5,
        "mosquitoProbability": round(p_mosq, 3),
        "mosquitoWindowsPositive": int((det_windows[:, 1] >= 0.5).sum()),
        "windows": int(X.shape[0]),
        "detectionEntropy": round(det_entropy, 3),
        "species": label,
        "genus": label.split()[0],
        "speciesProbability": round(float(sp_mean[top]), 3),
        "speciesEntropy": round(sp_entropy, 3),
        "speciesRanking": [{"species": SPECIES[i], "probability": round(float(sp_mean[i]), 3)} for i in order[:4]],
        **fft,
        "durationS": duration,
        "sampleRate": SR,
        "mcSamples": MC_SAMPLES,
        "models": {
            "detection": os.path.basename(DETECT_MODEL),
            "species": os.path.basename(SPECIES_MODEL),
            "source": "HumBug-Mosquito/MozzBNN + HumBugDB (Oxford, MIT)",
        },
        "ms": int((time.time() - t0) * 1000),
    }


def main(argv):
    if "--serve" in argv:
        models()  # warm up before announcing readiness
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                out = classify(req["path"])
                out["id"] = req.get("id")
            except Exception as e:  # noqa: BLE001
                out = {"error": str(e), "id": None}
                try:
                    out["id"] = json.loads(line).get("id")
                except Exception:  # noqa: BLE001
                    pass
            print(json.dumps(out), flush=True)
        return
    if len(argv) < 2:
        log(__doc__)
        sys.exit(2)
    print(json.dumps(classify(argv[1]), indent=2))


if __name__ == "__main__":
    main(sys.argv)
