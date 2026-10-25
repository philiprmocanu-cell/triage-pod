#!/usr/bin/env python
"""Write the HumBug networks and the mel filterbank the phone runs locally.

The browser cannot load the original Keras Lambda layers, so this exports the
same channels-last network `classify.py` already rebuilds: float32 weights,
the librosa mel matrix, and a no-dropout reference for three clips.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)

import classify as C  # noqa: E402

OUT = os.path.join(HERE, "..", "..", "public", "mosquito", "model")
REF = os.path.join(HERE, "phone-ref")


def forward_nodrop(model, X):
    import tensorflow as tf

    x = tf.constant(X)
    for layer in model.layers:
        if layer.__class__.__name__ == "MCDropout":
            continue
        x = layer(x, training=False)
    return x.numpy()


def dump_weights(model):
    blobs = []
    spec = []
    cursor = 0
    for layer in model.layers:
        if not layer.weights:
            continue
        kind = "conv" if layer.__class__.__name__ == "Conv2D" else "dense"
        act = layer.get_config().get("activation")
        for w in layer.weights:
            arr = w.numpy().astype(np.float32)
            blobs.append(arr.reshape(-1))
            spec.append({"kind": kind, "activation": act, "shape": list(arr.shape), "offset": cursor})
            cursor += arr.size
    return np.concatenate(blobs), spec


def main():
    import librosa

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(REF, exist_ok=True)
    models = C.models()
    mel = librosa.filters.mel(sr=C.SR, n_fft=2048, n_mels=C.N_MELS).astype(np.float32)
    mel.tofile(os.path.join(OUT, "mel.bin"))

    meta = {
        "sr": C.SR,
        "nFft": 2048,
        "hop": C.HOP,
        "nMels": C.N_MELS,
        "win": C.WIN,
        "step": C.STEP,
        "mc": C.MC_SAMPLES,
        "dropout": C.RATE,
        "species": C.SPECIES,
        "mel": {"rows": int(mel.shape[0]), "cols": int(mel.shape[1])},
        "models": {},
    }
    for key, filename in (("detect", "detect.bin"), ("species", "species.bin")):
        weights, spec = dump_weights(models[key])
        weights.tofile(os.path.join(OUT, filename))
        meta["models"][key] = {"file": filename, "weights": spec}
        print(key, weights.size, "floats", f"{weights.nbytes/1e6:.2f} MB")

    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f)

    clips = [
        "samples/anopheles-arabiensis-ihi-tanzania.wav",
        "samples/culex-field-drc.wav",
        "samples/noise-bus-stop.wav",
    ]
    for path in clips:
        y = C.load_audio(path)
        X = C.windows(y)
        det = forward_nodrop(models["detect"], X)
        sp = forward_nodrop(models["species"], X)
        name = os.path.splitext(os.path.basename(path))[0]
        X.astype(np.float32).tofile(os.path.join(REF, f"{name}.x.bin"))
        ref = {
            "file": path,
            "samples": int(y.shape[0]),
            "xShape": list(X.shape),
            "detect": det.tolist(),
            "species": sp.tolist(),
        }
        with open(os.path.join(REF, f"{name}.json"), "w") as f:
            json.dump(ref, f)
        print(name, "windows", X.shape[0], "detect", np.round(det.mean(0), 3), "species", np.round(sp.mean(0), 3))


if __name__ == "__main__":
    main()
