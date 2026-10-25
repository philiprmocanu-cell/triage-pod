// The Oxford HumBug networks, running in the browser. The phone's microphone does the
// hearing; this file does the mel spectrogram and both CNNs. Weights are the same ones
// tools/mosquito/classify.py loads (exported by tools/mosquito/export_phone.py).
// Dropout stays on at inference time and is averaged over several passes, matching the
// Python worker. A no-dropout pass is only for the reference check.

import { vectorVerdict, type VectorVerdict } from "./vectors";
import type { Classification } from "./classifier";

type WeightSpec = { kind: string; activation: string; shape: number[]; offset: number };
type Meta = {
  sr: number;
  nFft: number;
  hop: number;
  nMels: number;
  win: number;
  step: number;
  mc: number;
  dropout: number;
  species: string[];
  mel: { rows: number; cols: number };
  models: { detect: { weights: WeightSpec[] }; species: { weights: WeightSpec[] } };
};

type Pair = { kernel: import("@tensorflow/tfjs").Tensor; bias: import("@tensorflow/tfjs").Tensor; activation: string };
type Tf = typeof import("@tensorflow/tfjs");

type Ear = {
  tf: Tf;
  meta: Meta;
  mel: Float32Array;
  detect: Pair[];
  species: Pair[];
};

let earPromise: Promise<Ear> | null = null;

export type PhoneResult = Classification & { verdict: VectorVerdict };

export function ensurePhoneModel(): Promise<void> {
  return load().then(() => undefined);
}

export async function classifyWavBlob(blob: Blob): Promise<PhoneResult> {
  const model = await load();
  const { pcm, sampleRate } = await pcmFromBlob(blob);
  return classifyPcm(model, pcm, sampleRate);
}

/** No-dropout logits for one model. Used by scripts/check-phone-ear.ts. */
export async function nodropLogits(which: "detect" | "species", x: Float32Array, nWin: number): Promise<Float32Array> {
  const model = await load();
  const classes = which === "detect" ? 2 : model.meta.species.length;
  return forward(model, which, x, nWin, classes, false);
}

export function windowsOf(y: Float32Array, mel: Float32Array, meta: Pick<Meta, "nFft" | "hop" | "nMels" | "win" | "step" | "mel">): Float32Array {
  return windows(prepare(y, meta), mel, meta);
}

async function load(): Promise<Ear> {
  if (!earPromise) earPromise = build().catch((e) => {
    earPromise = null;
    throw e;
  });
  return earPromise;
}

async function build(): Promise<Ear> {
  const tf = await import("@tensorflow/tfjs");
  if (typeof window === "undefined") await tf.setBackend("cpu");
  else {
    try {
      await tf.setBackend("webgl");
    } catch {
      await tf.setBackend("cpu");
    }
  }
  await tf.ready();
  const base = "/mosquito/model";
  const meta = (await (await fetch(`${base}/meta.json`)).json()) as Meta;
  const [melBuf, detectBuf, speciesBuf] = await Promise.all([
    fetch(`${base}/mel.bin`).then((r) => r.arrayBuffer()),
    fetch(`${base}/detect.bin`).then((r) => r.arrayBuffer()),
    fetch(`${base}/species.bin`).then((r) => r.arrayBuffer()),
  ]);
  const mel = new Float32Array(melBuf);
  if (mel.length !== meta.mel.rows * meta.mel.cols) throw new Error("mel filterbank is the wrong size");
  return {
    tf,
    meta,
    mel,
    detect: pairs(tf, new Float32Array(detectBuf), meta.models.detect.weights),
    species: pairs(tf, new Float32Array(speciesBuf), meta.models.species.weights),
  };
}

function pairs(tf: Tf, data: Float32Array, specs: WeightSpec[]): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < specs.length; i += 2) {
    const k = specs[i];
    const b = specs[i + 1];
    out.push({
      kernel: tf.tensor(data.slice(k.offset, k.offset + count(k.shape)), k.shape),
      bias: tf.tensor(data.slice(b.offset, b.offset + count(b.shape)), b.shape),
      activation: k.activation,
    });
  }
  if (out.length !== 6) throw new Error("expected 4 conv + 2 dense layers");
  return out;
}

