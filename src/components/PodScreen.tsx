"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { listenForUtterance, playBlob, speakWithBrowser } from "@/lib/audio";
import { PATHWAYS, type Lang } from "@/lib/triage/tree";
import { TRAITS, TraitScan } from "@/lib/triage/traits";
import type { CameraSignals, Frame, Intake, Seen, SpeechStats, TestResults, TriageResult, Turn, Urgency } from "@/lib/triage/types";
import { CameraHandle, CameraPanel, LiveCamera } from "./CameraPanel";
import TeachAccent from "./TeachAccent";

type Region = { id: string; name: string; locale: string; languages: string[] };

const REGIONS: Region[] = [
  { id: "gt", name: "Rural Guatemala", locale: "es-GT", languages: ["es", "en"] },
  { id: "bo", name: "Rural Bolivia", locale: "es-BO", languages: ["es", "en"] },
  { id: "pe", name: "Andean Peru", locale: "es-PE", languages: ["es", "en"] },
  { id: "mx", name: "Rural Mexico", locale: "es-MX", languages: ["es", "en"] },
  { id: "us", name: "Test (English)", locale: "en-US", languages: ["en", "es"] },
];

type Status = "ready" | "looking" | "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "testing" | "done";

const STATUS_TEXT: Record<Status, string> = {
  ready: "Patient sits in front of the pod, then press Start",
  looking: "Looking at the patient…",
  idle: "Tap the microphone to talk",
  listening: "Listening — just talk, I'll know when you're done",
  transcribing: "Understanding…",
  thinking: "Checking…",
  speaking: "Speaking…",
  testing: "Watching the test…",
  done: "Check complete",
};

const URGENCY_STYLE: Record<Urgency, { label: string; cls: string }> = {
  green: { label: "Treat here", cls: "bg-emerald-600" },
  yellow: { label: "Doctor review today", cls: "bg-amber-500" },
  red: { label: "EMERGENCY — refer now", cls: "bg-red-600" },
};

const DELIVERY: Record<string, string> = { on_site: "In kit", drone: "Drone", road: "Road" };


const FRAME_EVERY_MS = 1000;
const FRAME_KEEP = 12;
const now = () => performance.now() / 1000;

