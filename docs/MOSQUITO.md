# Mosquito listener

Route: `/mosquito` (page) and `/api/mosquito` (API). Code: `src/app/mosquito/page.tsx`, `src/app/api/mosquito/route.ts`, `src/lib/mosquito/`, `tools/mosquito/`. Sample clips: `public/mosquito/`.

## What it does, in plain words

The pod's microphone listens. A fast Fourier transform (FFT) turns the sound into a spectrum. A mosquito flying nearby shows up as a steady tone between about 300 and 1000 Hz (its wingbeat) with fainter tones at 2x, 3x and 4x that frequency (harmonics). When enough of the sound sits in that band, the page records two seconds and sends the clip to a classifier. Two published models from the University of Oxford's HumBug project then say:

1. **Is it a mosquito?** (probability, from a Bayesian CNN trained on 20 hours of labelled audio)
2. **Which species does it sound most like?** (eight African species the Tanzania recordings cover)

If the species is an *Anopheles* that transmits malaria in Zambia, the page shows a red "malaria vector" verdict and a suggested order (nets, indoor spray, rapid tests, or larvicide). "Send to village" posts that order into the same live network a triaged patient uses (SpacetimeDB `reportVisit`), so it shows up on the live map as a delivery to the village.

## The honest science

- **Sound cannot tell whether a mosquito carries malaria.** No acoustic method can; infection is confirmed by dissecting or testing the insect. The product request ("use FFT to tell if mosquitoes have malaria") is not achievable as stated, and the page says so.
- **Sound can tell species, and often sex.** Wingbeat frequency and its harmonics differ by species and sex; this is the basis of Oxford's HumBug (Kiskin et al.), Stanford's Abuzz (Mukundarajan et al. 2017, phone recordings of 20 species) and the Wingbeats dataset (Potamitis).
- **Only female Anopheles transmit malaria.** In Zambia the primary vectors are *An. arabiensis* and *An. gambiae s.s.* (gambiae complex) and *An. funestus s.s.*; *An. squamosus* and *An. coustani* are secondary, outdoor-biting vectors. *Culex*, *Aedes* and *Mansonia* do not carry malaria.
- **The HumBug species model does not report sex.** HumBugDB's recordings are almost all females (the ones that bite), so the "vector" verdict assumes a female. A sex-aware model would need the Abuzz or Wingbeats data.
- **Eight species only.** Anything else (Aedes albopictus, for example) is forced into the nearest of the eight. *An. gambiae s.s.* is not one of the eight, but it is acoustically close to *An. arabiensis* (same complex) and the model tends to label it that way.
- **Species is the shaky part.** On the IHI Tanzania recording (an *An. arabiensis* colony), independent 3-second clips were labelled *arabiensis* 40 times, *Culex* 30, *funestus* 8 out of 85 detected clips. Detection (mosquito vs not) is much more reliable: the three noise recordings (bus stop, construction site, room with speech) triggered on 0–1% of windows. Treat the species as "most like" with the probability shown, and read the predictive entropy as the model's own doubt.
- **The demo clips were picked because the model answers them the way the ground truth suggests.** They are real recordings from the MozzBNN repository, but they are the clear cases, not random ones.

## What was installed (and why this repo)

**Chosen: HumBug MozzBNN + HumBugDB (University of Oxford), MIT licence.**

- Repos: <https://github.com/HumBug-Mosquito/MozzBNN> (prediction pipeline, species model in the repo) and <https://github.com/HumBug-Mosquito/HumBugDB> (dataset, training code, released detection model).
- Papers: Kiskin, I. et al. "HumBugDB: a large-scale acoustic mosquito dataset", NeurIPS 2021 Datasets and Benchmarks (arXiv:2110.07607). Kiskin, I. et al. "Automatic acoustic mosquito tagging with Bayesian neural networks", ECML-PKDD 2021. Dataset: Zenodo record 4904800 (CC BY 4.0).
- Models used (both Keras, ~6 MB each):
  - `neurips_2021_humbugdb_keras_bnn_best.hdf5` — mosquito event detection, 2 classes, from the HumBugDB v1.0 GitHub release.
  - `Win_30_Stride_5_2021_07_31_03_25_35-e69accuracy0.9608.hdf5` — species classification, 8 classes (HumBugDB Task 2; ROC AUC 0.93 micro-average on their held-out set), shipped in MozzBNN.
- Class order (from HumBugDB `notebooks/species_classification.ipynb`): An. arabiensis, Culex pipiens complex, Ae. aegypti, An. funestus s.s., An. squamosus, An. coustani, Ma. uniformis, Ma. africanus.

Why not the others: Abuzz (Stanford) has the best phone-recorded data (20 species, CC0 on Dryad) but no released model, the per-file downloads need a Dryad login and the archives are RAR (no extractor on this Mac). The Wingbeats dataset (Potamitis) needs a Kaggle login and the published classifiers (WbNet, MosquitoSong+) do not ship weights. HumBug is the only one with permissively licensed, downloadable, trained models for African malaria vectors.

### Running it on this Mac

