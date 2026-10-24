"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { MosquitoResult } from "@/app/api/mosquito/route";

// Mosquito listener: microphone -> live FFT -> 2 s clip when the 300-1000 Hz wingbeat band lights
// up -> the Oxford HumBug models say mosquito / species -> malaria-vector verdict -> an order for
// the village. See docs/MOSQUITO.md for what this can and cannot tell you.

const BAND = [300, 1000] as const; // wingbeat fundamentals, Hz
const VIEW_HZ = 2500; // spectrum width on screen
const CLIP_S = 2.0;
const TRIGGER_RATIO = 0.45; // share of 100-2500 Hz energy that must sit inside the band
const TRIGGER_DB = -55; // and the band peak must be at least this loud (dBFS-ish)
const COOLDOWN_MS = 4000;

const SAMPLES = [
  { file: "anopheles-arabiensis-ihi-tanzania.wav", label: "Anopheles arabiensis (IHI Tanzania cup, HumBug)" },
  { file: "anopheles-funestus-field-r4.wav", label: "Field recording R4 (MozzBNN example) — model says An. funestus" },
  { file: "culex-field-drc.wav", label: "Field recording, DRC (HumBug) — model says Culex" },
  { file: "aedes-albopictus-cdc-lab.wav", label: "Aedes albopictus lab (CDC) — outside the 8 species" },
  { file: "noise-bus-stop.wav", label: "Bus stop noise (no mosquito)" },
  { file: "noise-speech.wav", label: "Room with speech (no mosquito)" },
];

type Row = { id: string; at: string; source: string; result?: MosquitoResult; error?: string; pending: boolean };

export default function MosquitoPage() {
  return (
    <Suspense>
      <Listener />
    </Suspense>
  );
}