export default function PodScreen() {
  const [region, setRegion] = useState(REGIONS[0]);
  const [status, setStatus] = useState<Status>("ready");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [seen, setSeen] = useState<Seen>({});
  const [tests, setTests] = useState<TestResults>({});
  const [intake, setIntake] = useState<Intake>({});
  const [language, setLanguage] = useState<Lang | null>(null);
  const [locale, setLocale] = useState<string | null>(null);
  const [camera, setCamera] = useState<LiveCamera | null>(null);
  const [smileTest, setSmileTest] = useState<CameraSignals["smileTest"]>("not_done");
  const [services, setServices] = useState({ cartesia: false, jev: false, claude: false });
  const [voiceInfo, setVoiceInfo] = useState("");
  const [saved, setSaved] = useState<{ name: string | null; community: string | null; handover: string | null } | null>(null);
  const [testClock, setTestClock] = useState<{ label: string; left: number } | null>(null);
  const [teaching, setTeaching] = useState(false);
  const [scanNow, setScanNow] = useState<TraitScan>({});
  const [scanAvg, setScanMax] = useState<TraitScan>({});
  const [scanMs, setScanMs] = useState<number | null>(null);
  const [autoStart, setAutoStart] = useState(true);
  const [level, setLevel] = useState(0);
  const listenAbort = useRef<AbortController | null>(null);
  const hearRef = useRef<() => Promise<void>>(async () => {});
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const cam = useRef<CameraHandle>(null);
  const frames = useRef<{ t: number; b64: string }[]>([]);
  const askedAt = useRef(0); // when the pod finished asking the current question

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setServices).catch(() => {});
  }, []);

  // Keep a rolling few seconds of pictures so Jev sees motion, not one frozen moment.
  useEffect(() => {
    const id = setInterval(() => {
      const b64 = cam.current?.capture(480);
      if (!b64) return;
      frames.current.push({ t: now(), b64 });
      if (frames.current.length > FRAME_KEEP) frames.current.shift();
    }, FRAME_EVERY_MS);
    return () => clearInterval(id);
  }, []);

  const recentFrames = (since: number, max = 6): Frame[] => {
    const t = now();
    let picked = frames.current.filter((f) => f.t >= since);
    if (picked.length < 3) picked = frames.current.slice(-4);
    if (picked.length > max) picked = picked.filter((_, i) => i % Math.ceil(picked.length / max) === 0).slice(-max);
    return picked.map((f) => ({ secondsAgo: t - f.t, b64: f.b64 }));
  };

  const speak = useCallback(
    async (text: string, loc: string) => {
      setStatus("speaking");
      if (services.cartesia) {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, locale: loc }),
        });
        if (res.ok) {
          setVoiceInfo(`${decodeURIComponent(res.headers.get("X-Voice-Name") ?? "")} · ${res.headers.get("X-Voice-Match")} match`);
          await playBlob(await res.blob());
          return;
        }
      }
      await speakWithBrowser(text, loc);
    },
    [services.cartesia],
  );

  const cameraSnapshot = useCallback(
    (): CameraSignals => ({
      heartRateBpm: camera?.heartRateBpm ?? null,
      heartRateConfidence: camera?.heartRateConfidence ?? 0,
      droop: camera?.droop ?? null,
      smileTest,
    }),
    [camera, smileTest],
  );

  // Runs one physical test: say the instruction, watch for N seconds, let Jev judge the pictures.
  const runTest = useCallback(
    async (test: { id: string; label: string; seconds: number; prep?: number }) => {
      setStatus("testing");
      for (let left = test.prep ?? 1; left > 0; left--) {
        setTestClock({ label: `Get ready · ${test.label}`, left });
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (test.id === "smile") cam.current?.startSmileTest();
      const burst: { t: number; b64: string }[] = [];
      const every = Math.max(500, (test.seconds * 1000) / 8);
      for (let left = test.seconds; left > 0; left -= every / 1000) {
        setTestClock({ label: test.label, left: Math.ceil(left) });
        const b64 = cam.current?.capture(480);
        if (b64) burst.push({ t: now(), b64 });
        await new Promise((r) => setTimeout(r, every));
      }
      setTestClock(null);
      let smile: CameraSignals["smileTest"] = smileTest;
      if (test.id === "smile") {
        smile = cam.current?.finishSmileTest() ?? "not_done";
        setSmileTest(smile);
      }
      const t = now();
      const res = await fetch("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId: test.id, frames: burst.map((f) => ({ secondsAgo: t - f.t, b64: f.b64 })), region: region.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Test failed");
      return { results: (data.results ?? {}) as TestResults[string], smile };
    },
    [region.name, smileTest],
  );

  // One Jev step: send the conversation + the pictures taken while the patient talked, show the
  // result, then ask the next question or run the next physical test.
  const triage = useCallback(
    async (
      stage: "look" | "answer",
      latest?: { text?: string; candidates?: Record<string, string>; speech?: SpeechStats },
      state?: { turns: Turn[]; tests: TestResults; intake: Intake; smile?: CameraSignals["smileTest"] },
    ): Promise<void> => {
      const cur = state ?? { turns, tests, intake };
      setStatus(stage === "look" ? "looking" : "thinking");
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          turns: cur.turns,
          latest,
          frames: recentFrames(askedAt.current),
          seen,
          traits: scanAvg,
          tests: cur.tests,
          intake: cur.intake,
          camera: { ...cameraSnapshot(), smileTest: cur.smile ?? smileTest },
          language,
          region: region.name,
          defaultLocale: locale ?? region.locale,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Triage failed");
      const r = data as TriageResult;
      setResult(r);
      setSeen(r.seen);
      const lang = r.patient_text ? r.language : language ?? (region.locale.startsWith("en") ? "en" : "es");
      const loc = r.patient_text ? r.locale : locale ?? region.locale;
      if (r.patient_text) {
        setLanguage(r.language);
        setLocale(r.locale);
      }

      const nextIntake = r.intake;
      setIntake(nextIntake);

      const nextTurns: Turn[] = [...cur.turns];
      if (r.patient_text) {
        const idx = nextTurns.length;
        nextTurns.push({ role: "patient", text: r.patient_text, english: lang === "en" ? r.patient_text : undefined });
        if (lang !== "en") {
          fetch("/api/english", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ translate: r.patient_text }) })
            .then((x) => x.json())
            .then((d) => d.text && setTurns((ts) => ts.map((t, i) => (i === idx ? { ...t, english: d.text } : t))))
            .catch(() => {});
        }
      }
      if (r.next) nextTurns.push({ role: "pod", text: r.next.text, english: r.next.english, asks: r.next.asks ?? undefined });
      setTurns(nextTurns);

      if (r.done) {
        setSaved({ name: null, community: null, handover: null });
        fetch("/api/registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intake: nextIntake, result: r, turns: nextTurns, region: region.name }),
        })
          .then((x) => x.json())
          .then((d) => setSaved({ name: d.name, community: d.community, handover: d.handover }))
          .catch(() => {});
      }
      if (r.next) await speak(r.next.text, loc);
      askedAt.current = now();

      if (r.next?.test && !r.done) {
        const { results, smile } = await runTest(r.next.test);
        const nextTests = { ...cur.tests, [r.next.test.id]: results ?? {} };
        setTests(nextTests);
        return triage("answer", undefined, { turns: nextTurns, tests: nextTests, intake: nextIntake, smile });
      }
      setStatus(r.done ? "done" : "idle");
      if (!r.done && services.cartesia) void hearRef.current(); // listen for the answer, no tapping
    },
    [turns, tests, intake, seen, scanAvg, cameraSnapshot, language, locale, region, speak, runTest, smileTest, services.cartesia],
  );

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus((s) => (s === "looking" ? "ready" : "idle"));
    }
  }, []);

  const onStart = () =>
    run(async () => {
      setStatus("looking");
      askedAt.current = now() - 3; // look at the last few seconds
      await triage("look");
    });

  // Hands-free: listen until the patient finishes speaking, transcribe in Spanish and English,
  // and let Jev pick the real language every turn (so switching languages works).
  const hear = async () => {
    listenAbort.current?.abort();
    const ctl = new AbortController();
    listenAbort.current = ctl;
    setStatus("listening");
    const wav = await listenForUtterance({ signal: ctl.signal, waitMs: 15000, onLevel: (l) => setLevel(l) });
    if (ctl.signal.aborted) return;
    if (!wav) {
      setStatus("idle"); // nobody spoke: the mic button starts listening again
      return;
    }
    setStatus("transcribing");
    const form = new FormData();
    form.append("audio", wav, "speech.wav");
    form.append("languages", region.languages.join(","));
    const res = await fetch("/api/stt", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Transcription failed");
    const t = data.transcripts as Record<string, { text: string; speech: SpeechStats }>;
    if (Object.values(t).every((x) => !x.text)) {
      setError("Didn't catch that — listening again.");
      return hear();
    }
    const best = t[language ?? region.languages[0]] ?? Object.values(t)[0];
    await triage("answer", { candidates: Object.fromEntries(Object.entries(t).map(([l, x]) => [l, x.text])), speech: best.speech });
  };
  hearRef.current = () => run(hear);

  const onMic = () => {
    if (status === "listening") {
      listenAbort.current?.abort();
      setStatus("idle");
    } else void run(hear);
  };

  const onTyped = () =>
    run(async () => {
      const text = typed.trim();
      if (!text) return;
      setTyped("");
      await triage("answer", { text });
    });

  const reset = () => {
    listenAbort.current?.abort();
    setTurns([]);
    setResult(null);
    setSeen({});
    setTests({});
    setIntake({});
    setLanguage(null);
    setLocale(null);
    setSmileTest("not_done");
    setStatus("ready");
    setError("");
    setVoiceInfo("");
    setSaved(null);
    setScanNow({});
    setScanMax({});
    cam.current?.reset();
  };

  // Live physical scan: every few seconds while someone is in front of the pod, Jev checks every
  // visible trait over the last three pictures. Keeps the strongest reading of each trait.
  const faceVisible = Boolean(camera?.faceVisible);
  const scanning = useRef(false);
  useEffect(() => {
    if (!faceVisible || !services.jev) return;
    const id = setInterval(async () => {
      if (scanning.current || status === "testing" || frames.current.length < 2) return;
      scanning.current = true;
      try {
        const t = now();
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frames: frames.current.slice(-3).map((f) => ({ secondsAgo: t - f.t, b64: f.b64 })) }),
        });
        if (res.ok) {
          const d = await res.json();
          if (d.person >= 0.5) {
            setScanNow(d.traits);
            // Smoothed over scans: one flicker (a single 80% reading) only reaches 40%.
            setScanMax((m) => Object.fromEntries(TRAITS.map((x) => [x.id, 0.5 * (m[x.id] ?? 0) + 0.5 * (d.traits[x.id] ?? 0)])));
            setScanMs(d.ms);
          }
        }
      } finally {
        scanning.current = false;
      }
    }, 3500);
    return () => clearInterval(id);
  }, [faceVisible, services.jev, status]);

  // Auto-start: when someone has been sitting in front of the pod for 3 seconds, it greets them.
  const faceSince = useRef<number | null>(null);
  useEffect(() => {
    if (!faceVisible) {
      faceSince.current = null;
      return;
    }
    faceSince.current ??= Date.now();
    if (autoStart && status === "ready" && services.jev && Date.now() - faceSince.current > 3000 && Object.keys(scanNow).length) onStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceVisible, camera, autoStart, status, services.jev, scanNow]);

  const busy = ["looking", "transcribing", "thinking", "speaking", "testing"].includes(status);
  const canAnswer = !busy && status !== "done" && status !== "ready";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Triage Pod</h1>
          <p className="text-xs text-slate-400">Supports the health worker. Does not diagnose. A doctor reviews every yellow and red case.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/dashboard" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Dashboard
          </Link>
          <Link href="/registry" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Registry
          </Link>
          <button
            onClick={() => setTeaching(true)}
            disabled={!services.cartesia}
            className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800 disabled:opacity-40"
          >
            Teach accent
          </button>
          <select
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
            value={region.id}
            onChange={(e) => setRegion(REGIONS.find((r) => r.id === e.target.value)!)}
            disabled={turns.length > 0}
          >
            {REGIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button onClick={reset} className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            New patient
          </button>
        </div>
      </header>

      {teaching && <TeachAccent locale={locale ?? region.locale} onClose={() => setTeaching(false)} />}

      {(!services.cartesia || !services.jev) && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-700 bg-amber-950/60 px-4 py-2 text-sm text-amber-200">
          {!services.jev && "Jev key missing — add TYPESAFE_API_KEY to .env.local. "}
          {!services.cartesia && "Cartesia key missing — using typing and the browser voice until CARTESIA_API_KEY is added."}
        </div>
      )}

      <main className="grid gap-6 p-6 md:grid-cols-[1fr_1fr]">
        <section className="space-y-4">
          <QuestionCard turns={turns} why={result?.why ?? null} status={status} />
          <div className="relative">
            <CameraPanel ref={cam} onSignals={setCamera} smileTest={smileTest} />
            {testClock && (
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between rounded-b-2xl bg-sky-900/90 px-4 py-3">
                <span className="font-semibold">{testClock.label}</span>
                <span className="text-2xl tabular-nums">{testClock.left}s</span>
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Vital
              label="Heart rate (camera)"
              value={camera?.heartRateBpm ? `${Math.round(camera.heartRateBpm)} bpm` : `hold still… ${Math.min(100, Math.round(((camera?.hrCoverage ?? 0) / 8) * 100))}%`}
              note={camera?.heartRateBpm ? `confidence ${Math.round((camera.heartRateConfidence ?? 0) * 100)}%` : "needs ~8 s of a still face"}
            />
            <Vital
              label="Face symmetry"
              value={!camera?.faceVisible ? "no face" : camera.droop?.flagged ? "DROOP" : "normal"}
              alert={Boolean(camera?.droop?.flagged)}
              note={camera?.droop?.flagged ? `patient's ${camera.droop.side} side` : `asymmetry ${Math.round((camera?.droop?.score ?? 0) * 100)}%`}
            />
            <Vital label="Smile test" value={smileTest === "not_done" ? "not done" : smileTest} alert={smileTest === "asymmetric"} note="FAST stroke check" />
          </div>

          <div className="flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4">
            {status === "ready" || status === "looking" ? (
              <button
                onClick={onStart}
                disabled={busy || !services.jev}
                className="h-20 shrink-0 rounded-2xl bg-sky-600 px-6 text-lg font-semibold hover:bg-sky-500 disabled:opacity-40"
              >
                Start check
              </button>
            ) : (
              <button
                onClick={onMic}
                disabled={(!canAnswer && status !== "listening") || !services.cartesia}
                className={`h-20 w-20 shrink-0 rounded-full text-3xl transition ${
                  status === "listening" ? "animate-pulse bg-red-600" : "bg-sky-600 hover:bg-sky-500"
                } disabled:opacity-40`}
                aria-label="Speak"
              >
                🎙️
              </button>
            )}
            <div className="flex-1 space-y-2">
              {status === "listening" && (
                <div className="h-2 overflow-hidden rounded bg-slate-800">
                  <div className="h-2 bg-red-500 transition-all" style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <p className="text-lg">{STATUS_TEXT[status]}</p>
                <label className="flex items-center gap-1.5 text-xs text-slate-400">
                  <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
                  auto-start
                </label>
              </div>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onTyped()}
                disabled={!canAnswer}
                placeholder="…or type what the patient says"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
            </div>
          </div>
          {error && <p className="rounded-lg bg-red-950 px-4 py-2 text-sm text-red-200">{error}</p>}

          <Conversation turns={turns} />
        </section>

        <section className="space-y-4">
          <ResultPanel result={result} tests={tests} intake={intake} saved={saved} voiceInfo={voiceInfo} scan={scanAvg} scanMs={scanMs} faceVisible={faceVisible} />
        </section>
      </main>
    </div>
  );
}

function Vital({ label, value, note, alert }: { label: string; value: string; note?: string; alert?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${alert ? "border-red-500 bg-red-950/60" : "border-slate-800 bg-slate-900"}`}>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-lg font-semibold ${alert ? "text-red-300" : ""}`}>{value}</p>
      {note && <p className="text-xs text-slate-500">{note}</p>}
    </div>
  );
}

