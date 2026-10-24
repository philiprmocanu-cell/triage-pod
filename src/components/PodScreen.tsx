"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { playBlob, Recorder, speakWithBrowser } from "@/lib/audio";
import type { Lang } from "@/lib/triage/tree";
import type { CameraSignals, Seen, SpeechStats, TriageResult, Turn, Urgency } from "@/lib/triage/types";
import { CameraHandle, CameraPanel, LiveCamera } from "./CameraPanel";

type Region = { id: string; name: string; locale: string; languages: string[] };

const REGIONS: Region[] = [
  { id: "gt", name: "Rural Guatemala", locale: "es-GT", languages: ["es", "en"] },
  { id: "bo", name: "Rural Bolivia", locale: "es-BO", languages: ["es", "en"] },
  { id: "pe", name: "Andean Peru", locale: "es-PE", languages: ["es", "en"] },
  { id: "mx", name: "Rural Mexico", locale: "es-MX", languages: ["es", "en"] },
  { id: "us", name: "Test (English)", locale: "en-US", languages: ["en", "es"] },
];

const SMILE_PROMPT: Record<Lang, string> = {
  es: "Por favor, sonría grande por tres segundos.",
  en: "Please give me a big smile for three seconds.",
};

type Status = "ready" | "looking" | "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "smile" | "done";

const STATUS_TEXT: Record<Status, string> = {
  ready: "Patient sits in front of the pod, then press Start",
  looking: "Looking at the patient…",
  idle: "Tap the microphone and answer",
  listening: "Listening… tap again when finished",
  transcribing: "Understanding…",
  thinking: "Checking…",
  speaking: "Speaking…",
  smile: "Smile test…",
  done: "Check complete",
};

const URGENCY_STYLE: Record<Urgency, { label: string; cls: string }> = {
  green: { label: "Treat here", cls: "bg-emerald-600" },
  yellow: { label: "Doctor review today", cls: "bg-amber-500" },
  red: { label: "EMERGENCY — refer now", cls: "bg-red-600" },
};

const DELIVERY: Record<string, string> = { on_site: "In kit", drone: "Drone", road: "Road" };

const SEEN_LABEL: Record<string, string> = {
  sweating: "Sweating",
  short_of_breath: "Struggling to breathe",
  face_or_arm_weakness: "Face droop",
  very_sleepy: "Drowsy / limp",
  rash: "Rash",
  sunken_eyes: "Sunken eyes",
  severe_bleeding: "Bleeding",
  injury: "Wound / injury",
  yellow_eyes: "Yellow eyes / skin",
  pale: "Very pale",
  blue_lips: "Blue lips",
  very_thin: "Very thin",
};

