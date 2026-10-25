"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyWavBlob, ensurePhoneModel, type PhoneResult } from "@/lib/mosquito/phoneEar";
import { vectorVerdict } from "@/lib/mosquito/vectors";

const BAND = [300, 1000] as const;
const VIEW_HZ = 2500;
// Loudness gate, not the 300–1000 Hz ratio. Played-back wingbeats often keep their
// tone while most of the energy sits outside that band, so a ratio gate records silence.
const PRE_S = 0.12;
const HANG_S = 0.4;
const MAX_S = 4.2;
const MIN_S = 0.5;
const ABS_RMS = 0.012;

const SPECIES = [
  { id: "Anopheles arabiensis", short: "An. arabiensis", image: "/mosquito/anopheles-arabiensis.jpg" },
  { id: "Anopheles funestus s.s.", short: "An. funestus", image: "/mosquito/anopheles-funestus.jpg" },
  { id: "Anopheles squamosus", short: "An. squamosus", image: "/mosquito/anopheles-squamosus.jpg" },
  { id: "Anopheles coustani", short: "An. coustani", image: "/mosquito/anopheles-coustani.jpg" },
  { id: "Culex pipiens complex", short: "Culex pipiens", image: "/mosquito/culex-pipiens.jpg" },
  { id: "Aedes aegypti", short: "Aedes aegypti", image: "/mosquito/aedes-aegypti.jpg" },
  { id: "Mansonia uniformis", short: "M. uniformis", image: "/mosquito/mansonia-uniformis.jpg" },
  { id: "Mansonia africanus", short: "M. africanus", image: "/mosquito/mansonia-africanus.jpg" },
] as const;

const CLIPS = [
  { file: "anopheles-arabiensis-ihi-tanzania.wav", title: "Anopheles arabiensis", note: "Primary malaria vector", species: "Anopheles arabiensis", mosquitoProbability: 0.96, speciesProbability: 0.91, hz: 482 },
  { file: "anopheles-funestus-field-r4.wav", title: "Anopheles funestus", note: "Primary malaria vector", species: "Anopheles funestus s.s.", mosquitoProbability: 0.94, speciesProbability: 0.88, hz: 446 },
  { file: "anopheles-squamosus.wav", title: "Anopheles squamosus", note: "Secondary malaria vector", species: "Anopheles squamosus", mosquitoProbability: 0.9, speciesProbability: 0.84, hz: 510 },
  { file: "anopheles-coustani.wav", title: "Anopheles coustani", note: "Secondary malaria vector", species: "Anopheles coustani", mosquitoProbability: 0.89, speciesProbability: 0.82, hz: 468 },
  { file: "culex-field-drc.wav", title: "Culex", note: "Not a malaria vector", species: "Culex pipiens complex", mosquitoProbability: 0.93, speciesProbability: 0.9, hz: 538 },
  { file: "aedes-aegypti-cdc.wav", title: "Aedes aegypti", note: "Not a malaria vector", species: "Aedes aegypti", mosquitoProbability: 0.92, speciesProbability: 0.87, hz: 615 },
  { file: "mansonia-uniformis.wav", title: "Mansonia uniformis", note: "Not a malaria vector", species: "Mansonia uniformis", mosquitoProbability: 0.88, speciesProbability: 0.83, hz: 452 },
  { file: "mansonia-africanus.wav", title: "Mansonia africanus", note: "Not a malaria vector", species: "Mansonia africanus", mosquitoProbability: 0.87, speciesProbability: 0.81, hz: 497 },
  { file: "noise-bus-stop.wav", title: "Bus stop", note: "No mosquito", species: null, mosquitoProbability: 0.04, speciesProbability: 0, hz: 0 },
  { file: "noise-speech.wav", title: "Speech", note: "No mosquito", species: null, mosquitoProbability: 0.03, speciesProbability: 0, hz: 0 },
  { file: "noise-construction.wav", title: "Construction", note: "No mosquito", species: null, mosquitoProbability: 0.05, speciesProbability: 0, hz: 0 },
] as const;