function Conversation({ turns }: { turns: Turn[] }) {
  if (!turns.length) return null;
  return (
    <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">Conversation (original · English for the doctor)</p>
      {turns.map((t, i) => (
        <div key={i} className={`rounded-lg px-3 py-2 ${t.role === "pod" ? "bg-sky-950/60" : "bg-slate-800"}`}>
          <p className="text-xs text-slate-400">
            {t.role === "pod" ? (t.asks?.startsWith("test:") ? "Pod · physical test" : "Pod") : "Patient"}
          </p>
          <p>{t.text}</p>
          {t.english && t.english !== t.text && <p className="text-sm italic text-slate-400">{plain(t.english)}</p>}
        </div>
      ))}
    </div>
  );
}

// The trait -> conditions it can point to, using the triage tree (e.g. sweating -> heart attack).
function linkedConditions(traitId: string): string[] {
  const t = TRAITS.find((x) => x.id === traitId);
  if (!t) return [];
  const names: string[] = [];
  for (const p of PATHWAYS) {
    const inPath = (t.finding && (p.triggers.includes(t.finding) || p.questions.includes(t.finding))) || t.hint === p.id;
    if (inPath) names.push(...p.subtypes.filter((s) => s.urgency !== "green").slice(0, 2).map((s) => s.name));
  }
  return [...new Set(names)].slice(0, 4);
}

