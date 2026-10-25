"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMic, listenForUtterance, mergeWavs, micErrorText, playPcmStream, speakWithBrowser, splitForSpeech, testMicrophone, unlockAudio } from "@/lib/audio";
import { PATHWAYS, type Lang } from "@/lib/triage/tree";
import { TRAITS, TraitScan } from "@/lib/triage/traits";
import type { CameraSignals, Frame, Intake, Seen, SpeechStats, TestResults, TriageResult, Turn, Urgency } from "@/lib/triage/types";
import { connectWatch, watchAvailable } from "@/lib/ble/watch";
import { armHold } from "@/lib/triage/questions";
import { CameraHandle, CameraPanel, LiveCamera } from "./CameraPanel";
import TeachAccent from "./TeachAccent";

type MeasuredPulse = { hr: number; spo2: number; finger: boolean; source: "watch" | "finger"; name: string };

type Region = { id: string; name: string; locale: string; languages: string[] };

const REGIONS: Region[] = [
  { id: "zm", name: "Rural Zambia (Eastern Province)", locale: "en-ZM", languages: ["en", "es"] },
  { id: "gt", name: "Rural Guatemala", locale: "es-GT", languages: ["es", "en"] },
  { id: "bo", name: "Rural Bolivia", locale: "es-BO", languages: ["es", "en"] },
  { id: "pe", name: "Andean Peru", locale: "es-PE", languages: ["es", "en"] },
  { id: "mx", name: "Rural Mexico", locale: "es-MX", languages: ["es", "en"] },
  { id: "us", name: "San Francisco (test: no malaria here)", locale: "en-US", languages: ["en", "es"] },
  { id: "ma", name: "Morocco (Darija test)", locale: "ar-MA", languages: ["ar", "en", "es"] },
];

type Status = "ready" | "looking" | "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "testing" | "done";

// Every n-th picture, so a burst covers the whole window with the newest one last.
function pickSpread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.min(list.length - 1, Math.floor((i + 1) * step) - 1)]);
}