function count(shape: number[]) {
  return shape.reduce((a, b) => a * b, 1);
}

async function classifyPcm(model: Ear, pcm: Float32Array, sampleRate: number): Promise<PhoneResult> {
  const t0 = performance.now();
  const y = resample(pcm, sampleRate, model.meta.sr);
  const prepared = prepare(y, model.meta);
  const x = windows(prepared, model.mel, model.meta);
  const nWin = x.length / (model.meta.win * model.meta.nMels);
  const det = await forward(model, "detect", x, nWin, 2, true);
  const sp = await forward(model, "species", x, nWin, model.meta.species.length, true);
  const detMean = average(det, nWin, 2);
  const spMean = average(sp, nWin, model.meta.species.length);
  const pMosq = detMean[1];
  const order = Array.from(spMean).map((p, i) => ({ species: model.meta.species[i], probability: p })).sort((a, b) => b.probability - a.probability);
  const top = order[0];
  let positive = 0;
  for (let w = 0; w < nWin; w++) if (det[w * 2 + 1] >= 0.5) positive++;
  const tone = wingbeat(prepared, model.meta.sr);
  // The detector learned the infrasonic rumble of a close recorder (about 90% of a cup
  // recording is below 30 Hz). A loudspeaker cannot play that, so its probability collapses
  // even when the wingbeat is intact. The species network still reads the wingbeat.
  const wingbeatGate = realWingbeat(tone);
  const mosquito = pMosq >= 0.5 || wingbeatGate;
  const species = top.species;
  return {
    mosquito,
    mosquitoProbability: round(pMosq, 3),
    mosquitoWindowsPositive: positive,
    windows: nWin,
    detectionEntropy: round(entropy(detMean), 3),
    species,
    genus: species.split(" ")[0],
    speciesProbability: round(top.probability, 3),
    speciesEntropy: round(entropy(spMean), 3),
    speciesRanking: order.slice(0, 4).map((s) => ({ species: s.species, probability: round(s.probability, 3) })),
    ...tone,
    wingbeatGate,
    durationS: round(y.length / model.meta.sr, 2),
    sampleRate: model.meta.sr,
    mcSamples: model.meta.mc,
    models: {
      detection: "neurips_2021_humbugdb_keras_bnn_best.hdf5",
      species: "Win_30_Stride_5_2021_07_31_03_25_35-e69accuracy0.9608.hdf5",
      source: "HumBug MozzBNN on this phone",
    },
    ms: Math.round(performance.now() - t0),
    verdict: vectorVerdict(species, mosquito),
  };
}