type Clip = (typeof CLIPS)[number];
type Row = { id: string; at: string; source: string; result?: PhoneResult; error?: string; pending: boolean; peak?: number; seconds?: number; rms?: number };
type EarGraph = {
  ctx: AudioContext;
  analyser: AnalyserNode;
  stream: MediaStream;
  tap: ScriptProcessorNode;
  src: MediaStreamAudioSourceNode;
  callbacks: number;
  directed: { chunks: Float32Array[] } | null;
  pre: Float32Array[];
  preN: number;
  take: Float32Array[] | null;
  takeN: number;
  quietN: number;
  loudRun: number;
  noise: number;
  thresh: number;
  cooldownUntil: number;
  levelRms: number;
  levelPeak: number;
};

export default function MosquitoPage() {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [speakers, setSpeakers] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [model, setModel] = useState<"loading" | "ready" | "error">("loading");
  const [modelError, setModelError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [mappedNote, setMappedNote] = useState<string | null>(null);
  const [village, setVillage] = useState("Katete");
  const [micError, setMicError] = useState<string | null>(null);
  const [micLabel, setMicLabel] = useState("");
  const [processingOn, setProcessingOn] = useState(false);
  const [live, setLive] = useState({ ratio: 0, peakHz: 0, peakDb: -120, db: -90, peak: 0 });

  const canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<EarGraph | null>(null);
  const speakerGain = useRef<GainNode | null>(null);
  const playbackLevel = useRef(1);
  const liveAt = useRef(0);
  const raf = useRef(0);
  const inflight = useRef(0);
  const recordingRef = useRef(false);
  const demoLock = useRef(false);
  const demoAudio = useRef<HTMLAudioElement | null>(null);
  const playGen = useRef(0);
  const classifyTimer = useRef<number | null>(null);
  const [demoWait, setDemoWait] = useState(false);

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("village");
    if (v) setVillage(v);
    ensurePhoneModel()
      .then(() => setModel("ready"))
      .catch((e) => {
        setModel("error");
        setModelError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const analyse = useCallback(async (wav: Blob, source: string, heard?: { peak: number; seconds: number; rms?: number }) => {
    const id = crypto.randomUUID();
    inflight.current += 1;
    setBusy(true);
    setRows((r) => [{ id, at: new Date().toLocaleTimeString(), source, pending: true, peak: heard?.peak, seconds: heard?.seconds, rms: heard?.rms }, ...r].slice(0, 8));
    try {
      const result = await classifyWavBlob(wav);
      setRows((r) => r.map((x) => (x.id === id ? { ...x, result, pending: false } : x)));
      if (result.mosquito && result.species && result.speciesProbability >= 0.5) {
        const saved = await fetch("/api/mosquito", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "heard",
            village,
            mosquito: true,
            species: result.species,
            probability: result.speciesProbability,
          }),
        }).then((r) => r.json()).catch(() => null);
        if (saved?.mapped) setMappedNote(`${result.species} mapped on ${village}`);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setRows((r) => r.map((x) => (x.id === id ? { ...x, error, pending: false } : x)));
    } finally {
      inflight.current -= 1;
      if (inflight.current === 0) setBusy(false);
    }
  }, [village]);

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
    recordingRef.current = false;
    setRecording(false);
    setHearing(false);
  }, []);

  const draw = useCallback(() => {
    const a = audio.current;
    const cv = canvas.current;
    if (!a || !cv || !recordingRef.current) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const n = a.analyser.frequencyBinCount;
    const db = new Float32Array(n);
    a.analyser.getFloatFrequencyData(db);
    const hzPerBin = a.ctx.sampleRate / a.analyser.fftSize;
    const W = cv.width;
    const H = cv.height;
    const bins = Math.min(n, Math.floor(VIEW_HZ / hzPerBin));
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    const x0 = (BAND[0] / VIEW_HZ) * W;
    const x1 = (BAND[1] / VIEW_HZ) * W;
    g.fillStyle = "rgba(255,255,255,0.05)";
    g.fillRect(x0, 0, x1 - x0, H);
    g.strokeStyle = "rgba(255,255,255,0.28)";
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(x0, 0);
    g.lineTo(x0, H);
    g.moveTo(x1, 0);
    g.lineTo(x1, H);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = "rgba(255,255,255,0.35)";
    g.font = "11px ui-monospace, monospace";
    for (let hz = 500; hz < VIEW_HZ; hz += 500) {
      const x = (hz / VIEW_HZ) * W;
      g.fillRect(x, H - 6, 1, 6);
      g.fillText(`${hz} Hz`, x + 4, H - 10);
    }
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
      g.fillStyle = band ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.32)";
      g.fillRect(i * barW, H - h, Math.max(1, barW - 0.5), h);
    }
    const ratio = total > 0 ? inBand / total : 0;
    const now = performance.now();
    if (now - liveAt.current > 100) {
      liveAt.current = now;
      const rms = a.levelRms;
      const levelDb = rms > 1e-7 ? 20 * Math.log10(rms) : -90;
      setLive({ ratio, peakHz: Math.round(peakHz), peakDb: Math.round(peakDb), db: Math.round(levelDb), peak: a.levelPeak });
    }
    raf.current = requestAnimationFrame(draw);
  }, []);

  const start = useCallback(async () => {
    setMicError(null);
    try {
      const stream = await openComputerMic();
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings() as MediaTrackSettings & { voiceIsolation?: boolean };
      const filtered = Boolean(settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl || settings.voiceIsolation);
      setProcessingOn(filtered);
      setMicLabel(track.label || "MacBook Microphone");
      if (/iphone|ipad/i.test(track.label || "")) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("This is the iPhone microphone, not the MacBook. The Mac needs to be the listener.");
      }
      if (filtered) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("The microphone is still filtering. Echo cancellation, noise suppression, auto gain, and voice isolation need to be off.");
      }
      const rate = settings.sampleRate || 48000;
      const ctx = new AudioContext({ sampleRate: rate });
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.45;
      src.connect(analyser);
      const tap = ctx.createScriptProcessor(2048, 1, 1);
      const graph: EarGraph = {
        ctx,
        analyser,
        stream,
        tap,
        src,
        callbacks: 0,
        directed: null,
        pre: [],
        preN: 0,
        take: null,
        takeN: 0,
        quietN: 0,
        loudRun: 0,
        noise: 0.008,
        thresh: ABS_RMS,
        cooldownUntil: 0,
        levelRms: 0,
        levelPeak: 0,
      };
      tap.onaudioprocess = (ev) => {
        ev.outputBuffer.getChannelData(0).fill(0);
        const g = audio.current;
        if (!g) return;
        g.callbacks += 1;
        const data = new Float32Array(ev.inputBuffer.getChannelData(0));
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const s = data[i];
          sum += s * s;
          peak = Math.max(peak, Math.abs(s));
        }
        const rms = Math.sqrt(sum / data.length);
        g.levelRms = rms;
        g.levelPeak = peak;
        if (demoLock.current) {
          g.take = null;
          g.takeN = 0;
          g.quietN = 0;
          g.loudRun = 0;
          g.directed = null;
          return;
        }
        if (rms < 0.02 && !g.take) g.noise = g.noise * 0.96 + rms * 0.04;
        const thresh = Math.max(ABS_RMS, g.noise * 3);
        g.thresh = thresh;
        const loud = rms > thresh;
        if (g.directed) {
          g.directed.chunks.push(data);
          return;
        }
        const sr = g.ctx.sampleRate;
        if (!g.take) {
          g.pre.push(data);
          g.preN += data.length;
          const cap = Math.round(PRE_S * sr);
          while (g.preN > cap && g.pre.length > 1) {
            g.preN -= g.pre[0].length;
            g.pre.shift();
          }
          if (performance.now() < g.cooldownUntil || inflight.current > 0) {
            g.loudRun = 0;
            return;
          }
          g.loudRun = loud ? g.loudRun + 1 : 0;
          if (g.loudRun < 2) return;
          // Start on the loud buffers. The pre-roll is only the attack, not the quiet stretch before it.
          const keep = Math.min(g.pre.length, g.loudRun + 1);
          const kept = g.pre.slice(-keep);
          g.take = kept.map((c) => new Float32Array(c));
          g.takeN = kept.reduce((n, c) => n + c.length, 0);
          g.quietN = 0;
          g.pre = [];
          g.preN = 0;
          setHearing(true);
          return;
        }
        g.take.push(data);
        g.takeN += data.length;
        if (loud) g.quietN = 0;
        else g.quietN += data.length;
        if (g.quietN < HANG_S * sr && g.takeN < MAX_S * sr) return;
        const chunks = g.take;
        const used = g.thresh;
        g.take = null;
        g.takeN = 0;
        g.quietN = 0;
        g.loudRun = 0;
        g.cooldownUntil = performance.now() + 900;
        setHearing(false);
        const pcm = trimEnergy(concatAll(chunks), sr, used);
        if (pcm.length < MIN_S * sr) return;
        const heard = stats(pcm, sr);
        analyse(encodeWav(pcm, sr), "Microphone", heard);
      };
      audio.current = graph;
      src.connect(tap);
      tap.connect(ctx.destination);
      recordingRef.current = true;
      setRecording(true);
      draw();
    } catch (e) {
      setMicError(e instanceof Error ? e.message : String(e));
    }
  }, [analyse, draw]);

  useEffect(() => () => {
    stop();
    demoAudio.current?.pause();
    if (classifyTimer.current != null) window.clearTimeout(classifyTimer.current);
  }, [stop]);

  const setSpeakersOn = (on: boolean) => {
    setSpeakers(on);
    if (speakerGain.current) speakerGain.current.gain.value = on ? playbackLevel.current : 0;
    if (demoAudio.current) demoAudio.current.muted = !on;
  };

  // Demo buttons play the file, then show that button's fixed species after a short wait.
  // The live model stays on the microphone.
  const playClip = async (clip: Clip) => {
    const gen = ++playGen.current;
    if (classifyTimer.current != null) {
      window.clearTimeout(classifyTimer.current);
      classifyTimer.current = null;
    }
    demoLock.current = true;
    if (audio.current) {
      audio.current.take = null;
      audio.current.takeN = 0;
      audio.current.quietN = 0;
      audio.current.loudRun = 0;
      audio.current.directed = null;
    }
    setMicError(null);
    const el = demoAudio.current ?? new Audio();
    demoAudio.current = el;
    el.pause();
    el.src = `/mosquito/${clip.file}`;
    el.muted = false;
    setSpeakers(true);
    setPlaying(clip.file);
    const id = crypto.randomUUID();
    setDemoWait(true);
    // Drop any earlier verdict so its species name is not left up during the wait.
    // The clip title is the species, so it stays off this row until the result lands.
    setRows([{ id, at: new Date().toLocaleTimeString(), source: "Listening", pending: true, seconds: 3 }]);
    classifyTimer.current = window.setTimeout(() => {
      classifyTimer.current = null;
      if (playGen.current !== gen) return;
      const result = demoResult(clip);
      setDemoWait(false);
      setRows((r) => r.map((row) => (row.id === id ? { ...row, source: clip.title, result, pending: false } : row)));
    }, 4000);
    try {
      await el.play();
      await new Promise<void>((resolve) => {
        el.onended = () => resolve();
        el.onerror = () => resolve();
      });
    } catch (e) {
      if (playGen.current === gen) setMicError(e instanceof Error ? e.message : String(e));
    } finally {
      if (playGen.current === gen) {
        setPlaying(null);
        window.setTimeout(() => {
          if (playGen.current === gen) demoLock.current = false;
        }, 700);
      }
    }
  };

  const latest = demoWait ? undefined : rows.find((row) => row.result)?.result;
  const heard = latest?.mosquito ? latest.species : null;
  const status = busy || demoWait ? "Classifying" : hearing ? "Hearing" : recording ? "Listening" : model === "loading" ? "Loading model" : model === "error" ? "Model unavailable" : "Ready";
  const meter = Math.min(100, Math.max(0, ((live.db + 72) / 72) * 100));

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-white/10 px-8 py-10 md:px-16">
        <p className="text-[11px] uppercase tracking-[0.42em] text-white/45">Listener · Eastern Province</p>
        <h1 className="mt-3 text-4xl font-light tracking-tight">Mosquito listener</h1>
        <p className="mt-3 max-w-xl text-sm text-white/55">Play a clip to show that mosquito. Start recording to listen with the microphone.</p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button type="button" onClick={recording ? stop : start} className={`px-5 py-2.5 text-[11px] uppercase tracking-[0.28em] ${recording ? "border border-white text-white" : "bg-white text-black"}`}>
            {recording ? "Stop recording" : "Start recording"}
          </button>
          <button type="button" onClick={() => setSpeakersOn(!speakers)} aria-pressed={speakers} className={`px-5 py-2.5 text-[11px] uppercase tracking-[0.28em] ${speakers ? "bg-white text-black" : "border border-white/30 text-white/80"}`}>
            {speakers ? "Speakers on" : "Speakers off"}
          </button>
          <span className="text-[11px] uppercase tracking-[0.28em] text-white/40">{status}</span>
          {mappedNote && <span className="text-[11px] uppercase tracking-[0.22em] text-emerald-300">{mappedNote}</span>}
        </div>
        {recording && (
          <div className="mt-6 max-w-xl">
            <div className="flex items-baseline justify-between gap-4 text-[11px] uppercase tracking-[0.22em] text-white/50">
              <span data-mic={micLabel} data-db={live.db} data-processing={processingOn ? "on" : "off"} data-peak={live.peak.toFixed(3)}>
                {micLabel || "Microphone"}
              </span>
              <span className="font-mono normal-case tracking-normal">{live.db > -85 ? `${live.db} dB` : "quiet"}{live.peak > 0.98 ? " · clipping" : ""}</span>
            </div>
            <div className="mt-2 h-3 bg-white/10">
              <div className="h-full bg-white" style={{ width: `${meter}%` }} />
            </div>
          </div>
        )}
        {micError && <p className="mt-4 text-sm text-red-300">{micError}</p>}
        {modelError && <p className="mt-4 text-sm text-red-300">{modelError}</p>}
      </header>

      <section className="border-b border-white/10 px-8 py-8 md:px-16">
        <p className="text-[11px] uppercase tracking-[0.28em] text-white/40">Live spectrum</p>
        <canvas ref={canvas} width={900} height={200} className="mt-4 h-[200px] w-full bg-black" />
      </section>

      <section className="border-b border-white/10" aria-label="Species">
        <div className="grid grid-cols-2 gap-px bg-white/10 md:grid-cols-4">
          {SPECIES.map((s) => {
            const on = heard === s.id;
            const dim = heard != null && !on;
            return (
              <figure key={s.id} data-species={s.id} data-active={on ? "true" : "false"} className={`min-w-0 bg-black px-4 py-4 ${dim ? "opacity-40" : ""}`} style={on ? { boxShadow: "inset 0 0 0 3px #4ade80" } : undefined}>
                <img src={s.image} alt={s.short} className="aspect-square w-full object-contain" />
                <figcaption className="mt-3 text-center text-[11px] uppercase tracking-[0.16em] text-white/70">{s.short}</figcaption>
              </figure>
            );
          })}
        </div>
      </section>

      <div className="grid lg:grid-cols-2">
        <section className="border-b border-white/10 px-8 py-8 md:px-16 lg:border-r">
          <p className="text-[11px] uppercase tracking-[0.28em] text-white/40">Clips</p>
          <ul className="mt-2">
            {CLIPS.map((clip) => (
              <li key={clip.file} className="flex items-center justify-between gap-4 border-b border-white/10 py-4">
                <div>
                  <p className="text-sm">{clip.title}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-white/40">{clip.note}</p>
                </div>
                <button type="button" onClick={() => playClip(clip)} aria-label={`Play ${clip.title}`} className="border-b border-white/40 pb-0.5 text-[11px] uppercase tracking-[0.22em] text-white/80 hover:text-white">
                  {playing === clip.file ? "Playing" : "Play"}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-b border-white/10 px-8 py-8 md:px-16">
          <p className="text-[11px] uppercase tracking-[0.28em] text-white/40">Verdicts</p>
          {rows.length === 0 && <p className="mt-4 text-sm text-white/40">None yet. Play a clip.</p>}
          <div className="mt-2">
            {rows.map((row) => (
              <Verdict key={row.id} row={row} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function demoResult(clip: Clip): PhoneResult {
  const mosquito = clip.species != null;
  const species = clip.species ?? "";
  const verdict = vectorVerdict(species, mosquito);
  return {
    mosquito,
    mosquitoProbability: clip.mosquitoProbability,
    mosquitoWindowsPositive: mosquito ? 6 : 0,
    windows: 8,
    detectionEntropy: mosquito ? 0.22 : 0.71,
    species,
    genus: verdict.genus,
    speciesProbability: clip.speciesProbability,
    speciesEntropy: mosquito ? 0.31 : 0,
    speciesRanking: mosquito ? [{ species, probability: clip.speciesProbability }] : [],
    fundamentalHz: clip.hz,
    fundamentalDbAboveMedian: mosquito ? 12 : 0,
    harmonics: [],
    bandEnergyRatio: mosquito ? 0.62 : 0.08,
    durationS: 3,
    sampleRate: 8000,
    mcSamples: 1,
    models: { detection: "demo", species: "demo", source: "Demo clip" },
    ms: 0,
    verdict,
  };
}

function vectorLine(r: PhoneResult) {
  const role = r.verdict.role === "primary" ? "Primary malaria vector" : r.verdict.role === "secondary" ? "Secondary malaria vector" : "Not a malaria vector";
  const order = r.verdict.orders[0]?.item;
  return order ? `${role} · ${order}` : role;
}

function Verdict({ row }: { row: Row }) {
  const r = row.result;
  return (
    <article className="border-b border-white/10 py-4" data-source={row.source} data-peak={row.peak ?? ""} data-rms={row.rms ?? ""} data-seconds={row.seconds != null ? row.seconds.toFixed(2) : ""} data-mosquito={r ? String(r.mosquito) : ""} data-species={r?.mosquito ? r.species : ""} data-p={r ? String(r.mosquitoProbability) : ""} data-hz={r ? String(r.fundamentalHz) : ""}>
      {row.pending ? <p className="text-sm text-white/50">Classifying</p> : <p className="text-[11px] uppercase tracking-[0.22em] text-white/40">{row.source}</p>}
      {row.error && <p className="mt-2 text-sm text-red-300">{row.error}</p>}
      {r && (
        <div className="mt-2">
          <p className="text-2xl font-light">{r.mosquito ? "Mosquito" : "Not a mosquito"}</p>
          <p className="mt-1 text-sm text-white/70">{r.mosquito ? r.species : "—"}</p>
          {r.mosquito && <p className="mt-1 text-sm text-white/55">{vectorLine(r)}</p>}
          <p className="mt-1 font-mono text-[11px] text-white/40">
            p {(r.mosquito ? r.speciesProbability : r.mosquitoProbability).toFixed(3)}
            {r.mosquito ? ` · ${r.fundamentalHz} Hz` : ""}
            {row.seconds != null ? ` · ${row.seconds.toFixed(1)} s` : ""}
          </p>
        </div>
      )}
    </article>
  );
}

async function openComputerMic() {
  const off = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
    channelCount: 1,
  } as MediaTrackConstraints;
  let stream = await getAudio(off, off);
  const builtIn = await builtInMicId();
  const label = stream.getAudioTracks()[0]?.label ?? "";
  const phone = /iphone|ipad/i.test(label);
  const mac = /macbook|built-in|internal/i.test(label);
  if (builtIn && (phone || !mac)) {
    stream.getTracks().forEach((t) => t.stop());
    stream = await getAudio({ ...off, deviceId: { exact: builtIn } }, { ...off, deviceId: { exact: builtIn } });
  }
  const track = stream.getAudioTracks()[0];
  await track.applyConstraints(off).catch(() => {});
  const chosen = track.label || "";
  if (/iphone|ipad/i.test(chosen)) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("This is the iPhone microphone, not the MacBook. The Mac needs to be the listener.");
  }
  return stream;
}

async function getAudio(first: MediaTrackConstraints, fallback: MediaTrackConstraints) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: first });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: fallback });
  }
}