`tools/mosquito/setup.sh` clones MozzBNN, fetches the detection model and builds `tools/mosquito/.venv` (Python 3.9, TensorFlow 2.15.1 for Keras 2, librosa 0.10). `tools/mosquito/classify.py clip.wav` prints the JSON; `--serve` keeps TensorFlow warm and answers one JSON line per clip, which is how the API uses it (first call ~10 s, then ~0.5–2 s per clip on an M-series CPU).

Two fixes were needed to run the 2021 models today, without changing their maths:
- The MC-dropout layers were saved as Keras `Lambda` layers holding Python 3.7 bytecode, which Python 3.9 cannot unmarshal. `classify.py` rebuilds the same network with an explicit always-on `Dropout(0.2)` layer and loads the original weights.
- The models are `channels_first`, which TensorFlow cannot run on a CPU. The rebuilt network is `channels_last`; the weights are identical (checked against a pure-numpy forward pass).

The feature pipeline is copied from `MozzBNN/Code/lib/util.py`: 8 kHz, 128-band log-mel in dB, normalised per clip, 1.92-second windows (30 frames), 10 Monte-Carlo dropout passes averaged.

Env: the dev server's working directory is not the checkout, so the classifier path is derived from `DATA_DIR` (already in `.env.local`), or `MOSQUITO_TOOLS` if set.

## API

`GET /api/mosquito` → `{ installed, models, species[] }` and warms the worker.

`POST /api/mosquito` multipart (`audio` = WAV, any sample rate; `village`) or JSON `{ audioBase64, village }` →

```json
{
  "mosquito": true, "mosquitoProbability": 1.0, "mosquitoWindowsPositive": 4, "windows": 4, "detectionEntropy": 0.0,
  "species": "Anopheles arabiensis", "genus": "Anopheles", "speciesProbability": 0.86, "speciesEntropy": 0.44,
  "speciesRanking": [{ "species": "Anopheles arabiensis", "probability": 0.86 }, ...],
  "fundamentalHz": 453, "fundamentalDbAboveMedian": 10.3,
  "harmonics": [{ "hz": 902, "relativeDb": -3.5 }, { "hz": 1383, "relativeDb": -14.1 }, { "hz": 1828, "relativeDb": -8.2 }],
  "bandEnergyRatio": 0.23, "durationS": 3, "sampleRate": 8000, "mcSamples": 10, "ms": 1934,
  "models": { "detection": "...", "species": "...", "source": "HumBug-Mosquito/MozzBNN + HumBugDB (Oxford, MIT)" },
  "verdict": { "malariaVector": true, "role": "primary", "carries": "...", "orders": [{ "item": "Long-lasting insecticidal nets", "qty": 20, "why": "..." }, ...], "note": "..." },
  "village": "Katete"
}
```

`POST /api/mosquito` JSON `{ "action": "order", village, species, summary, urgency, orders: [{ item, qty }] }` → calls SpacetimeDB `reportVisit` (patient name "Mosquito listener") → `{ sent, village, needs, summary }` or `{ sent: false, reason }` when `spacetime start` is not running.

## Verification (2026-10-24, this Mac)

`tools/mosquito/.venv/bin/python tools/mosquito/classify.py <clip>`:

| clip | mosquito | species | fundamental | harmonics (dB rel.) |
|---|---|---|---|---|
| `anopheles-arabiensis-ihi-tanzania.wav` (IHI Tanzania cup, HumBug) | yes, p=1.00 | An. arabiensis 0.86 (Culex 0.12) | 453 Hz | 902 (-3.5), 1383 (-14), 1828 (-8) |
| `anopheles-funestus-field-r4.wav` (MozzBNN example recording) | yes, p=1.00 | An. funestus s.s. 0.58 (arabiensis 0.42) | 602 Hz | 1215 (-20), 1793 (-13), 2391 (-29) |
| `culex-field-drc.wav` (HumBug DRC field) | yes, p=0.99 | Culex pipiens complex 0.96 | 734 Hz | 1492 (-17), 2199 (-22), 2914 (-27) |
| `noise-bus-stop.wav` | no, p=0.11 | (ignored) | 961 Hz, only 6 dB above its surroundings | — |

`curl -F audio=@public/mosquito/anopheles-arabiensis-ihi-tanzania.wav -F village=Katete localhost:3417/api/mosquito` → the JSON above with `verdict.malariaVector: true, role: primary`, orders nets/spray/rapid tests. `curl localhost:3417/mosquito` → 200. The order call returned `{"sent":true}` against the running SpacetimeDB. `npx tsc --noEmit` and `npx eslint` clean on the new files.

Note: the CDC lab recordings bundled with MozzBNN (Ae. aegypti, Ae. albopictus, Cx. quinquefasciatus at 8 kHz) are mostly *not* detected as mosquito by the Oxford model (0–4% of windows) even though they are clean lab tones; the model was trained on cup and field recordings with their own microphones. A real pod would record its own training clips.

## What the SpacetimeDB side exposes

Nothing new was needed: the order goes through the existing `reportVisit` reducer (`spacetime/spacetimedb/src/index.ts`), with `patientName: "Mosquito listener"`, `urgency: yellow` for a primary vector (`green` otherwise) and the suggested items as `needs`. If the team wants vector sightings separate from patient visits, a `report_vector(village, species, probability, fundamentalHz)` reducer and a `vector_sightings` table would let the government view count Anopheles detections per village without them looking like patients.