export default function PodScreen() {
  const [region, setRegion] = useState(REGIONS[0]);
  const [status, setStatus] = useState<Status>("ready");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [seen, setSeen] = useState<Seen>({});
  const [language, setLanguage] = useState<Lang | null>(null);
  const [locale, setLocale] = useState<string | null>(null);
  const [camera, setCamera] = useState<LiveCamera | null>(null);
  const [smileTest, setSmileTest] = useState<CameraSignals["smileTest"]>("not_done");
  const [services, setServices] = useState({ cartesia: false, jev: false, claude: false });
  const [voiceInfo, setVoiceInfo] = useState("");
  const [handover, setHandover] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const recorder = useRef(new Recorder());
  const cam = useRef<CameraHandle>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setServices).catch(() => {});
  }, []);

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

  // One Jev step: send the conversation + a fresh picture, show the result, ask the next question.
  const triage = useCallback(
    async (stage: "look" | "answer", latest?: { text?: string; candidates?: Record<string, string>; speech?: SpeechStats }) => {
      setStatus(stage === "look" ? "looking" : "thinking");
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          turns,
          latest,
          image: cam.current?.capture() ?? undefined,
          seen,
          camera: cameraSnapshot(),
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
      const lang = stage === "answer" ? r.language : language ?? (region.locale.startsWith("en") ? "en" : "es");
      const loc = stage === "answer" ? r.locale : locale ?? region.locale;
      if (stage === "answer") {
        setLanguage(r.language);
        setLocale(r.locale);
      }

      const next: Turn[] = [...turns];
      if (r.patient_text) {
        const idx = next.length;
        next.push({ role: "patient", text: r.patient_text, english: lang === "en" ? r.patient_text : undefined });
        if (lang !== "en") {
          fetch("/api/english", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ translate: r.patient_text }) })
            .then((x) => x.json())
            .then((d) => d.text && setTurns((ts) => ts.map((t, i) => (i === idx ? { ...t, english: d.text } : t))))
            .catch(() => {});
        }
      }
      if (r.next) next.push({ role: "pod", text: r.next.text, english: r.next.english, asks: r.next.asks ?? undefined });
      setTurns(next);

      if (r.done) {
        setHandover("");
        fetch("/api/english", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handover: { turns: next, result: r } }) })
          .then((x) => x.json())
          .then((d) => setHandover(d.text ?? null))
          .catch(() => setHandover(null));
      }
      if (r.next) await speak(r.next.text, loc);
      setStatus(r.done ? "done" : "idle");
    },
    [turns, seen, cameraSnapshot, language, locale, region, speak],
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

  const onStart = () => run(() => triage("look"));

  const onMic = () =>
    run(async () => {
      if (status === "listening") {
        const wav = await recorder.current.stop();
        setStatus("transcribing");
        const form = new FormData();
        form.append("audio", wav, "speech.wav");
        form.append("languages", (language ? [language] : region.languages).join(","));
        const res = await fetch("/api/stt", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Transcription failed");
        const t = data.transcripts as Record<string, { text: string; speech: SpeechStats }>;
        if (Object.values(t).every((x) => !x.text)) throw new Error("Didn't catch that — please try again.");
        const first = Object.values(t)[0];
        await triage(
          "answer",
          language
            ? { text: t[language].text, speech: t[language].speech }
            : { candidates: Object.fromEntries(Object.entries(t).map(([l, x]) => [l, x.text])), speech: first.speech },
        );
      } else {
        await recorder.current.start();
        setStatus("listening");
      }
    });

  const onTyped = () =>
    run(async () => {
      const text = typed.trim();
      if (!text) return;
      setTyped("");
      await triage("answer", { text });
    });

  const onSmileTest = () =>
    run(async () => {
      const lang = language ?? (region.locale.startsWith("en") ? "en" : "es");
      await speak(SMILE_PROMPT[lang], locale ?? region.locale);
      setStatus("smile");
      cam.current?.startSmileTest();
      await new Promise((r) => setTimeout(r, 3500));
      const outcome = cam.current?.finishSmileTest();
      setSmileTest(outcome ?? "not_done");
      setStatus(result?.done ? "done" : turns.length ? "idle" : "ready");
      if (!outcome) setError("Couldn't see a smile — try the smile test again.");
    });

  const reset = () => {
    setTurns([]);
    setResult(null);
    setSeen({});
    setLanguage(null);
    setLocale(null);
    setSmileTest("not_done");
    setStatus("ready");
    setError("");
    setVoiceInfo("");
    setHandover(null);
    cam.current?.reset();
  };

  const busy = ["looking", "transcribing", "thinking", "speaking", "smile"].includes(status);
  const canAnswer = !busy && status !== "done" && status !== "ready";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Triage Pod</h1>
          <p className="text-xs text-slate-400">Supports the health worker. Does not diagnose. A doctor reviews every yellow and red case.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
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

      {(!services.cartesia || !services.jev) && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-700 bg-amber-950/60 px-4 py-2 text-sm text-amber-200">
          {!services.jev && "Jev key missing — add TYPESAFE_API_KEY to .env.local. "}
          {!services.cartesia && "Cartesia key missing — using typing and the browser voice until CARTESIA_API_KEY is added."}
        </div>
      )}

      <main className="grid gap-6 p-6 lg:grid-cols-[1.1fr_1fr]">
        <section className="space-y-4">
          <CameraPanel ref={cam} onSignals={setCamera} smileTest={smileTest} />
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
                disabled={!canAnswer && status !== "listening" || !services.cartesia}
                className={`h-20 w-20 shrink-0 rounded-full text-3xl transition ${
                  status === "listening" ? "animate-pulse bg-red-600" : "bg-sky-600 hover:bg-sky-500"
                } disabled:opacity-40`}
                aria-label="Speak"
              >
                🎙️
              </button>
            )}
            <div className="flex-1 space-y-2">
              <p className="text-lg">{STATUS_TEXT[status]}</p>
              <div className="flex gap-2">
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onTyped()}
                  disabled={!canAnswer}
                  placeholder="…or type what the patient says"
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                />
                <button
                  onClick={onSmileTest}
                  disabled={busy}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-40"
                >
                  Smile test
                </button>
              </div>
            </div>
          </div>
          {error && <p className="rounded-lg bg-red-950 px-4 py-2 text-sm text-red-200">{error}</p>}

          <Conversation turns={turns} />
        </section>

        <section className="space-y-4">
          <ResultPanel result={result} voiceInfo={voiceInfo} handover={handover} />
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
          <p className="text-xs text-slate-400">{t.role === "pod" ? "Pod" : "Patient"}</p>
          <p>{t.text}</p>
          {t.english && t.english !== t.text && <p className="text-sm italic text-slate-400">{t.english}</p>}
        </div>
      ))}
    </div>
  );
}