async function forward(model: Ear, which: "detect" | "species", x: Float32Array, nWin: number, classes: number, drop: boolean): Promise<Float32Array> {
  const { tf, meta } = model;
  const layers = model[which];
  const passes = drop ? meta.mc : 1;
  const acc = new Float32Array(nWin * classes);
  const input = tf.tensor4d(x, [nWin, meta.win, meta.nMels, 1]);
  try {
    for (let s = 0; s < passes; s++) {
      const y = tf.tidy(() => apply(tf, input, layers, drop ? meta.dropout : 0));
      const data = await y.data();
      y.dispose();
      for (let i = 0; i < data.length; i++) acc[i] += data[i];
    }
  } finally {
    input.dispose();
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= passes;
  return acc;
}

function apply(tf: Tf, x: import("@tensorflow/tfjs").Tensor, layers: Pair[], rate: number) {
  let h = x;
  const conv = (p: Pair) => {
    h = tf.relu(tf.add(tf.conv2d(h as import("@tensorflow/tfjs").Tensor4D, p.kernel as import("@tensorflow/tfjs").Tensor4D, 1, "valid"), p.bias));
  };
  const dense = (p: Pair) => {
    const z = tf.add(tf.matMul(h as import("@tensorflow/tfjs").Tensor2D, p.kernel as import("@tensorflow/tfjs").Tensor2D), p.bias);
    h = p.activation === "softmax" ? tf.softmax(z) : tf.relu(z);
  };
  const drop = () => {
    if (rate > 0) h = tf.dropout(h, rate);
  };
  conv(layers[0]);
  h = tf.maxPool(h as import("@tensorflow/tfjs").Tensor4D, [2, 2], [2, 2], "valid");
  drop();
  conv(layers[1]);
  h = tf.maxPool(h as import("@tensorflow/tfjs").Tensor4D, [2, 2], [2, 2], "valid");
  drop();
  conv(layers[2]);
  drop();
  conv(layers[3]);
  drop();
  const shape = h.shape;
  h = tf.reshape(h, [shape[0] as number, (shape[1] as number) * (shape[2] as number) * (shape[3] as number)]);
  dense(layers[4]);
  drop();
  dense(layers[5]);
  return h;
}

function prepare(y: Float32Array, meta: Pick<Meta, "hop" | "win">) {
  const need = meta.hop * meta.win + meta.hop;
  if (y.length >= need) return y;
  const tiled = new Float32Array(need);
  for (let i = 0; i < need; i++) tiled[i] = y[i % Math.max(y.length, 1)];
  return tiled;
}

function windows(y: Float32Array, mel: Float32Array, meta: Pick<Meta, "nFft" | "hop" | "nMels" | "win" | "step" | "mel">): Float32Array {
  const { nFft, hop, nMels, win, step } = meta;
  const bins = meta.mel.cols;
  const nFrames = 1 + Math.floor(y.length / hop);
  const pad = nFft >> 1;
  const padded = new Float32Array(y.length + nFft);
  padded.set(y, pad);
  const window = hann(nFft);
  const power = new Float32Array(bins * nFrames);
  const re = new Float32Array(nFft);
  const im = new Float32Array(nFft);
  for (let frame = 0; frame < nFrames; frame++) {
    const start = frame * hop;
    for (let i = 0; i < nFft; i++) re[i] = padded[start + i] * window[i];
    im.fill(0);
    fft(re, im);
    for (let k = 0; k < bins; k++) power[k * nFrames + frame] = re[k] * re[k] + im[k] * im[k];
  }
  const feat = new Float32Array(nMels * nFrames);
  for (let frame = 0; frame < nFrames; frame++) {
    for (let m = 0; m < nMels; m++) {
      let s = 0;
      const row = m * bins;
      for (let k = 0; k < bins; k++) s += mel[row + k] * power[k * nFrames + frame];
      feat[m * nFrames + frame] = s;
    }
  }
  powerToDb(feat);
  normalise(feat);
  const starts: number[] = [];
  for (let s = 0; s <= nFrames - win; s += step) starts.push(s);
  if (starts.length === 0) starts.push(0);
  const x = new Float32Array(starts.length * win * nMels);
  let o = 0;
  for (const s of starts) {
    for (let t = 0; t < win; t++) {
      for (let m = 0; m < nMels; m++) x[o++] = feat[m * nFrames + s + t];
    }
  }
  return x;
}

function powerToDb(feat: Float32Array) {
  let peak = 0;
  for (let i = 0; i < feat.length; i++) if (feat[i] > peak) peak = feat[i];
  const logRef = 10 * Math.log10(Math.max(peak, 1e-10));
  let maxDb = -Infinity;
  for (let i = 0; i < feat.length; i++) {
    const v = 10 * Math.log10(Math.max(feat[i], 1e-10)) - logRef;
    feat[i] = v;
    if (v > maxDb) maxDb = v;
  }
  const floor = maxDb - 80;
  for (let i = 0; i < feat.length; i++) if (feat[i] < floor) feat[i] = floor;
}

function normalise(feat: Float32Array) {
  let sum = 0;
  for (let i = 0; i < feat.length; i++) sum += feat[i];
  const mean = sum / feat.length;
  let v = 0;
  for (let i = 0; i < feat.length; i++) {
    const d = feat[i] - mean;
    v += d * d;
  }
  const std = Math.sqrt(v / feat.length) + 1e-9;
  for (let i = 0; i < feat.length; i++) feat[i] = (feat[i] - mean) / std;
}

function hann(n: number) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const j = i + k + half;
        const vRe = re[j] * wRe - im[j] * wIm;
        const vIm = re[j] * wIm + im[j] * wRe;
        re[j] = re[i + k] - vRe;
        im[j] = im[i + k] - vIm;
        re[i + k] += vRe;
        im[i + k] += vIm;
        const next = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = next;
      }
    }
  }
}