const STATUS_TEXT: Record<Status, string> = {
  ready: "Press Start, then ask what they feel",
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

// What the microphone is doing right now, shown on both screens so "the mic chose not to work"
// becomes a sentence with a fix in it.
type MicState = { state: "idle" | "listening" | "heard" | "blocked" | "testing"; words?: number; reason?: string; note?: string };

// One turn, stamped end to end (performance.now() ms): the patient stops talking -> the pod's
// voice is heard -> the mic opens again. Printed to the console and shown on the operator view.
type TurnTiming = {
  speechEnd: number;
  spokeMs?: number;
  sttDone?: number;
  triageDone?: number;
  jevMs?: number;
  stepMs?: number;
  ttsFirstByte?: number;
  audioPlaying?: number;
  audioEnded?: number;
  listeningAgain?: number;
  transcript?: string;
};

const LISTENING = { en: "I'm listening. Please go ahead.", es: "Le escucho. Adelante, hable." };
const AFTER_SPEECH_MS = 500; // the mic opens this long after the pod's voice ends, so it never hears the pod


const FRAME_EVERY_MS = 100; // 10 pictures a second: Jev sees movement, almost video
const FRAME_KEEP = 40; // the last four seconds
const SCAN_EVERY_MS = 2000;
const SCAN_FRAMES = 8; // pictures per scan, spread over the last two seconds
const now = () => performance.now() / 1000;

export default function PodScreen({ kiosk = false, podUrl, village }: { kiosk?: boolean; podUrl?: string; village?: string }) {
  const [region, setRegion] = useState(REGIONS[0]);
  const [status, setStatus] = useState<Status>("ready");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [seen, setSeen] = useState<Seen>({});
  const [tests, setTests] = useState<TestResults>({});
  const [intake, setIntake] = useState<Intake>({});
  // A consenting speaker's recordings, cloned into this village's Grok voice once they agree.
  const clips = useRef<ArrayBuffer[]>([]);
  const learned = useRef(false);
  const [teaching, setTeaching] = useState(false);
  const [language, setLanguage] = useState<Lang | null>(null);
  const [spoken, setSpoken] = useState<string | null>(null);
  const [locale, setLocale] = useState<string | null>(null);
  const [camera, setCamera] = useState<LiveCamera | null>(null);
  const [smileTest, setSmileTest] = useState<CameraSignals["smileTest"]>("not_done");
  const [services, setServices] = useState({ grok: false, jev: false, claude: false });
  const [voiceInfo, setVoiceInfo] = useState("");
  const [saved, setSaved] = useState<{ name: string | null; community: string | null; handover: string | null } | null>(null);
  const [testClock, setTestClock] = useState<{ label: string; left: number } | null>(null);
  const [scanAvg, setScanMax] = useState<TraitScan>({});
  const [scanMs, setScanMs] = useState<number | null>(null);
  const [tooFar, setTooFar] = useState(false); // someone is there, but not close or facing enough to judge
  const [readingPulse, setReadingPulse] = useState(false);
  const [level, setLevel] = useState(0);
  const [mic, setMic] = useState<MicState>({ state: "idle" });
  const [micTest, setMicTest] = useState<string | null>(null);
  const [heard, setHeard] = useState<{ text: string; spokeMs: number; langs: string } | null>(null);
  const [timing, setTiming] = useState<TurnTiming | null>(null);
  const timingRef = useRef<TurnTiming | null>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const blockedRef = useRef(false);
  const lastSaid = useRef<{ text: string; loc: string; community?: string } | null>(null);
  const startingRef = useRef(false); // auto-start and the Start button must not both start the visit
  const reprompted = useRef(false); // "I'm listening" said once per question
  const reasked = useRef(false); // "could you say that again?" once per question
  const misses = useRef(0);
  const listenAbort = useRef<AbortController | null>(null);
  const hearRef = useRef<() => Promise<void>>(async () => {});
  const statusRef = useRef<Status>("ready");
  // Wireless pod head: its finger sensor and its button.
  const [podVitals, setPodVitals] = useState<{ finger: boolean; hr: number; spo2: number; presses: number; camera: boolean } | null>(null);
  const [devicePulse, setDevicePulse] = useState<MeasuredPulse | null>(null);
  const deviceRef = useRef<MeasuredPulse | null>(null);
  const [watchStatus, setWatchStatus] = useState<"off" | "connecting" | "on" | "error">("off");
  const [watchError, setWatchError] = useState("");
  const watchStop = useRef<(() => void) | null>(null);
  const podPresses = useRef<number | null>(null);
  const buttonRef = useRef<() => void>(() => {});
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const cam = useRef<CameraHandle>(null);
  const liveCam = useRef<LiveCamera | null>(null);
  const heldPulse = useRef<{ bpm: number | null; confidence: number } | null>(null);
  const frames = useRef<{ t: number; b64: string; face?: string }[]>([]);
  const askedAt = useRef(0); // when the pod finished asking the current question

  const grokRef = useRef<boolean | null>(null); // null = health not answered yet (assume yes)
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((s) => {
        grokRef.current = Boolean(s.grok);
        setServices(s);
      })
      .catch(() => {});
  }, []);

  // Keep a rolling few seconds of pictures so Jev sees motion, not one frozen moment.
  useEffect(() => {
    const id = setInterval(() => {
      const b64 = cam.current?.capture(480);
      if (!b64) return;
      // The face close-up is dearer to make: one every third picture is plenty.
      const face = frames.current.length % 3 === 0 ? (cam.current?.captureFace() ?? undefined) : undefined;
      frames.current.push({ t: now(), b64, face });
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

  statusRef.current = status;

  const publishTiming = useCallback((t: TurnTiming) => {
    setTiming({ ...t });
    const d = (a?: number, b?: number) => (a != null && b != null ? `${((a - b) / 1000).toFixed(2)} s` : "–");
    console.log(
      `[turn timing] spoke ${((t.spokeMs ?? 0) / 1000).toFixed(1)} s · stop→transcript ${d(t.sttDone, t.speechEnd)} · →decision ${d(t.triageDone, t.sttDone)} (Jev ${t.jevMs ?? "?"} ms, Claude+other ${t.stepMs != null && t.jevMs != null ? t.stepMs - t.jevMs : "?"} ms) · →voice first byte ${d(t.ttsFirstByte, t.triageDone)} · →sound ${d(t.audioPlaying, t.ttsFirstByte)} · STOP→SOUND ${d(t.audioPlaying, t.speechEnd)} · sound ended→listening ${d(t.listeningAgain, t.audioEnded)}`,
    );
  }, []);

  // Always Grok Voice first (the health check is only advice; a Start pressed before it answers must
  // not condemn the whole visit to the browser voice). The voice streams: the first sentence is
  // played while the rest is still being generated. The browser voice is the last resort, and
  // when it is used the screen says so in red, with the reason.
  const speak = useCallback(
    async (text: string, loc: string, community?: string) => {
      setStatus("speaking");
      lastSaid.current = { text, loc, community };
      const t = timingRef.current;
      const parts = splitForSpeech(text);
      let i = 0;
      try {
        if (!(await unlockAudio())) {
          blockedRef.current = true;
          setSoundBlocked(true);
          throw new Error("the browser will not play sound until someone taps the screen");
        }
        setSoundBlocked(false);
        const fetches = parts.map((p) =>
          fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: p, locale: loc, community }) }),
        );
        for (; i < parts.length; i++) {
          const res = await fetches[i];
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
          if (i === 0) {
            if (t) t.ttsFirstByte ??= performance.now();
            setVoiceInfo(`${decodeURIComponent(res.headers.get("X-Voice-Name") ?? "")} · ${decodeURIComponent(res.headers.get("X-Voice-Match") ?? "")}${res.headers.get("X-Cache") === "hit" ? " · cached" : ""}`);
          }
          const first = i === 0;
          await playPcmStream(res, {
            sampleRate: Number(res.headers.get("X-Sample-Rate") ?? 24000),
            onFirstAudio: () => {
              if (t && first) {
                t.audioPlaying ??= performance.now();
                publishTiming(t);
              }
            },
          });
        }
        if (t) t.audioEnded = performance.now();
        return;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.warn("Grok Voice speech failed, using the browser voice:", why);
        setError(`Grok Voice failed (${why}) — using the browser voice for this sentence.`);
      }
      await speakWithBrowser(parts.slice(i).join(" "), loc);
      if (t) t.audioEnded = performance.now();
    },
    [publishTiming],
  );

  // Browsers only play sound after a tap or key press. The kiosk auto-starts without one, so the
  // first tap anywhere turns sound on, and if the pod's question was lost to silence it is said
  // again and the mic opens after it.
  useEffect(() => {
    const unlock = async () => {
      if (!(await unlockAudio())) return;
      setSoundBlocked(false);
      if (blockedRef.current && lastSaid.current) {
        blockedRef.current = false;
        const s = lastSaid.current;
        listenAbort.current?.abort();
        await speak(s.text, s.loc, s.community);
        await new Promise((r) => setTimeout(r, AFTER_SPEECH_MS));
        if (!["done", "ready", "testing"].includes(statusRef.current)) void hearRef.current();
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [speak]);

  liveCam.current = camera;
  const rememberPulse = (next: MeasuredPulse) => {
    const cur = deviceRef.current;
    // A finger on the red light outranks the watch until the finger comes off.
    if (cur?.source === "finger" && cur.finger && next.source === "watch" && !next.finger) return;
    deviceRef.current = next;
    setDevicePulse(next);
  };
  const cameraSnapshot = useCallback((): CameraSignals => {
    // Read at call time. The pulse window finishes during a test, after this callback was created.
    const measured = deviceRef.current;
    const measuredHr = measured && measured.hr >= 30 ? measured.hr : null;
    return {
      heartRateBpm: measuredHr ?? heldPulse.current?.bpm ?? liveCam.current?.heartRateBpm ?? null,
      heartRateConfidence: measuredHr != null ? 0.95 : (heldPulse.current?.confidence ?? liveCam.current?.heartRateConfidence ?? 0),
      heartRateSource: measuredHr != null ? measured!.source : heldPulse.current?.bpm != null || liveCam.current?.heartRateBpm != null ? "camera" : undefined,
      droop: null, // a resting face is not a diagnosis
      smileTest,
    };
  }, [smileTest]);

  // Runs one physical test: say the instruction, watch for N seconds, let Jev judge the pictures.
  const runTest = useCallback(
    async (test: { id: string; label: string; seconds: number; prep?: number }) => {
      setStatus("testing");
      if (test.id === "pulse") setReadingPulse(true);
      for (let left = test.prep ?? 1; left > 0; left--) {
        setTestClock({ label: `Get ready · ${test.label}`, left });
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (test.id === "smile") cam.current?.startSmileTest();
      const burst: { t: number; b64: string }[] = [];
      if (test.id === "finger") {
        // The video asks for the arm. Six steady seconds of a visible pulse is enough; otherwise stop at 18.
        const started = Date.now();
        let steady = 0;
        while (true) {
          const elapsed = (Date.now() - started) / 1000;
          const reading = deviceRef.current;
          const showing = Boolean(reading && reading.hr >= 30 && reading.hr <= 220);
          steady = showing ? steady + 1 : 0;
          const phase = armHold(steady, elapsed);
          setTestClock({ label: "Arm on the sensor", left: Math.max(0, Math.ceil(18 - elapsed)) });
          if (phase !== "read") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        const reading = deviceRef.current;
        if (reading && reading.hr >= 30) {
          heldPulse.current = { bpm: reading.hr, confidence: 0.95 };
          const vitals: Record<string, number | boolean | string> = { podConnected: true, finger: Boolean(reading.finger || reading.spo2 > 0), hr: Math.round(reading.hr), source: reading.source };
          if (reading.spo2 > 0) vitals.spo2 = Math.round(reading.spo2);
          await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vitals }) }).catch(() => {});
        }
      } else {
        const every = Math.max(500, (test.seconds * 1000) / 8);
        for (let left = test.seconds; left > 0; left -= every / 1000) {
          setTestClock({ label: test.label, left: Math.ceil(left) });
          const b64 = cam.current?.capture(480);
          if (b64) burst.push({ t: now(), b64 });
          await new Promise((r) => setTimeout(r, every));
        }
      }
      setTestClock(null);
      if (test.id === "pulse") {
        heldPulse.current = cam.current?.readPulse() ?? heldPulse.current;
        setReadingPulse(false);
      }
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
          spoken,
          region: region.name,
          defaultLocale: locale ?? region.locale,
          village,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Triage failed");
      const r = data as TriageResult;
      if (timingRef.current) Object.assign(timingRef.current, { triageDone: performance.now(), jevMs: r.jev_ms, stepMs: r.step_ms });
      setResult(r);
      setSeen(r.seen);
      const lang = r.patient_text ? r.language : language ?? (region.locale.startsWith("en") ? "en" : "es");
      const loc = r.patient_text ? r.locale : locale ?? region.locale;
      if (r.patient_text) {
        setLanguage(r.language);
        setSpoken(r.spoken_language ?? r.language);
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
          body: JSON.stringify({ intake: nextIntake, result: r, turns: nextTurns, region: region.name, village }),
        })
          .then((x) => x.json())
          .then((d) => setSaved({ name: d.name, community: d.community, handover: d.handover }))
          .catch(() => {});
      }
      const community = village ?? nextIntake.community;
      if (r.voice_consent && !learned.current && clips.current.length) {
        learned.current = true;
        try {
          const form = new FormData();
          form.append("clip", mergeWavs(clips.current), "patient.wav");
          form.append("locale", loc);
          if (community) form.append("community", community);
          form.append("name", `${community ?? "Village"} voice (learned)`);
          const res = await fetch("/api/clone", { method: "POST", body: form });
          const data = await res.json();
          if (res.ok) setVoiceInfo(`Learned this village: ${data.name}`);
          else setVoiceInfo(data.error ?? "Could not learn this voice");
        } catch {
          /* the regional voice carries on */
        }
      }
      if (r.next) await speak(r.next.text, loc, community);
      askedAt.current = now();

      if (r.next?.test && !r.done) {
        const { results, smile } = await runTest(r.next.test);
        const nextTests = { ...cur.tests, [r.next.test.id]: results ?? {} };
        setTests(nextTests);
        return triage("answer", undefined, { turns: nextTurns, tests: nextTests, intake: nextIntake, smile });
      }
      setStatus(r.done ? "done" : "idle");
      reprompted.current = false;
      reasked.current = false;
      misses.current = 0;
      // Listen for the answer, no tapping, but never while the pod's own voice is still in the
      // air: the mic opens 250 ms after playback ended, so it does not hear the pod and cancel.
      // Read through the ref: a Start pressed before /api/health answered must not leave this
      // closure believing there is no Grok Voice and stop the loop.
      if (!r.done && grokRef.current !== false) {
        await new Promise((res) => setTimeout(res, AFTER_SPEECH_MS));
        void hearRef.current();
      }
    },
    [turns, tests, intake, seen, scanAvg, cameraSnapshot, language, spoken, locale, region, speak, runTest, smileTest, services.grok, village],
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
      // Auto-start (3 s in front of the camera) and the Start button can fire together: one visit.
      if (startingRef.current || statusRef.current !== "ready") return;
      startingRef.current = true;
      try {
        // The Start click is the gesture browsers need: turn sound on and open the mic right now,
        // once, for the whole visit (a permission prompt appears here, not mid-conversation).
        setSoundBlocked(!(await unlockAudio()));
        getMic()
          .then(() => setMic((m) => (m.state === "blocked" ? { state: "idle" } : m)))
          .catch((e) => setMic({ state: "blocked", reason: micErrorText(e) }));
        setStatus("looking");
        askedAt.current = now() - 3; // look at the last few seconds
        await triage("look");
      } finally {
        startingRef.current = false;
      }
    });

  // Both candidate languages until the patient's language has settled (two spoken turns); then
  // only theirs: one transcription instead of two, and no extra Jev call to pick between them.
  const sttLanguages = () => {
    const spokenTurns = turns.filter((t) => t.role === "patient").length;
    if (spoken && spokenTurns >= 2 && region.languages.includes(spoken)) return [spoken];
    return region.languages;
  };

  // Hands-free: listen until the patient finishes speaking, transcribe, and let Jev read it.
  const hear = async () => {
    listenAbort.current?.abort();
    const ctl = new AbortController();
    listenAbort.current = ctl;
    const lang: Lang = language ?? (region.locale.startsWith("en") ? "en" : "es");
    const loc = locale ?? region.locale;
    const community = village ?? intake.community;
    // The previous turn's clock stops when the mic opens again.
    const prev = timingRef.current;
    if (prev?.audioEnded && !prev.listeningAgain) {
      prev.listeningAgain = performance.now();
      publishTiming(prev);
    }
    setStatus("listening");
    setMic({ state: "listening" });
    let got: Awaited<ReturnType<typeof listenForUtterance>>;
    try {
      got = await listenForUtterance({ signal: ctl.signal, waitMs: 14000, silenceMs: 2600, maxMs: 45000, onLevel: (l) => setLevel(l) });
    } catch (e) {
      const why = micErrorText(e);
      setMic({ state: "blocked", reason: why });
      setStatus("idle");
      throw new Error(why);
    }
    if (ctl.signal.aborted) return;
    if (!got) {
      // Nobody spoke: say so once and listen again; the second time, wait for the button.
      if (!reprompted.current) {
        reprompted.current = true;
        setMic({ state: "idle", note: "Heard nothing — saying so and listening again" });
        await speak(LISTENING[lang], loc, community);
        await new Promise((r) => setTimeout(r, AFTER_SPEECH_MS));
        return hear();
      }
      setMic({ state: "idle", note: "Heard nothing — tap the microphone (or the pod's button) to talk" });
      setStatus("idle");
      return;
    }
    const t: TurnTiming = { speechEnd: got.t.speechEnd, spokeMs: got.spokeMs };
    timingRef.current = t;
    if (got.wav.size > 48_000) clips.current.push(await got.wav.arrayBuffer());
    setStatus("transcribing");
    setMic({ state: "heard", note: `${(got.spokeMs / 1000).toFixed(1)} s of speech — understanding…` });
    const langs = sttLanguages();
    const form = new FormData();
    form.append("audio", got.wav, "speech.wav");
    form.append("languages", langs.join(","));
    form.append("locale", loc);
    if (community) form.append("community", community);
    const res = await fetch("/api/stt", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Transcription failed");
    t.sttDone = performance.now();
    const tr = data.transcripts as Record<string, { text: string; speech: SpeechStats }>;
    const best = tr[language ?? langs[0]] ?? Object.values(tr)[0];
    const text = best?.text ?? "";
    const words = text.split(/\s+/).filter(Boolean).length;
    t.transcript = text;
    setHeard({ text, spokeMs: got.spokeMs, langs: langs.join("+") });
    setMic({ state: "heard", words });
    const empty = Object.values(tr).every((x) => !x.text);
    if ((empty || words <= 1) && got.spokeMs > 1500 && !reasked.current) {
      // The recording was long and almost nothing came back. Listen once more, without
      // talking over them or asking them to repeat it.
      reasked.current = true;
      setMic({ state: "idle", note: `Heard ${(got.spokeMs / 1000).toFixed(1)} s of speech but only ${words} word${words === 1 ? "" : "s"} came back — listening again` });
      return hear();
    }
    if (empty) {
      if (misses.current++ >= 1) {
        setError("Didn't catch that. Tap the microphone and try again, or type the answer.");
        setStatus("idle");
        return;
      }
      setError("Didn't catch that — listening again.");
      return hear();
    }
    await triage("answer", { candidates: Object.fromEntries(Object.entries(tr).map(([l, x]) => [l, x.text])), speech: best.speech });
  };
  hearRef.current = () => run(hear);

  // "Test my microphone": open it, show the level for 5 s, say "working" or the exact error.
  const onTestMic = async () => {
    listenAbort.current?.abort();
    setMic({ state: "testing" });
    setMicTest("Testing… say something for 5 seconds");
    const r = await testMicrophone({ ms: 5000, onLevel: setLevel });
    if (r.ok) {
      setMic({ state: "idle" });
      setMicTest(`Microphone working — peak level ${Math.round(Math.min(1, r.peak / 0.1) * 100)}%`);
    } else {
      setMic({ state: "blocked", reason: r.error });
      setMicTest(r.error);
    }
  };

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
    fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) }).catch(() => {});
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
    setScanMax({});
    setMic((m) => (m.state === "blocked" ? m : { state: "idle" }));
    setHeard(null);
    setTiming(null);
    timingRef.current = null;
    reprompted.current = false;
    reasked.current = false;
    misses.current = 0;
    cam.current?.reset();
    heldPulse.current = null;
    setReadingPulse(false);
    clips.current = [];
    learned.current = false;
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
          body: JSON.stringify({ frames: pickSpread(frames.current.slice(-SCAN_FRAMES * 3), SCAN_FRAMES).map((f) => ({ secondsAgo: t - f.t, b64: f.b64, face: f.face })) }),
        });
        if (res.ok) {
          const d = await res.json();
          setTooFar(!d.judged && d.person >= 0.5);
          if (d.judged || d.bodyJudged) {
            const traits = { ...d.traits, face_droop: 0, eyelid_droop: 0, holding_head: 0, eyes_closing: 0, drowsy: 0, slumped: 0 };
            // Most signs are smoothed so one flicker cannot name them. Sweat rises on the first
            // clear reading, so a sweaty face shows on this visit instead of waiting to average out.
            setScanMax((m) =>
              Object.fromEntries(
                TRAITS.map((x) => {
                  const next = traits[x.id] ?? 0;
                  const prev = m[x.id] ?? 0;
                  if (x.id === "sweaty") return [x.id, next >= 0.4 ? Math.max(prev, next) : 0.4 * prev + 0.6 * next];
                  return [x.id, 0.5 * prev + 0.5 * next];
                }),
              ),
            );
            setScanMs(d.ms);
          }
        }
      } finally {
        scanning.current = false;
      }
    }, SCAN_EVERY_MS);
    return () => clearInterval(id);
  }, [faceVisible, services.jev, status]);

  const busy = ["looking", "transcribing", "thinking", "speaking", "testing"].includes(status);
  const canAnswer = !busy && status !== "done" && status !== "ready";

  // The pod's button does what Space does: start, or talk.
  buttonRef.current = () => {
    if (status === "ready") onStart();
    else if (status === "idle" || status === "listening") onMic();
  };

  // No Wi-Fi pod given: the USB pod (nRF52840 + finger sensor) reaches us through the laptop
  // bridge, which posts its readings and button presses to /api/session once a second.
  const podHasSensor = useRef(false); // a Wi-Fi pod that reports its own finger sensor
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (podHasSensor.current) return; // the pod's own /vitals feed takes over below
      try {
        const s = await (await fetch("/api/session", { cache: "no-store" })).json();
        if (!alive) return;
        const v = s?.vitals ?? {};
        if (v.source === "watch") return; // the watch has its own reading; this poll is the cable sensor
        const fresh = v.podConnected && typeof v.at === "number" && Date.now() - v.at < 3000;
        if (!fresh) {
          setPodVitals(null);
          return;
        }
        setPodVitals({ finger: Boolean(v.finger), hr: v.hr ?? 0, spo2: v.spo2 ?? 0, presses: v.presses ?? 0, camera: false });
        if (typeof v.presses === "number") {
          if (podPresses.current !== null && v.presses > podPresses.current) buttonRef.current();
          podPresses.current = v.presses;
        }
      } catch {
        if (alive) setPodVitals(null);
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!podVitals?.finger || podVitals.hr < 30) return;
    rememberPulse({ hr: podVitals.hr, spo2: podVitals.spo2, finger: true, source: "finger", name: "Finger sensor" });
  }, [podVitals]);

  useEffect(() => {
    if (!devicePulse || devicePulse.hr < 30) return;
    const vitals = {
      podConnected: true,
      finger: devicePulse.finger,
      hr: Math.round(devicePulse.hr),
      source: devicePulse.source,
      ...(devicePulse.spo2 > 0 ? { spo2: Math.round(devicePulse.spo2) } : {}),
    };
    const id = setTimeout(() => {
      fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vitals }) }).catch(() => {});
    }, 200);
    return () => clearTimeout(id);
  }, [devicePulse]);

  const onConnectWatch = (anyDevice = false) => {
    if (!watchAvailable()) {
      setWatchError("This window cannot read a Bluetooth watch. Open the pod in Chrome.");
      setWatchStatus("error");
      return;
    }
    setWatchError("");
    setWatchStatus("connecting");
    watchStop.current?.();
    connectWatch((reading) => {
      setWatchStatus("on");
      if (reading.hr == null && reading.spo2 == null) return;
      rememberPulse({ hr: reading.hr ?? 0, spo2: reading.spo2 ?? 0, finger: reading.finger, source: "watch", name: reading.name });
    }, { anyDevice })
      .then((stop) => {
        watchStop.current = stop;
        setWatchStatus("on");
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (/cancel|chooser/i.test(msg)) {
          setWatchStatus("off");
          return;
        }
        setWatchError(msg);
        setWatchStatus("error");
      });
  };

  // A pod address with its own finger sensor (the Wi-Fi head): read it once a second. A camera-only
  // pod (the Vision AI board over USB, served at localhost:3419) answers {"sensor": false} and is
  // left to the USB bridge above for vitals.
  useEffect(() => {
    if (!podUrl) return;
    let alive = true;
    const tick = async () => {
      try {
        const v = await (await fetch(`${podUrl.replace(/\/$/, "")}/vitals`, { cache: "no-store" })).json();
        if (!alive) return;
        podHasSensor.current = v.sensor !== false;
        if (!podHasSensor.current) return; // pictures only; vitals come from the USB bridge
        setPodVitals(v);
        const vitals: Record<string, unknown> = { podConnected: true };
        if (v.spo2 > 0 && v.hr > 0) Object.assign(vitals, { spo2: v.spo2, hr: v.hr });
        fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vitals }) }).catch(() => {});
        if (podPresses.current !== null && v.presses > podPresses.current) buttonRef.current();
        podPresses.current = v.presses;
      } catch {
        podHasSensor.current = false;
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [podUrl]);

  // Tell the network this pod is here and what it is doing (the map shows it online): every 5 s and
  // on every change, "offline" when the screen closes. Fire-and-forget: it never touches the visit.
  const beatStatus = status === "listening" || status === "speaking" ? status : ["looking", "transcribing", "thinking", "testing"].includes(status) ? "thinking" : "idle";
  const beatStep = [...turns].reverse().find((t) => t.role === "pod")?.asks ?? "";
  const beatLang = spoken ?? "";
  useEffect(() => {
    const beat = (s: string, keepalive = false) => {
      try {
        fetch("/api/registry/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ village: village ?? "Katete", status: s, step: beatStep, language: beatLang }),
          keepalive,
        }).catch(() => {});
      } catch {
        /* never let the heartbeat touch the visit */
      }
    };
    beat(beatStatus);
    const id = setInterval(() => beat(beatStatus), 5000);
    const bye = () => beat("offline", true);
    window.addEventListener("beforeunload", bye);
    return () => {
      clearInterval(id);
      window.removeEventListener("beforeunload", bye);
    };
  }, [village, beatStatus, beatStep, beatLang]);
  useEffect(() => {
    const v = village ?? "Katete";
    return () => {
      fetch("/api/registry/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ village: v, status: "offline" }), keepalive: true }).catch(() => {});
    };
  }, [village]);

  // Share the live visit with the health worker's screen (/staff).
  useEffect(() => {
    const id = setTimeout(() => {
      fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: { turns, result, tests, intake, scan: scanAvg, scanMs, status, faceVisible, heartRate: camera?.heartRateBpm ?? null, saved, village: village ?? null } }),
      }).catch(() => {});
    }, 300);
    return () => clearTimeout(id);
  }, [turns, result, tests, intake, scanAvg, scanMs, status, faceVisible, camera?.heartRateBpm, saved]);

  // Hardware pod: one big button (sends Space) starts or talks; N = new patient; F = full screen.
  useEffect(() => {
    if (!kiosk) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      // Space, Enter, or a presentation clicker (PageDown / arrow keys) all act as the pod's button.
      if (["Space", "Enter", "NumpadEnter", "PageDown", "PageUp", "ArrowRight", "ArrowDown"].includes(e.code)) {
        e.preventDefault();
        if (status === "ready") onStart();
        else if (status === "idle" || status === "listening") onMic();
      } else if (e.key === "n" || e.key === "N") reset();
      else if (e.key === "f" || e.key === "F") document.documentElement.requestFullscreen?.().catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      lock?.release().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiosk, status]);

  if (kiosk) {
    const podTurn = [...turns].reverse().find((t) => t.role === "pod");
    const isTest = podTurn?.asks?.startsWith("test:");
    const fingerNow = podTurn?.asks === "test:finger" && (status === "testing" || status === "speaking");
    const english = region.languages[0] === "en";
    const place = village ?? intake.community ?? "Katete";
    const liveHr = devicePulse && devicePulse.hr >= 30 ? Math.round(devicePulse.hr) : camera?.heartRateBpm != null ? Math.round(camera.heartRateBpm) : null;
    const watchBpm = devicePulse && devicePulse.hr >= 30 ? Math.round(devicePulse.hr) : null;
    return (
      <div className="pod-hud fixed inset-x-0 bottom-0 top-11 grid overflow-hidden text-slate-100 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)]">
        <div className="relative flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center justify-between px-8 py-4 text-sm text-slate-400">
            <span className="font-mono text-[11px] tracking-[0.42em] text-cyan-100/80">TRIAGE POD · GROK VOICE</span>
            <span className="flex flex-wrap items-center justify-end gap-3">
              {status === "done" && <span className="rounded-full border border-emerald-300/50 bg-emerald-950/80 px-3 py-1 font-mono text-[11px] tracking-[0.16em] text-emerald-100">1 added · {place}</span>}
              <span>{result?.network?.advisories[0] ? `⚠ ${result.network.advisories[0].text}` : english ? "A health worker is with you" : "Un promotor de salud está con usted · A health worker is with you"}</span>
            </span>
          </div>
          {!services.grok && (
            <p className="mx-8 rounded-lg border border-amber-400/40 bg-amber-950/50 px-4 py-2 text-sm text-amber-100">
              Grok Voice needs XAI_API_KEY in .env.local. Until then the pod can only use the browser voice.
            </p>
          )}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-10 pb-36 text-center">
            {status === "ready" ? (
              <>
                <div className="pod-orbit" aria-hidden>
                  <i />
                  <i />
                  <i />
                </div>
                <p className="font-mono text-[11px] tracking-[0.38em] text-cyan-200/70">SYMPTOM INTAKE</p>
                <p className="relative mt-4 max-w-full px-6 text-5xl font-semibold leading-tight">
                  {english ? "Tell me what you feel." : "Dígame qué siente."}
                </p>
                {!english && <p className="relative mt-3 text-2xl text-slate-400">Tell me what you feel.</p>}
                <p className="relative mt-6 max-w-2xl text-lg leading-relaxed text-slate-400">
                  {english
                    ? "Speak in your own words. I ask only what changes the answer. If I need your pulse, I ask you to place your arm, and the number shows on the video."
                    : "Hable con sus palabras. Pregunto solo lo que cambia la respuesta. Si necesito el pulso, le pido el brazo y el número se ve en el video."}
                </p>
                <button onClick={onStart} className="pod-start relative mt-10">
                  {english ? "Begin" : "Empezar · Begin"}
                </button>
              </>
            ) : (
              <>
                <p className={`font-mono text-[11px] tracking-[0.32em] ${isTest ? "text-amber-200" : "text-cyan-200"}`}>
                  {isTest ? (english ? "HOLD STILL" : "QUÉDESE QUIETO · HOLD STILL") : status === "listening" ? (english ? "LISTENING" : "ESCUCHANDO · LISTENING") : status === "done" ? "COMPLETE" : "QUESTION"}
                </p>
                <p className="mt-4 max-w-5xl text-5xl font-semibold leading-tight">{podTurn?.text ?? "…"}</p>
                {podTurn?.english && podTurn.english !== podTurn.text && <p className="mt-4 max-w-4xl text-2xl text-slate-400">{plain(podTurn.english)}</p>}
                {readingPulse && !fingerNow && <Ecg bpm={liveHr ?? heldPulse.current?.bpm ?? null} />}
                {testClock && (
                  <p className="mt-8 text-7xl font-bold tabular-nums text-cyan-200">
                    {testClock.left}
                    <span className="ml-3 text-2xl font-normal text-slate-400">{testClock.label}</span>
                  </p>
                )}
                {readingPulse && tooFar && <p className="mt-4 text-xl text-amber-200">{english ? "Face the camera and hold still." : "Mire a la cámara y quédese quieto."}</p>}
                <div className="mt-10">
                  <MicLine mic={mic} level={level} big />
                </div>
                {soundBlocked && <p className="mt-6 text-2xl text-amber-300">Tap the screen once to turn on sound · Toque la pantalla una vez para activar el sonido</p>}
                {status === "idle" && (
                  <button onClick={onMic} className="pod-start mt-10">
                    {english ? "Talk" : "Hablar · Talk"}
                  </button>
                )}
                {["thinking", "transcribing", "looking"].includes(status) && <p className="mt-10 font-mono text-sm tracking-[0.28em] text-cyan-200/70">READING THE ANSWER</p>}
              </>
            )}
            {error && <p className="mt-6 text-lg text-amber-300">{error}</p>}
          </div>
          <div className={fingerNow ? "absolute inset-x-8 top-28 bottom-20 z-10" : "absolute bottom-6 right-6 w-72 overflow-hidden"}>
            <CameraPanel ref={cam} onSignals={setCamera} smileTest={smileTest} remote={podUrl} measurePulse={readingPulse} externalBpm={watchBpm} armPrompt={fingerNow} />
            {fingerNow && watchStatus !== "on" && (
              <div className="absolute inset-x-0 bottom-16 z-20 flex justify-center">
                <WatchConnect status={watchStatus} error={watchError} onConnect={onConnectWatch} />
              </div>
            )}
          </div>
          <p className="absolute bottom-3 left-8 font-mono text-[10px] tracking-wide text-slate-600">Space: start · talk · N: new patient · F: full screen</p>
        </div>
        <aside className="pod-rail min-h-0 min-w-0 overflow-y-auto overflow-x-hidden border-t border-cyan-200/15 lg:border-l lg:border-t-0">
          <p className="px-5 pt-4 pr-6 font-mono text-[10px] tracking-[0.28em] text-cyan-200/60">REASONING · FOR THE JUDGES</p>
          <div className="p-4">
            <ResultPanel result={result} tests={tests} intake={intake} saved={saved} voiceInfo={voiceInfo} scan={scanAvg} scanMs={scanMs} faceVisible={faceVisible} village={place} pulse={devicePulse && devicePulse.hr >= 30 ? { heartRateBpm: devicePulse.hr, heartRateConfidence: 0.95 } : camera} pulseFrom={devicePulse && devicePulse.hr >= 30 ? devicePulse.source : undefined} />
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="pod-hud min-h-screen text-slate-100">
      <header className="relative flex flex-wrap items-center justify-between gap-3 border-b border-cyan-200/15 px-6 py-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.38em] text-cyan-200/60">OPERATOR</p>
          <h1 className="text-xl font-semibold tracking-tight">Triage Pod</h1>
          <p className="text-xs text-slate-400">Grok Voice listens and answers in the village dialect. Pulse only for chest or heart. A resting face is not a droop.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/dashboard" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Dashboard
          </Link>
          <Link href="/agents" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Agents
          </Link>
          <Link href="/registry" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Registry
          </Link>
          <button
            onClick={() => setTeaching(true)}
            disabled={!services.grok}
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
          {status === "done" && (
            <span className="rounded-full border border-emerald-300/50 bg-emerald-950/80 px-3 py-2 font-mono text-[11px] tracking-[0.16em] text-emerald-100">
              1 added · {village ?? intake.community ?? "Katete"}
            </span>
          )}
          <button type="button" onClick={() => onConnectWatch(false)} className="rounded-lg border border-cyan-700 px-3 py-2 text-cyan-100 hover:bg-cyan-950">
            {watchStatus === "on" ? devicePulse && devicePulse.hr >= 30 ? `Watch ${Math.round(devicePulse.hr)}` : "Watch connected" : watchStatus === "connecting" ? "Looking…" : "Connect watch"}
          </button>
          <button onClick={reset} className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            New patient
          </button>
        </div>
      </header>

      {teaching && <TeachAccent locale={locale ?? region.locale} onClose={() => setTeaching(false)} />}

      {(!services.grok || !services.jev) && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-700 bg-amber-950/60 px-4 py-2 text-sm text-amber-200">
          {!services.jev && "Jev key missing — add TYPESAFE_API_KEY to .env.local. "}
          {!services.grok && "Grok Voice key missing — using typing and the browser voice until XAI_API_KEY is added."}
        </div>
      )}

      <main className="grid gap-6 p-6 md:grid-cols-[1fr_1fr]">
        <section className="space-y-4">
          {result?.network?.advisories.map((a, i) => (
            <div key={i} className="rounded-xl border border-red-700 bg-red-950/60 px-4 py-2 text-sm">
              <span className="font-semibold">Network alert</span> (cluster in {a.source}): {a.text}
            </div>
          ))}
          <QuestionCard turns={turns} why={result?.why ?? null} status={status} />
          {heard && (
            <p className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-2 text-sm">
              <span className="text-slate-500">
                I heard ({heard.langs}, {(heard.spokeMs / 1000).toFixed(1)} s of speech):
              </span>{" "}
              {heard.text ? `“${heard.text}”` : <span className="text-amber-300">nothing — the transcript came back empty</span>}
            </p>
          )}
          <MalariaPressureCard village={village ?? "Katete"} region={region.name} fromVisit={result?.malaria_pressure ?? null} />
          <div className="relative">
            <CameraPanel ref={cam} onSignals={setCamera} smileTest={smileTest} remote={podUrl} measurePulse={readingPulse} externalBpm={devicePulse && devicePulse.hr >= 30 ? Math.round(devicePulse.hr) : null} armPrompt={[...turns].reverse().find((t) => t.role === "pod")?.asks === "test:finger" && (status === "testing" || status === "speaking")} />
            {testClock && (
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between rounded-b-2xl bg-sky-900/90 px-4 py-3">
                <span className="font-semibold">{testClock.label}</span>
                <span className="text-2xl tabular-nums">{testClock.left}s</span>
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Vital
              label="Pulse (camera)"
              value={camera?.heartRateBpm != null ? `${Math.round(camera.heartRateBpm)} bpm` : readingPulse ? "reading…" : "not asked yet"}
              alert={Boolean(camera?.heartRateBpm && (camera.heartRateBpm > 120 || camera.heartRateBpm < 45) && camera.heartRateConfidence >= 0.5)}
              note={camera?.heartRateBpm != null ? `confidence ${Math.round(camera.heartRateConfidence * 100)}% · skin colour` : "only after chest or heart symptoms"}
            />
            <Vital
              label={devicePulse?.source === "watch" ? "Pulse (watch)" : "Pulse (finger sensor)"}
              value={devicePulse && devicePulse.hr >= 30 ? `${Math.round(devicePulse.hr)} bpm` : watchStatus === "connecting" ? "connecting…" : watchStatus === "on" ? "waiting for a pulse" : "not connected"}
              alert={Boolean(devicePulse && devicePulse.hr >= 30 && (devicePulse.hr > 120 || devicePulse.hr < 45))}
              note={devicePulse && devicePulse.spo2 > 0 ? `oxygen ${Math.round(devicePulse.spo2)}%` : devicePulse?.source === "watch" ? devicePulse.name : "Bluetooth watch, or a finger on the red light"}
            />
            <Vital label="Smile test" value={smileTest === "not_done" ? "not done" : smileTest} alert={smileTest === "asymmetric"} note="only if they report one-sided weakness" />
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
                disabled={(!canAnswer && status !== "listening") || !services.grok}
                className={`h-20 w-20 shrink-0 rounded-full text-3xl transition ${
                  status === "listening" ? "animate-pulse bg-red-600" : "bg-sky-600 hover:bg-sky-500"
                } disabled:opacity-40`}
                aria-label="Speak"
              >
                🎙️
              </button>
            )}
            <div className="flex-1 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-lg">{readingPulse && tooFar ? "Face the camera and hold still so the pulse can be read." : STATUS_TEXT[status]}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <MicLine mic={mic} level={level} />
                </div>
                <button onClick={onTestMic} disabled={mic.state === "testing"} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800 disabled:opacity-40">
                  Test my microphone
                </button>
              </div>
              {micTest && <p className={`text-xs ${micTest.startsWith("Microphone working") ? "text-emerald-300" : micTest.startsWith("Testing") ? "text-slate-400" : "text-amber-300"}`}>{micTest}</p>}
              {soundBlocked && <p className="text-xs text-amber-300">🔈 Sound is blocked until someone taps or clicks the page once.</p>}
              <TimingLine t={timing} />
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
          <p className="font-mono text-[10px] tracking-[0.32em] text-cyan-200/60">REASONING · FOR THE JUDGES</p>
          <ResultPanel result={result} tests={tests} intake={intake} saved={saved} voiceInfo={voiceInfo} scan={scanAvg} scanMs={scanMs} faceVisible={faceVisible} village={village ?? intake.community ?? null} pulse={devicePulse && devicePulse.hr >= 30 ? { heartRateBpm: devicePulse.hr, heartRateConfidence: 0.95 } : camera} pulseFrom={devicePulse && devicePulse.hr >= 30 ? devicePulse.source : undefined} />
        </section>
      </main>
    </div>
  );
}

