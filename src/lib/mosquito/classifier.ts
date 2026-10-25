// Runs tools/mosquito/classify.py (the Oxford HumBug models) as one warm Python worker.
// TensorFlow takes ~10 s to import and load the models, so the worker stays up between
// requests and answers each clip in about a second. One JSON line in, one JSON line out.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Harmonic = { hz: number; relativeDb: number };

export type Classification = {
  mosquito: boolean;
  mosquitoProbability: number;
  mosquitoWindowsPositive: number;
  windows: number;
  detectionEntropy: number;
  species: string;
  genus: string;
  speciesProbability: number;
  speciesEntropy: number;
  speciesRanking: { species: string; probability: number }[];
  fundamentalHz: number;
  fundamentalDbAboveMedian: number;
  harmonics: Harmonic[];
  bandEnergyRatio: number;
  // True when a wingbeat fundamental in 300–1000 Hz stands above the spectrum with its harmonics.
  // Speaker playback has no recorder rumble, so this is what makes those clips count as a mosquito.
  wingbeatGate?: boolean;
  durationS: number;
  sampleRate: number;
  mcSamples: number;
  models: { detection: string; species: string; source: string };
  ms: number;
  error?: string;
};

// The dev server's cwd is not always the checkout (the rest of the app uses DATA_DIR for the same
// reason), so: MOSQUITO_TOOLS, else next to DATA_DIR, else cwd.
const ROOT = process.env.MOSQUITO_TOOLS ? path.dirname(path.dirname(process.env.MOSQUITO_TOOLS)) : process.env.DATA_DIR ? path.dirname(process.env.DATA_DIR) : process.cwd();
const TOOLS = process.env.MOSQUITO_TOOLS ?? path.join(ROOT, "tools", "mosquito");
const PYTHON = path.join(TOOLS, ".venv", "bin", "python");
const SCRIPT = path.join(TOOLS, "classify.py");
const TIMEOUT_MS = 90_000;

type Pending = { resolve: (c: Classification) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class Worker {
  proc: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending = new Map<string, Pending>();
  private buf = "";
  private dead: Error | null = null;

  constructor() {
    this.proc = spawn(PYTHON, [SCRIPT, "--serve"], { cwd: TOOLS, env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "3", PYTHONUNBUFFERED: "1" } });
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (line: string) => {
        try {
          if (JSON.parse(line).ready) resolve();
        } catch {
          /* not json */
        }
      };
      this.proc.stdout.on("data", (d: Buffer) => {
        this.buf += d.toString();
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          onReady(line);
          this.deliver(line);
        }
      });
      this.proc.stderr.on("data", (d: Buffer) => {
        const t = d.toString();
        if (/loaded|Error|Traceback/.test(t)) console.error("[mosquito worker]", t.trim().slice(0, 400));
      });
      this.proc.on("exit", (code) => {
        this.dead = new Error(`mosquito worker exited (code ${code})`);
        reject(this.dead);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(this.dead);
        }
        this.pending.clear();
        if (g.__mosquitoWorker === this) g.__mosquitoWorker = undefined;
      });
      this.proc.on("error", (e) => {
        this.dead = e;
        reject(e);
      });
    });
  }

  private deliver(line: string) {
    let msg: Classification & { id?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg.id) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  classify(file: string): Promise<Classification> {
    if (this.dead) return Promise.reject(this.dead);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("classifier timed out"));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, path: file }) + "\n");
    });
  }
}

// One worker per server process, surviving Next's hot reload.
const g = globalThis as unknown as { __mosquitoWorker?: Worker };

export function classifierInstalled() {
  return existsSync(PYTHON) && existsSync(SCRIPT) && existsSync(path.join(TOOLS, "MozzBNN", "Code", "models", "BNN", "neurips_2021_humbugdb_keras_bnn_best.hdf5"));
}

async function worker(): Promise<Worker> {
  if (!classifierInstalled()) throw new Error("Classifier not installed: run the setup in docs/MOSQUITO.md (tools/mosquito/.venv is missing)");
  if (!g.__mosquitoWorker) g.__mosquitoWorker = new Worker();
  const w = g.__mosquitoWorker;
  await w.ready;
  return w;
}

// Classify a WAV (any sample rate; the worker resamples to 8 kHz). Returns the model's JSON.
export async function classifyWav(wav: Buffer): Promise<Classification> {
  const w = await worker();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mosquito-"));
  const file = path.join(dir, "clip.wav");
  try {
    await writeFile(file, wav);
    return await w.classify(file);
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Warm the worker (first request would otherwise wait ~10 s for TensorFlow).
export function warmClassifier() {
  worker().catch((e) => console.error("[mosquito] warm-up failed:", e.message));
}