function ResultPanel({ result, voiceInfo, handover }: { result: TriageResult | null; voiceInfo: string; handover: string | null }) {
  if (!result) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-700 p-8 text-center text-slate-400">
        1. The pod looks at the patient for visible signs. 2. It asks questions in their own language, picked from
        what it saw and heard. 3. Each answer narrows down the likely condition and what the patient needs.
      </div>
    );
  }
  const u = URGENCY_STYLE[result.urgency];
  const seenList = Object.entries(result.seen)
    .filter(([, v]) => (v ?? 0) >= 0.3)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return (
    <div className="space-y-4">
      <div className={`rounded-2xl p-5 ${u.cls}`}>
        <p className="text-sm uppercase tracking-wide opacity-80">{result.done ? "Decision" : "Working decision"}</p>
        <p className="text-2xl font-bold">{u.label}</p>
        <p className="mt-1">{result.reason}</p>
        <p className="mt-2 text-sm font-semibold">{result.doctor_required ? "Doctor required" : "No doctor needed"}</p>
      </div>

      {result.rule_hits.length > 0 && (
        <Card title="Safety rules triggered (fixed rules, not AI)">
          {result.rule_hits.map((h) => (
            <div key={h.id} className="flex items-start gap-2 py-1">
              <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${URGENCY_STYLE[h.urgency].cls}`} />
              <div>
                <p className="font-medium">{h.label}</p>
                <p className="text-xs text-slate-400">
                  {h.source === "camera" ? "Camera" : "Words"}: {h.evidence}
                </p>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card title={`What Jev sees on camera · answered in ${result.jev_ms} ms`}>
        {seenList.length ? (
          seenList.map(([k, v]) => <Bar key={k} label={SEEN_LABEL[k] ?? k} value={v ?? 0} />)
        ) : (
          <p className="text-sm text-slate-400">No visible warning signs.</p>
        )}
      </Card>

      {result.pathways.length > 0 && (
        <Card title="Pathways explored → sub-classification">
          {result.pathways.map((p) => (
            <div key={p.id} className="py-1.5">
              <Bar label={p.label} value={p.probability} />
              <div className="ml-4 border-l border-slate-700 pl-3">
                {p.subtypes.slice(0, 3).map((s) => (
                  <Bar key={s.name} label={s.name} value={s.probability} tag={s.urgency === "red" ? "red" : undefined} small />
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card title="Likely causes (pathway × sub-classification)">
        {result.causes.length ? (
          result.causes.map((c) => <Bar key={c.name} label={c.name} value={c.probability} hint={c.why} />)
        ) : (
          <p className="text-sm text-slate-400">Waiting for the patient&apos;s answer.</p>
        )}
      </Card>

      <Card title="Resources this patient will likely need">
        {result.resources.length ? (
          result.resources.map((r) => <Bar key={r.item} label={r.item} value={r.probability} tag={DELIVERY[r.delivery]} />)
        ) : (
          <p className="text-sm text-slate-400">None yet.</p>
        )}
      </Card>

      {result.findings.length > 0 && (
        <Card title="Findings (said · seen)">
          <div className="flex flex-wrap gap-2">
            {result.findings.map((f) => (
              <span
                key={f.key}
                className={`rounded-full px-2.5 py-1 text-xs ${f.yes >= 0.6 ? "bg-sky-800 text-sky-100" : "bg-slate-800 text-slate-400"}`}
              >
                {f.label} {Math.round(f.yes * 100)}% · {f.source}
              </span>
            ))}
          </div>
        </Card>
      )}

      {handover !== null && (
        <Card title="Handover note for the doctor">
          <p>{handover || "Writing…"}</p>
        </Card>
      )}

      <Card title="Language & dialect">
        <p>
          {result.language.toUpperCase()} · <span className="font-semibold">{result.locale}</span>
        </p>
        <p className="text-sm text-slate-400">{result.locale_reason}</p>
        {voiceInfo && <p className="mt-1 text-xs text-slate-500">Pod voice: {voiceInfo}</p>}
      </Card>
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

function Bar({ label, value, hint, tag, small }: { label: string; value: number; hint?: string; tag?: string; small?: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={small ? "py-1" : "py-1.5"}>
      <div className={`flex items-baseline justify-between gap-2 ${small ? "text-xs text-slate-300" : "text-sm"}`}>
        <span>
          {label}
          {tag && <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${tag === "red" ? "bg-red-900 text-red-200" : "bg-slate-800 text-slate-300"}`}>{tag}</span>}
        </span>
        <span className="tabular-nums text-slate-300">{pct}%</span>
      </div>
      <div className={`mt-1 rounded bg-slate-800 ${small ? "h-1" : "h-2"}`}>
        <div className={`rounded bg-sky-500 ${small ? "h-1" : "h-2"}`} style={{ width: `${pct}%` }} />
      </div>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