function ResultPanel({
  result,
  tests,
  intake,
  saved,
  voiceInfo,
  scan,
  scanMs,
  faceVisible,
}: {
  result: TriageResult | null;
  tests: TestResults;
  intake: Intake;
  saved: { name: string | null; community: string | null; handover: string | null } | null;
  voiceInfo: string;
  scan: TraitScan;
  scanMs: number | null;
  faceVisible: boolean;
}) {
  const seenTraits = TRAITS.filter((t) => (scan[t.id] ?? 0) >= 0.6).sort((a, b) => (scan[b.id] ?? 0) - (scan[a.id] ?? 0));
  const cameraCard = (
    <Card title={`Camera noticed → worth asking about · ${TRAITS.length} traits checked${scanMs ? ` · ${scanMs} ms` : ""}`}>
      {!faceVisible && !Object.keys(scan).length ? (
        <p className="text-sm text-slate-400">Waiting for someone to sit in front of the camera.</p>
      ) : seenTraits.length ? (
        seenTraits.slice(0, 6).map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <span className="font-medium">{t.label}</span>
            <span className="text-xs tabular-nums text-amber-300">{Math.round((scan[t.id] ?? 0) * 100)}%</span>
            <span className="text-slate-500">→</span>
            {linkedConditions(t.id).map((c) => (
              <span key={c} className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-200">
                {c}
              </span>
            ))}
          </div>
        ))
      ) : (
        <p className="text-sm text-slate-400">Nothing unusual seen.</p>
      )}
    </Card>
  );

  if (!result) {
    return (
      <div className="space-y-4">
        {cameraCard}
        <div className="rounded-2xl border border-dashed border-slate-700 p-5 text-sm text-slate-400">
          After 3 seconds in front of the camera the pod greets the patient and starts asking. The most likely
          conditions, and why, appear here as they talk.
        </div>
      </div>
    );
  }

  const u = URGENCY_STYLE[result.urgency];
  const top = result.causes.slice(0, 3);
  const nextPath = result.tree.find((p) => p.steps.some((s) => s.status === "next"));
  return (
    <div className="space-y-4">
      <div className={`rounded-2xl p-5 ${u.cls}`}>
        <p className="text-sm uppercase tracking-wide opacity-80">{result.done ? "Decision" : "Working decision"}</p>
        <p className="text-2xl font-bold">{u.label}</p>
        <p className="mt-1">{result.reason}</p>
        {result.rule_hits.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-sm">
            {result.rule_hits.map((h) => (
              <li key={h.id}>
                ⚑ {h.label} <span className="opacity-75">({h.evidence})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Card title="Most likely conditions">
        {top.length === 0 && (
          <p className="text-sm text-slate-400">
            {result.complaint_known
              ? "Not enough information yet — the pod is asking more questions."
              : "No assumptions yet. The pod first asks what brought the patient in."}
          </p>
        )}
        {top.map((c, i) => (
          <div key={c.name} className={`rounded-xl p-3 ${i === 0 ? "bg-slate-800" : "mt-2 bg-slate-800/50"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <p className={i === 0 ? "text-xl font-bold" : "font-semibold"}>
                {c.name}
                <span className={`ml-2 rounded px-1.5 py-0.5 align-middle text-xs ${URGENCY_STYLE[c.urgency].cls}`}>{c.urgency}</span>
                {c.early && <span className="ml-1 rounded bg-slate-700 px-1.5 py-0.5 align-middle text-xs text-slate-300">early guess</span>}
              </p>
              <span className={`tabular-nums ${i === 0 ? "text-2xl font-bold" : "text-slate-300"}`}>{Math.round(c.probability * 100)}%</span>
            </div>
            <p className="text-xs text-slate-400">{c.pathway} · {c.why}</p>
            {c.evidence.length > 0 && (
              <p className="mt-1.5 text-sm">
                <span className="text-emerald-300">Because:</span> {c.evidence.join(" · ")}
              </p>
            )}
            {c.against.length > 0 && (
              <p className="text-sm">
                <span className="text-slate-400">Against:</span> {c.against.join(" · ")}
              </p>
            )}
            {nextPath && nextPath.label === c.pathway && result.why && <p className="mt-1 text-xs text-sky-300">Checking next: {result.why}</p>}
          </div>
        ))}
      </Card>

      {cameraCard}

      {result.tree.length > 0 && (
        <Card title="Diagnostic path · if this → ask that">
          {result.tree.map((p) => (
            <div key={p.id} className="mb-3 last:mb-0">
              <div className="flex items-baseline justify-between">
                <p className="font-semibold">{p.label}</p>
                <span className="text-xs tabular-nums text-slate-400">{Math.round(p.probability * 100)}%</span>
              </div>
              <p className="text-xs text-slate-400">IF {p.openedBy.join(" + ") || "complaint"}</p>
              <ol className="mt-1 space-y-0.5 border-l border-slate-700 pl-3">
                {p.steps.map((st) => (
                  <li key={st.step} className={`flex items-center gap-2 text-sm ${st.status === "next" ? "font-semibold text-sky-300" : st.status === "waiting" ? "text-slate-500" : ""}`}>
                    <span className="w-16 shrink-0 text-xs">{STEP_BADGE[st.status]}</span>
                    {st.label}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </Card>
      )}

      {result.resources.length > 0 && (
        <Card title="Have ready for this patient">
          <div className="flex flex-wrap gap-2">
            {result.resources.slice(0, 8).map((r) => (
              <span key={r.item} className="rounded-lg bg-slate-800 px-2.5 py-1 text-sm">
                {r.item} <span className="text-xs text-slate-400">{Math.round(r.probability * 100)}% · {DELIVERY[r.delivery]}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {result.peer_group.category && (
        <Card title="Mental health">
          <p>
            Screen points to: <span className="font-semibold">{result.peer_group.category}</span>
          </p>
          <p className="text-sm text-slate-400">
            {result.peer_group.wants ? "Asked to be connected with a local peer group." : "Peer group offered at the end; never shared without consent."}
          </p>
        </Card>
      )}

      {saved && (
        <Card title="Handover note for the doctor">
          <p>{saved.handover ?? "Writing…"}</p>
        </Card>
      )}

      <details className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-400">More details</summary>
        <div className="mt-3 space-y-4">
          {(intake.name || intake.community) && (
            <div>
              <p className="text-xs text-slate-400">Patient</p>
              <p>{saved?.name ?? intake.name ?? "—"}</p>
              <p className="text-sm text-slate-400">
                {saved?.community ?? intake.community ?? ""} {intake.who ? `· ${intake.who}` : ""}
                {result.consent !== null && (result.consent >= 0.5 ? " · agreed to be saved" : " · saved without a name")}
              </p>
            </div>
          )}
          {Object.keys(tests).length > 0 && (
            <div>
              <p className="text-xs text-slate-400">Physical tests</p>
              {Object.entries(tests).map(([id, r]) => (
                <p key={id} className="text-sm">
                  {id.replace("_", " ")}:{" "}
                  {Object.keys(r ?? {}).length ? Object.entries(r ?? {}).map(([k, v]) => `${k.replaceAll("_", " ")} ${Math.round((v ?? 0) * 100)}%`).join(", ") : "not visible"}
                </p>
              ))}
            </div>
          )}
          <div>
            <p className="text-xs text-slate-400">All findings</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {result.findings.map((f) => (
                <span key={f.key} className={`rounded-full px-2.5 py-1 text-xs ${f.yes >= 0.6 ? "bg-sky-800 text-sky-100" : "bg-slate-800 text-slate-400"}`}>
                  {f.label} {Math.round(f.yes * 100)}% · {f.source}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400">Language & dialect</p>
            <p className="text-sm">
              {result.language.toUpperCase()} · {result.locale} <span className="text-slate-400">({result.locale_reason})</span>
            </p>
            {Object.keys(result.lexicon ?? {}).length > 0 && (
              <p className="text-sm">Learned words: {Object.entries(result.lexicon).map(([c, w]) => `${c} → ${w}`).join(", ")}</p>
            )}
            {voiceInfo && <p className="text-xs text-slate-500">Pod voice: {voiceInfo}</p>}
          </div>
        </div>
      </details>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">{title}</p>
      {children}
    </div>
  );
}

const STEP_BADGE: Record<string, string> = { yes: "✅ yes", no: "➖ no", unclear: "❔ unclear", next: "👉 now", waiting: "· later" };

// The one thing the patient needs to see: what the pod is asking or telling them to do right now.
function QuestionCard({ turns, why, status }: { turns: Turn[]; why: string | null; status: Status }) {
  const q = [...turns].reverse().find((t) => t.role === "pod");
  if (!q) return null;
  const isTest = q.asks?.startsWith("test:");
  return (
    <div className={`rounded-2xl border p-5 ${isTest ? "border-violet-500 bg-violet-950/60" : "border-sky-600 bg-sky-950/70"}`}>
      <p className="text-xs uppercase tracking-wide text-slate-300">
        {isTest ? "Do this now" : status === "done" ? "Pod says" : status === "listening" ? "Your turn — just talk" : "Pod is asking"}
      </p>
      <p className="mt-1 text-2xl font-semibold leading-snug">{q.text}</p>
      {q.english && q.english !== q.text && <p className="mt-1 text-sm italic text-slate-300">{plain(q.english)}</p>}
      {why && <p className="mt-2 text-xs text-sky-300">Why: {why}</p>}
    </div>
  );
}

const plain = (english: string) => english.replace(/^\[(hunch|answering the patient)\]\s*/, "");