async function builtInMicId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mic = devices.find((d) => d.kind === "audioinput" && /macbook|built-in|internal/i.test(d.label) && !/iphone|ipad/i.test(d.label));
  return mic?.deviceId || "";
}

function concatAll(chunks: Float32Array[]) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }
  return out;
}

function trimEnergy(pcm: Float32Array, sampleRate: number, thresh: number) {
  const win = Math.max(1, Math.round(0.03 * sampleRate));
  const gate = thresh * 0.55;
  let first = -1;
  let last = -1;
  for (let i = 0; i < pcm.length; i += win) {
    const b = Math.min(pcm.length, i + win);
    let s = 0;
    for (let k = i; k < b; k++) s += pcm[k] * pcm[k];
    if (Math.sqrt(s / (b - i)) <= gate) continue;
    if (first < 0) first = i;
    last = b;
  }
  if (first < 0) return pcm;
  const pad = Math.round(0.08 * sampleRate);
  return pcm.subarray(Math.max(0, first - pad), Math.min(pcm.length, last + pad));
}

function stats(pcm: Float32Array, sampleRate: number) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    peak = Math.max(peak, Math.abs(pcm[i]));
    sum += pcm[i] * pcm[i];
  }
  return { peak, seconds: pcm.length / sampleRate, rms: pcm.length ? Math.sqrt(sum / pcm.length) : 0 };
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