function Listener() {
  const params = useSearchParams();
  const [village, setVillage] = useState(params.get("village") ?? "Katete");
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState<"idle" | "listening" | "recording" | "analysing">("idle");
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [sent, setSent] = useState<Record<string, string>>({});
  const [micError, setMicError] = useState<string | null>(null);
  const [live, setLive] = useState({ ratio: 0, peakHz: 0, peakDb: -120 });

  const canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<{ ctx: AudioContext; analyser: AnalyserNode; stream: MediaStream; tap: ScriptProcessorNode; src: MediaStreamAudioSourceNode } | null>(null);
  const capture = useRef<{ chunks: Float32Array[]; have: number; want: number } | null>(null);
  const lastTrigger = useRef(0);
  const raf = useRef(0);
  const player = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    fetch("/api/mosquito")
      .then((r) => r.json())
      .then((j) => setInstalled(!!j.installed))
      .catch(() => setInstalled(false));
  }, []);

  const analyse = useCallback(
    async (wav: Blob, source: string) => {
      const id = crypto.randomUUID();
      setRows((r) => [{ id, at: new Date().toLocaleTimeString(), source, pending: true }, ...r].slice(0, 12));
      setStatus((s) => (s === "idle" ? "idle" : "analysing"));
      const form = new FormData();
      form.append("audio", wav, "clip.wav");
      form.append("village", village);
      try {
        const res = await fetch("/api/mosquito", { method: "POST", body: form });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
        setRows((r) => r.map((x) => (x.id === id ? { ...x, result: j as MosquitoResult, pending: false } : x)));
      } catch (e) {
        setRows((r) => r.map((x) => (x.id === id ? { ...x, error: e instanceof Error ? e.message : String(e), pending: false } : x)));
      } finally {
        setStatus((s) => (s === "analysing" ? "listening" : s));
      }
    },
    [village],
  );

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    const a = audio.current;
    if (a) {
      a.tap.disconnect();
      a.src.disconnect();
      a.stream.getTracks().forEach((t) => t.stop());
      a.ctx.close().catch(() => {});
    }
    audio.current = null;
    capture.current = null;
    setListening(false);
    setStatus("idle");
  }, []);

  const start = useCallback(async () => {
    setMicError(null);
    try {
      // No browser "help": echo cancellation and noise suppression would eat a mosquito's tone.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      const tap = ctx.createScriptProcessor(4096, 1, 1);
      tap.onaudioprocess = (ev) => {
        const c = capture.current;
        if (!c) return;
        const data = ev.inputBuffer.getChannelData(0);
        c.chunks.push(new Float32Array(data));
        c.have += data.length;
        if (c.have >= c.want) {
          capture.current = null;
          const pcm = concat(c.chunks, c.want);
          analyse(encodeWav(pcm, ctx.sampleRate), "microphone");
        }
      };
      src.connect(tap);
      tap.connect(ctx.destination); // ScriptProcessor only runs when connected; it outputs silence
      audio.current = { ctx, analyser, stream, tap, src };
      setListening(true);
      setStatus("listening");
      draw();
    } catch (e) {
      setMicError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyse]);

  const draw = useCallback(() => {
    const a = audio.current;
    const cv = canvas.current;
    if (!a || !cv) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const n = a.analyser.frequencyBinCount;
    const db = new Float32Array(n);
    a.analyser.getFloatFrequencyData(db);
    const hzPerBin = a.ctx.sampleRate / a.analyser.fftSize;
    const W = cv.width;
    const H = cv.height;
    const bins = Math.min(n, Math.floor(VIEW_HZ / hzPerBin));
    g.fillStyle = "#070b14";
    g.fillRect(0, 0, W, H);
    // band highlight
    const x0 = (BAND[0] / VIEW_HZ) * W;
    const x1 = (BAND[1] / VIEW_HZ) * W;
    g.fillStyle = "rgba(251, 191, 36, 0.08)";
    g.fillRect(x0, 0, x1 - x0, H);
    g.strokeStyle = "rgba(251, 191, 36, 0.5)";
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(x0, 0);
    g.lineTo(x0, H);
    g.moveTo(x1, 0);
    g.lineTo(x1, H);
    g.stroke();
    g.setLineDash([]);
    // grid labels
    g.fillStyle = "#64748b";
    g.font = "11px ui-monospace, monospace";
    for (let hz = 500; hz < VIEW_HZ; hz += 500) {
      const x = (hz / VIEW_HZ) * W;
      g.fillRect(x, H - 6, 1, 6);
      g.fillText(`${hz} Hz`, x + 3, H - 8);
    }
    // bars + band energy
    let inBand = 0;
    let total = 0;
    let peakDb = -200;
    let peakHz = 0;
    const barW = W / bins;
    for (let i = 1; i < bins; i++) {
      const hz = i * hzPerBin;
      const v = db[i];
      const lin = Math.pow(10, v / 10);
      if (hz >= 100) total += lin;
      const band = hz >= BAND[0] && hz <= BAND[1];
      if (band) {
        inBand += lin;
        if (v > peakDb) {
          peakDb = v;
          peakHz = hz;
        }
      }
      const h = Math.max(0, Math.min(1, (v + 100) / 90)) * H;
      g.fillStyle = band ? "#fbbf24" : "#38bdf8";
      g.fillRect(i * barW, H - h, Math.max(1, barW - 0.5), h);
    }
    const ratio = total > 0 ? inBand / total : 0;
    setLive({ ratio, peakHz: Math.round(peakHz), peakDb: Math.round(peakDb) });
    // auto-record when the band lights up
    const now = performance.now();
    if (!capture.current && ratio >= TRIGGER_RATIO && peakDb >= TRIGGER_DB && now - lastTrigger.current > COOLDOWN_MS) {
      lastTrigger.current = now;
      capture.current = { chunks: [], have: 0, want: Math.round(CLIP_S * a.ctx.sampleRate) };
      setStatus("recording");
      setTimeout(() => setStatus((s) => (s === "recording" ? "analysing" : s)), CLIP_S * 1000);
    }
    raf.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const playSample = async (file: string, label: string) => {
    const url = `/mosquito/${file}`;
    if (player.current) {
      player.current.src = url;
      player.current.play().catch(() => {});
    }
    const blob = await (await fetch(url)).blob();
    analyse(blob, label);
  };

  const onFile = async (f: File | null) => {
    if (f) analyse(f, f.name);
  };

  const sendOrder = async (row: Row) => {
    const r = row.result;
    if (!r) return;
    setSent((s) => ({ ...s, [row.id]: "sending" }));
    const res = await fetch("/api/mosquito", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "order",
        village,
        species: r.species,
        urgency: r.verdict.role === "primary" ? "yellow" : "green",
        summary: `Mosquito listener: ${r.species} wingbeat (${r.fundamentalHz} Hz) near the pod. ${r.verdict.malariaVector ? "Malaria vector present." : "Not a malaria vector."}`,
        orders: r.verdict.orders.map((o) => ({ item: o.item, qty: o.qty })),
      }),
    });
    const j = await res.json();
    setSent((s) => ({ ...s, [row.id]: j.sent ? `Sent to ${j.village}. Watch it land on the live map.` : `Not sent: ${j.reason}` }));
  };

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-xl font-semibold">Mosquito listener</h1>
          <p className="mt-1 text-sm text-slate-400">
            The pod listens for the whine of a mosquito. A fast Fourier transform turns the sound into frequencies; a mosquito&apos;s wingbeat shows up as a
            fundamental tone between roughly 300 and 1000 Hz with harmonics above it. The University of Oxford&apos;s open-source HumBug models then say
            whether it is a mosquito and which of eight African species it most resembles. If it is an <em>Anopheles</em> that carries malaria in Zambia, the
            pod orders nets, spray or larvicide for the village.
          </p>
          <p className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            Honest limit: sound cannot tell whether an individual mosquito is infected with malaria. Nothing can, short of dissecting it. What sound can tell
            you is the species and, with a wider model, the sex. Only female <em>Anopheles</em> transmit malaria, so hearing the vector species near homes is the
            signal a health team acts on.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 text-sm">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            Village
            <input value={village} onChange={(e) => setVillage(e.target.value)} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100" />
          </label>
          <div className="text-xs text-slate-500">
            {installed === null ? "Checking classifier…" : installed ? "HumBug models installed (tools/mosquito)" : "Classifier not installed — see docs/MOSQUITO.md"}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <section className="space-y-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {!listening ? (
                <button onClick={start} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400">
                  Start listening
                </button>
              ) : (
                <button onClick={stop} className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800">
                  Stop
                </button>
              )}
              <span className="text-xs uppercase tracking-wide text-slate-400">
                {status === "idle" && "Microphone off"}
                {status === "listening" && "Listening for the 300–1000 Hz band"}
                {status === "recording" && `Recording ${CLIP_S} s clip…`}
                {status === "analysing" && "Analysing with the Oxford models…"}
              </span>
              {listening && (
                <span className="ml-auto font-mono text-xs text-slate-400">
                  band {Math.round(live.ratio * 100)}% · peak {live.peakHz} Hz @ {live.peakDb} dB
                </span>
              )}
            </div>
            <canvas ref={canvas} width={900} height={220} className="h-[220px] w-full rounded-lg border border-slate-800 bg-[#070b14]" />
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-800">
              <div className={`h-full transition-all ${live.ratio >= TRIGGER_RATIO ? "bg-amber-400" : "bg-sky-500"}`} style={{ width: `${Math.min(100, live.ratio * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Yellow bars are the wingbeat band. When at least {Math.round(TRIGGER_RATIO * 100)}% of the energy sits there, the pod records {CLIP_S} seconds on its own and sends it for
              classification. Browser echo cancellation and noise suppression are switched off so the tone is not filtered away.
            </p>
            {micError && <p className="mt-2 text-sm text-rose-300">Microphone: {micError}</p>}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Play a test clip (for a quiet room)</p>
            <div className="flex flex-wrap gap-2">
              {SAMPLES.map((s) => (
                <button key={s.file} onClick={() => playSample(s.file, s.label)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">
                  {s.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <audio ref={player} controls className="h-8" />
              <label className="cursor-pointer rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800">
                Analyse a WAV from disk
                <input type="file" accept="audio/wav,.wav" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Clips come from the HumBug / MozzBNN repositories (3 s, 8 kHz). Playing one through the speakers while the microphone is on also exercises the live
              trigger; the button itself sends the file straight to the classifier.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-slate-400">Verdicts</p>
          {rows.length === 0 && <p className="text-sm text-slate-500">No clips yet. Start listening or play a test clip.</p>}
          {rows.map((row) => (
            <Verdict key={row.id} row={row} sent={sent[row.id]} onSend={() => sendOrder(row)} />
          ))}
        </section>
      </div>
    </div>
  );
}

function Verdict({ row, sent, onSend }: { row: Row; sent?: string; onSend: () => void }) {
  const r = row.result;
  const tone = !r ? "border-slate-800" : !r.mosquito ? "border-slate-700" : r.verdict.malariaVector ? "border-rose-700" : "border-emerald-800";
  return (
    <div className={`rounded-2xl border bg-slate-900 p-4 ${tone}`}>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{row.at}</span>
        <span className="truncate pl-3">{row.source}</span>
      </div>
      {row.pending && <p className="mt-2 text-sm text-slate-400">Analysing…</p>}
      {row.error && <p className="mt-2 text-sm text-rose-300">{row.error}</p>}
      {r && (
        <div className="mt-2 space-y-2">
          <div className="flex items-baseline justify-between">
            <p className="text-lg font-semibold">{r.mosquito ? "Mosquito" : "Not a mosquito"}</p>
            <p className="font-mono text-xs text-slate-400">p = {r.mosquitoProbability.toFixed(2)}</p>
          </div>
          {r.mosquito && (
            <div>
              <p className="text-sm">
                Most like <span className="font-medium italic">{r.species}</span> <span className="font-mono text-xs text-slate-400">({(r.speciesProbability * 100).toFixed(0)}%)</span>
              </p>
              <p className="text-xs text-slate-500">
                then{" "}
                {r.speciesRanking
                  .slice(1, 3)
                  .map((s) => `${s.species} ${(s.probability * 100).toFixed(0)}%`)
                  .join(", ")}
              </p>
            </div>
          )}
          <p className="font-mono text-xs text-slate-300">
            fundamental {r.fundamentalHz} Hz · harmonics {r.harmonics.map((h) => `${h.hz} Hz (${h.relativeDb > 0 ? "+" : ""}${h.relativeDb} dB)`).join(", ") || "none"} · band {Math.round(r.bandEnergyRatio * 100)}% · {r.ms} ms
          </p>
          <div className={`rounded-lg px-3 py-2 text-sm ${r.verdict.malariaVector ? "bg-rose-950/50 text-rose-100" : "bg-slate-800/60 text-slate-200"}`}>
            <p className="font-medium">{r.verdict.malariaVector ? `Malaria vector (${r.verdict.role})` : r.mosquito ? "Not a malaria vector" : "Nothing to order"}</p>
            <p className="text-xs opacity-80">{r.verdict.note}</p>
          </div>
          {r.verdict.orders.length > 0 && (
            <div className="rounded-lg border border-slate-800 p-3">
              <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Order for {r.village}</p>
              <ul className="space-y-1 text-sm">
                {r.verdict.orders.map((o) => (
                  <li key={o.item} className="flex justify-between gap-3">
                    <span>
                      {o.qty} × {o.item} <span className="text-xs text-slate-500">— {o.why}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-3">
                <button onClick={onSend} disabled={sent === "sending" || (!!sent && sent.startsWith("Sent"))} className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-amber-300 disabled:opacity-50">
                  Send to village
                </button>
                {sent && sent !== "sending" && <span className="text-xs text-slate-400">{sent}</span>}
                {sent === "sending" && <span className="text-xs text-slate-400">Sending…</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- PCM helpers ----

function concat(chunks: Float32Array[], want: number) {
  const out = new Float32Array(want);
  let i = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, want - i);
    out.set(c.subarray(0, n), i);
    i += n;
    if (i >= want) break;
  }
  return out;
}

function encodeWav(pcm: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  let o = 44;
  for (let i = 0; i < pcm.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