function WatchConnect({ status, error, onConnect }: { status: "off" | "connecting" | "on" | "error"; error: string; onConnect: (anyDevice?: boolean) => void }) {
  if (status === "on") return null;
  return (
    <div className="relative mt-6 flex flex-col items-center gap-2">
      <button type="button" onClick={() => onConnect(false)} disabled={status === "connecting"} className="rounded-full border border-cyan-200/40 px-5 py-2 text-sm text-cyan-100 hover:bg-cyan-950 disabled:opacity-50">
        {status === "connecting" ? "Looking for the watch…" : "Connect watch"}
      </button>
      {status === "error" && (
        <button type="button" onClick={() => onConnect(true)} className="text-sm text-slate-300 underline">
          Show every Bluetooth device
        </button>
      )}
      {error && <p className="max-w-md text-sm text-amber-200">{error}</p>}
    </div>
  );
}

// This week's malaria pressure at the pod's village (mosquitoes heard, rain, recent cases): it
// sets where malaria STARTS among the fever causes and which fever questions come first, never the
// decision. Fetched for the village on its own, refreshed every few minutes, and replaced by the
// figure the engine actually used once a visit is under way.
function MalariaPressureCard({ village, region, fromVisit }: { village: string; region: string; fromVisit: TriageResult["malaria_pressure"] }) {
  const [fetched, setFetched] = useState<TriageResult["malaria_pressure"]>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/pressure?village=${encodeURIComponent(village)}&region=${encodeURIComponent(region)}`)
        .then((r) => r.json())
        .then((p) => alive && setFetched(p))
        .catch(() => {});
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [village, region]);
  const p = fromVisit ?? fetched;
  if (!p || !p.applies) return null;
  const tone = p.level === "high" ? "border-red-700 bg-red-950/50 text-red-200" : p.level === "medium" ? "border-amber-700 bg-amber-950/50 text-amber-200" : "border-emerald-800 bg-emerald-950/40 text-emerald-200";
  return (
    <div className={`rounded-xl border px-4 py-2 text-sm ${tone}`}>
      <span className="font-semibold">Malaria pressure in {p.village} this week: {p.level.toUpperCase()}</span> — {p.reasons.join(", ")}.
      <span className="ml-1 text-xs opacity-70">Malaria starts {p.priorShift >= 0 ? "+" : ""}{Math.round(p.priorShift * 100)}% among fever causes; the rapid test still decides.</span>
    </div>
  );
}

// The microphone, in one line: on with a live level, how many words came back, or blocked and why.
function MicLine({ mic, level, big }: { mic: MicState; level: number; big?: boolean }) {
  const meter = (color: string) => (
    <div className={`${big ? "h-4 w-[32rem]" : "h-2 w-full"} overflow-hidden rounded-full bg-slate-800`}>
      <div className={`${big ? "h-4" : "h-2"} ${color} transition-all`} style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  );
  const text = big ? "mt-3 text-xl text-slate-300" : "text-xs text-slate-400";
  if (mic.state === "blocked")
    return (
      <p className={`${big ? "text-2xl" : "text-xs"} text-amber-300`}>
        🎙️ Microphone blocked: {mic.reason}
      </p>
    );
  if (mic.state === "listening")
    return (
      <div className={big ? "flex flex-col items-center" : ""}>
        {meter("bg-red-500")}
        <p className={text}>
          <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
          Microphone on — I&apos;m listening
        </p>
      </div>
    );
  if (mic.state === "testing")
    return (
      <div className={big ? "flex flex-col items-center" : ""}>
        {meter("bg-emerald-500")}
        <p className={text}>Testing the microphone — say something</p>
      </div>
    );
  if (mic.state === "heard") return <p className={text}>🎙️ {mic.note ?? `Heard ${mic.words ?? 0} word${mic.words === 1 ? "" : "s"}`}</p>;
  return mic.note ? <p className={text}>🎙️ {mic.note}</p> : big ? null : <p className={text}>🎙️ Microphone idle</p>;
}

// One turn's clock for the operator: where the seconds went between the patient falling silent
// and the pod's voice.
function TimingLine({ t }: { t: TurnTiming | null }) {
  if (!t) return null;
  const s = (a?: number, b?: number) => (a != null && b != null ? `${((a - b) / 1000).toFixed(1)} s` : "…");
  const claude = t.stepMs != null && t.jevMs != null ? `${((t.stepMs - t.jevMs) / 1000).toFixed(1)} s` : "…";
  return (
    <p className="text-xs tabular-nums text-slate-500">
      Turn timing · spoke {((t.spokeMs ?? 0) / 1000).toFixed(1)} s · stop→transcript {s(t.sttDone, t.speechEnd)} · →decision {s(t.triageDone, t.sttDone)} (Jev {t.jevMs != null ? `${(t.jevMs / 1000).toFixed(1)} s` : "…"}, Claude+other {claude}) · →voice {s(t.ttsFirstByte, t.triageDone)} · →sound {s(t.audioPlaying, t.ttsFirstByte)} ·{" "}
      <span className="font-semibold text-slate-300">stop→sound {s(t.audioPlaying, t.speechEnd)}</span> · sound ended→listening {s(t.listeningAgain, t.audioEnded)}
    </p>
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

export function Conversation({ turns }: { turns: Turn[] }) {
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
    // A face alone never suggests suicide risk: that is only ever asked, gently, in conversation.
    if (inPath) names.push(...p.subtypes.filter((s) => s.urgency !== "green" && s.name !== "Suicide risk").slice(0, 2).map((s) => s.name));
  }
  return [...new Set(names)].slice(0, 4);
}

// Cause.probability is the engine's own 0..1 figure. The percent on screen is that number.
function confidencePercent(probability: number): number {
  return Math.round(Math.max(0, Math.min(1, probability)) * 100);
}

function ordersForCause(orders: TriageResult["orders"], name: string) {
  return (orders ?? []).filter((o) => o.for === name);
}

function orderPhrase(orders: TriageResult["orders"], name: string): string {
  return ordersForCause(orders, name)
    .map((o) => `${o.qty}× ${o.item}${o.note ? ` (${o.note})` : ""}`)
    .join(" · ");
}

// One line for the condition the engine is willing to name, then every other candidate
// underneath, highest probability first. The order on the line is the stock that condition sends.
export function ConditionRank({ result, village, band }: { result: TriageResult; village?: string | null; band?: boolean }) {
  const ranked = [...result.causes].sort((a, b) => b.probability - a.probability);
  // The line is the condition that gets ordered when the engine has named one, otherwise the
  // current highest probability, marked as not ordered so a guess never looks like a decision.
  const namedLead = ranked.find((c) => c.confident) ?? null;
  const lead = namedLead ?? ranked[0] ?? null;
  const rest = ranked.filter((c) => c !== lead);
  const place = village?.trim() || null;
  const phrase = namedLead ? orderPhrase(result.orders, namedLead.name) : "";
  const orderText = !namedLead
    ? `Not ordered yet${place ? ` for ${place}` : ""}`
    : phrase
      ? `Order${place ? ` for ${place}` : ""}: ${phrase}`
      : `No shelf order${place ? ` for ${place}` : ""}`;

  const others = rest.length > 0 && (
    <ul className={band ? "mt-3 space-y-1" : "mt-3 space-y-1.5 border-t border-slate-800 pt-3"}>
      <li className="text-xs uppercase tracking-wide text-slate-500">Other candidates</li>
      {rest.map((c) => {
        const own = c.confident ? orderPhrase(result.orders, c.name) : "";
        return (
          <li key={c.name} className="grid grid-cols-[minmax(0,1.4fr)_minmax(5rem,1fr)_2.75rem] items-center gap-3 text-sm text-slate-400">
            <span className="min-w-0">
              <span className="block truncate">{c.name}</span>
              {own && <span className="block text-xs text-slate-500">{own}</span>}
            </span>
            <span className="h-1 overflow-hidden rounded-full bg-slate-800" aria-hidden>
              <span className="block h-1 rounded-full bg-slate-500" style={{ width: `${confidencePercent(c.probability)}%` }} />
            </span>
            <span className="text-right tabular-nums">
              {confidencePercent(c.probability)}%
              {c.jev != null && confidencePercent(c.jev) !== confidencePercent(c.probability) && (
                <span className="mt-0.5 block text-[10px] text-slate-500">Jev {confidencePercent(c.jev)}%</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );

  if (!lead) {
    return (
      <div className={band ? "border-b border-slate-800 bg-slate-950 px-8 py-4 text-left" : ""}>
        {band && <p className="text-xs uppercase tracking-widest text-slate-500">Highest confidence</p>}
        <p className={`${band ? "mt-1 text-lg text-slate-300" : "text-sm text-slate-400"}`}>
          {result.complaint_known
            ? `Nothing named yet${place ? ` for ${place}` : ""}. Nothing is ordered until the evidence is strong.`
            : "No assumptions yet. The pod first asks what brought the patient in."}
        </p>
        {others}
      </div>
    );
  }

  return (
    <div className={band ? "border-b border-slate-800 bg-slate-950 px-8 py-4 text-left" : ""}>
      {band && <p className="text-xs uppercase tracking-widest text-slate-500">Highest confidence</p>}
      <p className={`font-semibold leading-snug ${band ? "mt-1 text-3xl" : "text-2xl"}`}>
        <span className="whitespace-nowrap">
          {lead.name} <span className="ml-2 tabular-nums">{confidencePercent(lead.probability)}%</span>
          {lead.jev != null && confidencePercent(lead.jev) !== confidencePercent(lead.probability) && (
            <span className="ml-2 text-base font-normal text-slate-400">Jev said {confidencePercent(lead.jev)}%</span>
          )}
        </span>{" "}
        <span className={`ml-2 font-medium ${namedLead ? "text-sky-200" : "text-slate-400"} ${band ? "text-xl" : "text-base"}`}>{orderText}</span>
      </p>
      {!band && namedLead && (
        <div className="mt-2 text-sm">
          <p className="text-xs text-slate-400">
            {namedLead.pathway} · {namedLead.why}
          </p>
          {namedLead.evidence.length > 0 && (
            <p className="mt-1.5">
              <span className="text-emerald-300">Because:</span> {namedLead.evidence.join(" · ")}
            </p>
          )}
          {namedLead.against.length > 0 && (
            <p>
              <span className="text-slate-400">Against:</span> {namedLead.against.join(" · ")}
            </p>
          )}
          {result.why && result.tree.some((p) => p.label === namedLead.pathway && p.steps.some((s) => s.status === "next")) && (
            <p className="mt-1 text-xs text-sky-300">Checking next: {result.why}</p>
          )}
        </div>
      )}
      {others}
    </div>
  );
}

export function ResultPanel({
  result,
  tests,
  intake,
  saved,
  voiceInfo,
  scan,
  scanMs,
  faceVisible,
  village,
  pulse,
  pulseFrom,
}: {
  result: TriageResult | null;
  tests: TestResults;
  intake: Intake;
  saved: { name: string | null; community: string | null; handover: string | null } | null;
  voiceInfo: string;
  scan: TraitScan;
  scanMs: number | null;
  faceVisible: boolean;
  village?: string | null;
  pulse?: { heartRateBpm: number | null; heartRateConfidence: number } | null;
  pulseFrom?: "watch" | "finger" | "camera";
}) {
  const silentFace = new Set(["face_droop", "eyelid_droop", "holding_head", "eyes_closing", "drowsy", "slumped"]);
  const sweat = scan.sweaty ?? 0;
  const sweatingNow = sweat >= 0.4;
  const seenTraits = TRAITS.filter((t) => !silentFace.has(t.id) && t.id !== "sweaty" && (scan[t.id] ?? 0) >= 0.6).sort((a, b) => (scan[b.id] ?? 0) - (scan[a.id] ?? 0));
  const cameraCard = (
    <Card title={`Camera · ${TRAITS.length} traits checked${scanMs ? ` · ${scanMs} ms` : ""}`}>
      {sweatingNow && (
        <p className="mb-2 rounded-lg border border-amber-400/40 bg-amber-950/50 px-3 py-2 text-sm text-amber-100">
          Sweating — seen on the face right now · {Math.round(sweat * 100)}%
        </p>
      )}
      {!sweatingNow && faceVisible && (
        <p className="mb-2 text-xs text-slate-500">Sweat on the face · {Math.round(sweat * 100)}%. Called sweating once it is clearly wet, not a light shine.</p>
      )}
      {pulse?.heartRateBpm != null && (
        <p className="mb-2 font-mono text-sm text-cyan-100">
          Pulse {Math.round(pulse.heartRateBpm)} bpm · {pulseFrom === "watch" ? "from the watch" : pulseFrom === "finger" ? "from the finger sensor" : `confidence ${Math.round((pulse.heartRateConfidence ?? 0) * 100)}%`}
        </p>
      )}
      {!faceVisible && !Object.keys(scan).length ? (
        <p className="text-sm text-slate-400">The visit starts when they say what they feel. A resting face is not read as a droop. Pulse is asked only if the heart is part of it.</p>
      ) : seenTraits.length ? (
        seenTraits.slice(0, 6).map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <span className="font-medium">{t.label}</span>
            <span className="text-slate-500">→ ask about</span>
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
        <div className="rounded-2xl border border-dashed border-cyan-200/20 p-5 text-sm text-slate-400">
          Nothing is assumed yet. After they say what they feel, Jev’s probabilities for each condition appear here, with the evidence for and against. The percent is Jev’s own number once they have named the problem.
        </div>
      </div>
    );
  }

  const u = URGENCY_STYLE[result.urgency];
  const ranked = [...result.causes].sort((a, b) => b.probability - a.probability);
  const lead = ranked.find((c) => c.confident) ?? null;
  const named = new Set(result.causes.filter((c) => c.confident).map((c) => c.name));
  const otherOrders = (result.orders ?? []).filter((o) => !named.has(o.for));
  const exploring = result.tree.map((p) => p.label);
  const stepsDone = result.tree.reduce((n, p) => n + p.steps.filter((s) => s.status === "yes" || s.status === "no").length, 0);
  const place = village?.trim() || intake.community || null;
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

      <Card title={ranked.length ? "Confidence · Jev" : "No conclusion yet"}>
        <p className="mb-3 text-xs leading-relaxed text-slate-500">
          Each percent is Jev’s probability for that condition from what was said. It is not reduced for being early. A safety rule can raise the number the pod acts on; when that happens, Jev’s own figure stays beside it. A resting face does not move any of these.
        </p>
        <ConditionRank result={result} village={place} />
        {!lead && exploring.length > 0 && (
          <p className="mt-2 text-sm text-slate-400">
            Exploring: <span className="text-slate-200">{exploring.join(" · ")}</span> · {stepsDone} answers so far
          </p>
        )}
        {lead && <p className="mt-2 text-xs text-slate-500">Sent to the patient&apos;s home via the network when the visit ends. Nothing is ordered for a guess.</p>}
      </Card>

      {result.findings.length > 0 && (
        <Card title="What they said · Jev">
          <ul className="space-y-1.5">
            {result.findings.map((f) => (
              <li key={f.key} className="grid grid-cols-[minmax(0,1.4fr)_minmax(4rem,1fr)_2.75rem] items-center gap-3 text-sm">
                <span className="truncate">
                  {f.label} <span className="text-xs text-slate-500">{f.source}</span>
                </span>
                <span className="h-1 overflow-hidden rounded-full bg-slate-800" aria-hidden>
                  <span className="block h-1 rounded-full bg-cyan-300/80" style={{ width: `${confidencePercent(f.yes)}%` }} />
                </span>
                <span className="text-right font-mono tabular-nums text-slate-300">{confidencePercent(f.yes)}%</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {cameraCard}

      {result.tree.length > 0 && (
        <Card title="Diagnostic path · if this → ask that">
          {result.tree.map((p) => (
            <div key={p.id} className="mb-3 last:mb-0">
              <div className="flex items-baseline justify-between">
                <p className="font-semibold">{p.label}</p>
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

      {otherOrders.length > 0 && (
        <Card title={lead ? "Also ordered this visit" : "Order placed · exactly what this patient gets"}>
          <div className="space-y-1">
            {otherOrders.map((o) => (
              <div key={o.item} className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  <span className="font-semibold tabular-nums">{o.qty}×</span> {o.item}
                  {o.note && <span className="text-xs text-slate-400"> · {o.note}</span>}
                </span>
                <span className="text-xs text-sky-300">for {o.for}</span>
              </div>
            ))}
          </div>
          {!lead && <p className="mt-2 text-xs text-slate-500">Sent to the patient&apos;s home via the network when the visit ends. Nothing is ordered for a guess.</p>}
        </Card>
      )}

      {(lead || result.rule_hits.length > 0) && result.resources.some((r) => r.probability >= 0.6) && (
        <Card title="Have ready for this patient">
          <div className="flex flex-wrap gap-2">
            {result.resources
              .filter((r) => r.probability >= 0.6)
              .slice(0, 8)
              .map((r) => (
                <span key={r.item} className="rounded-lg bg-slate-800 px-2.5 py-1 text-sm">
                  {r.item} <span className="text-xs text-slate-400">· {DELIVERY[r.delivery]}</span>
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
                  {f.label} · {f.yes >= 0.6 ? "yes" : f.known ? "no" : "unclear"} · {f.source}
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
    <div className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900 p-4">
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

function Ecg({ bpm }: { bpm: number | null }) {
  return (
    <div className="mt-8 w-full max-w-xl">
      <svg viewBox="0 0 360 72" className="pod-ecg h-16 w-full" aria-hidden>
        <polyline points="0,36 40,36 52,36 60,14 70,58 80,28 92,36 140,36 152,36 160,14 170,58 180,28 192,36 240,36 252,36 260,14 270,58 280,28 292,36 360,36" />
      </svg>
      <p className="mt-2 font-mono text-sm tracking-[0.22em] text-cyan-100/80">
        {bpm != null ? `${Math.round(bpm)} BPM` : "ACQUIRING PULSE"}
      </p>
    </div>
  );
}