function resample(y: Float32Array, from: number, to: number) {
  if (from === to) return y;
  if (from > to && from % to === 0) {
    const k = from / to;
    const out = new Float32Array(Math.floor(y.length / k));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      const base = i * k;
      for (let j = 0; j < k; j++) s += y[base + j];
      out[i] = s / k;
    }
    return out;
  }
  const outLen = Math.max(1, Math.round((y.length * to) / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = y[Math.min(i0, y.length - 1)] ?? 0;
    const b = y[Math.min(i0 + 1, y.length - 1)] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

function average(perWindow: Float32Array, nWin: number, classes: number) {
  const mean = new Float32Array(classes);
  for (let w = 0; w < nWin; w++) for (let c = 0; c < classes; c++) mean[c] += perWindow[w * classes + c];
  for (let c = 0; c < classes; c++) mean[c] /= nWin;
  return mean;
}

function entropy(p: Float32Array) {
  let e = 0;
  for (let i = 0; i < p.length; i++) {
    const x = Math.min(1, Math.max(p[i], 1e-9));
    e -= x * Math.log2(x);
  }
  return e;
}

function round(n: number, d: number) {
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

// Welch peak in the wingbeat band, same idea as classify.py's wingbeat_fft.
function wingbeat(y: Float32Array, sr: number) {
  const nperseg = 2048;
  const hop = 512;
  const bins = nperseg / 2 + 1;
  const window = hann(nperseg);
  let winSum = 0;
  for (let i = 0; i < nperseg; i++) winSum += window[i] * window[i];
  const P = new Float32Array(bins);
  let segs = 0;
  for (let start = 0; start + nperseg <= y.length; start += hop) {
    const re = new Float32Array(nperseg);
    const im = new Float32Array(nperseg);
    let mean = 0;
    for (let i = 0; i < nperseg; i++) mean += y[start + i];
    mean /= nperseg;
    for (let i = 0; i < nperseg; i++) re[i] = (y[start + i] - mean) * window[i];
    fft(re, im);
    for (let k = 0; k < bins; k++) P[k] += (re[k] * re[k] + im[k] * im[k]) / winSum;
    segs++;
  }
  if (segs === 0) return { fundamentalHz: 0, fundamentalDbAboveMedian: 0, harmonics: [], bandEnergyRatio: 0 };
  for (let k = 0; k < bins; k++) P[k] = P[k] / segs + 1e-12;
  const floor = medianFilter(P, 51);
  const W = new Float32Array(bins);
  for (let k = 0; k < bins; k++) W[k] = P[k] / floor[k];
  const hz = (k: number) => (k * sr) / nperseg;
  let best = -Infinity;
  let k0 = 0;
  const kMin = Math.ceil((300 * nperseg) / sr);
  const kMax = Math.floor((1000 * nperseg) / sr);
  for (let k = kMin; k <= kMax; k++) {
    let hps = Math.log(W[k]);
    for (const harm of [2, 3]) {
      const fk = hz(k) * harm;
      const kk = Math.round((fk * nperseg) / sr);
      if (kk > 0 && kk < bins) hps += 0.5 * Math.log(W[kk]);
    }
    if (hps > best) {
      best = hps;
      k0 = k;
    }
  }
  const fGuess = hz(k0);
  let p0 = 0;
  let kf = k0;
  for (let k = 0; k < bins; k++) {
    const f = hz(k);
    if (f < fGuess - 12 || f > fGuess + 12) continue;
    if (P[k] > p0) {
      p0 = P[k];
      kf = k;
    }
  }
  const fundamentalHz = Math.round(hz(kf));
  const nearFloor = floor[kf];
  const harmonics: { hz: number; relativeDb: number }[] = [];
  for (const harm of [2, 3, 4]) {
    const fk = hz(kf) * harm;
    if (fk > sr / 2 - 50) break;
    let pk = 0;
    let kk = 0;
    for (let k = 0; k < bins; k++) {
      const f = hz(k);
      if (f < fk - 25 || f > fk + 25) continue;
      if (P[k] > pk) {
        pk = P[k];
        kk = k;
      }
    }
    harmonics.push({ hz: Math.round(hz(kk)), relativeDb: round(10 * Math.log10(pk / p0), 1) });
  }
  let band = 0;
  let audible = 0;
  for (let k = 0; k < bins; k++) {
    const f = hz(k);
    if (f >= 150 && f <= 3000) audible += P[k];
    if (f >= 300 && f <= 1000) band += P[k];
  }
  return {
    fundamentalHz,
    fundamentalDbAboveMedian: round(10 * Math.log10(p0 / nearFloor), 1),
    harmonics,
    bandEnergyRatio: round(audible > 0 ? band / audible : 0, 3),
  };
}

// A real wingbeat, not recorder rumble: a fundamental in the 300–1000 Hz band that stands
// out of the spectrum and has a harmonic stack. Measured on these clips, wingbeats sit at
// least 9.8 dB above the local median (Anopheles 10.3, the Mac mic capture 9.8, Culex 13)
// with a second harmonic between about −3 and −20 dB. Bus, speech, and construction stay
// at or below 6.3 dB, and a pure tone has no harmonic at all.
function realWingbeat(tone: { fundamentalHz: number; fundamentalDbAboveMedian: number; harmonics: { hz: number; relativeDb: number }[] }) {
  const f0 = tone.fundamentalHz;
  if (f0 < 300 || f0 > 1000) return false;
  if (tone.fundamentalDbAboveMedian < 8) return false;
  const h2 = tone.harmonics[0];
  const h3 = tone.harmonics[1];
  if (!h2 || !h3) return false;
  if (Math.abs(h2.hz - 2 * f0) > 40) return false;
  if (Math.abs(h3.hz - 3 * f0) > 60) return false;
  if (h2.relativeDb > -1 || h2.relativeDb < -24) return false;
  if (h3.relativeDb < -28) return false;
  return true;
}

function medianFilter(p: Float32Array, size: number) {
  const r = Math.floor(size / 2);
  const out = new Float32Array(p.length);
  const win = new Float64Array(size);
  for (let i = 0; i < p.length; i++) {
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (j < 0) j = 0;
      else if (j >= p.length) j = p.length - 1;
      win[k + r] = p[j];
    }
    const sorted = Array.from(win).sort((a, b) => a - b);
    out[i] = sorted[r];
  }
  return out;
}

async function pcmFromBlob(blob: Blob): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const buf = await blob.arrayBuffer();
  const wav = parseWav(buf);
  if (wav) return wav;
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(buf.slice(0));
  const pcm = new Float32Array(audio.length);
  audio.copyFromChannel(pcm, 0);
  ctx.close().catch(() => {});
  return { pcm, sampleRate: audio.sampleRate };
}

function parseWav(buf: ArrayBuffer): { pcm: Float32Array; sampleRate: number } | null {
  if (buf.byteLength < 44) return null;
  const v = new DataView(buf);
  if (v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return null;
  let offset = 12;
  let sampleRate = 8000;
  let channels = 1;
  let bits = 16;
  let data: ArrayBuffer | null = null;
  while (offset + 8 <= buf.byteLength) {
    const id = v.getUint32(offset, false);
    const size = v.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === 0x666d7420 && size >= 16) {
      channels = v.getUint16(start + 2, true);
      sampleRate = v.getUint32(start + 4, true);
      bits = v.getUint16(start + 14, true);
    } else if (id === 0x64617461) {
      data = buf.slice(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data) return null;
  const view = new DataView(data);
  const frameBytes = channels * (bits / 8);
  const frames = Math.floor(data.byteLength / frameBytes);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      const o = i * frameBytes + c * (bits / 8);
      if (bits === 16) s += view.getInt16(o, true) / 32768;
      else if (bits === 32) s += view.getFloat32(o, true);
      else s += (view.getUint8(o) - 128) / 128;
    }
    pcm[i] = s / channels;
  }
  return { pcm, sampleRate };
}
