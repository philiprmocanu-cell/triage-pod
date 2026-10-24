// Heart rate from face video (remote photoplethysmography). Each heartbeat slightly changes skin
// colour; we average the colour of forehead + cheek patches every frame and find the dominant
// rhythm between 42 and 180 beats per minute. Uses the CHROM method (de Haan & Jeanne, 2013),
// which cancels most lighting and motion changes.

type Sample = { t: number; r: number; g: number; b: number };

const WINDOW_S = 15;
const MIN_S = 8;
const FS = 30; // resample rate, Hz
const MIN_HZ = 0.7;
const MAX_HZ = 3.0;

export class HeartRateEstimator {
  private samples: Sample[] = [];

  push(t: number, r: number, g: number, b: number) {
    this.samples.push({ t, r, g, b });
    const cutoff = t - WINDOW_S;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  reset() {
    this.samples = [];
  }

  // Seconds of signal collected, for the "hold still" progress bar.
  coverage(): number {
    if (this.samples.length < 2) return 0;
    return this.samples[this.samples.length - 1].t - this.samples[0].t;
  }

  estimate(): { bpm: number; confidence: number } | null {
    if (this.coverage() < MIN_S) return null;
    const rgb = resample(this.samples, FS);
    const s = chrom(rgb);
    const { hz, confidence } = dominantFrequency(s, FS, MIN_HZ, MAX_HZ);
    return { bpm: hz * 60, confidence };
  }
}

function resample(samples: Sample[], fs: number): [number[], number[], number[]] {
  const t0 = samples[0].t;
  const n = Math.floor((samples[samples.length - 1].t - t0) * fs);
  const r: number[] = [], g: number[] = [], b: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fs;
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j], c = samples[j + 1];
    const w = c.t === a.t ? 0 : (t - a.t) / (c.t - a.t);
    r.push(a.r + (c.r - a.r) * w);
    g.push(a.g + (c.g - a.g) * w);
    b.push(a.b + (c.b - a.b) * w);
  }
  return [r, g, b];
}

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
const std = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length) || 1e-9;
};

function chrom([r, g, b]: [number[], number[], number[]]): number[] {
  const mr = mean(r), mg = mean(g), mb = mean(b);
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < r.length; i++) {
    const rn = r[i] / mr, gn = g[i] / mg, bn = b[i] / mb;
    x.push(3 * rn - 2 * gn);
    y.push(1.5 * rn + gn - 1.5 * bn);
  }
  const alpha = std(x) / std(y);
  const s = x.map((v, i) => v - alpha * y[i]);
  // Remove slow drift with a 1-second moving average.
  const k = FS;
  return s.map((v, i) => {
    const lo = Math.max(0, i - k / 2), hi = Math.min(s.length, i + k / 2);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += s[j];
    return v - sum / (hi - lo);
  });
}

function dominantFrequency(s: number[], fs: number, lo: number, hi: number) {
  const n = s.length;
  const win = s.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))); // Hann
  let best = 0, bestHz = lo, total = 0, count = 0;
  for (let hz = lo; hz <= hi; hz += 0.01) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * hz) / fs;
    for (let i = 0; i < n; i++) {
      re += win[i] * Math.cos(w * i);
      im -= win[i] * Math.sin(w * i);
    }
    const p = re * re + im * im;
    total += p;
    count++;
    if (p > best) {
      best = p;
      bestHz = hz;
    }
  }
  // Confidence: how much the peak stands out from the average power in the band.
  const ratio = best / (total / count);
  const confidence = Math.max(0, Math.min(1, (ratio - 2) / 8));
  return { hz: bestHz, confidence };
}
