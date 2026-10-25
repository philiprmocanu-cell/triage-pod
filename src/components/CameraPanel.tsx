"use client";

import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DroopTracker, measureFrame } from "@/lib/camera/faceDroop";
import { HeartRateEstimator } from "@/lib/camera/heartRate";
import type { CameraSignals } from "@/lib/triage/types";

// Served from this app (public/mediapipe), so the face model loads in well under a second and works offline.
const WASM = "/mediapipe/wasm";
const MODEL = "/mediapipe/face_landmarker.task";

// Skin patches for the heart-rate signal: forehead centre and both cheeks. Landmarks pick the
// patches. Nothing is drawn on the face.

export type CameraHandle = {
  capture: (maxWidth?: number) => string | null; // base64 JPEG of the current frame, for Jev
  captureFace: () => string | null; // square close-up of the face (360 px), null when no face
  startSmileTest: () => void;
  finishSmileTest: () => "normal" | "asymmetric" | null;
  readPulse: () => { bpm: number | null; confidence: number };
  reset: () => void;
};

export type LiveCamera = CameraSignals & { faceVisible: boolean; hrCoverage: number };

// `remote`: address of the wireless pod head (e.g. http://triagepod.local); pictures come from its
// camera over Wi-Fi instead of a webcam plugged into this computer.
type Props = {
  onSignals: (s: LiveCamera) => void;
  smileTest: CameraSignals["smileTest"];
  remote?: string;
  measurePulse?: boolean; // true only while the visit is on the camera-pulse step
  externalBpm?: number | null; // pulse already read from the watch or the arm sensor
  armPrompt?: boolean; // the visit is asking them to place an arm so the pulse can show on this video
};

export const CameraPanel = forwardRef<CameraHandle, Props>(function CameraPanel({ onSignals, smileTest, remote, measurePulse = false, externalBpm = null, armPrompt = false }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const droop = useRef(new DroopTracker());
  const pulse = useRef(new HeartRateEstimator());
  const smileRef = useRef(smileTest);
  const measureRef = useRef(measurePulse);
  const wasMeasuring = useRef(false);
  const lastFace = useRef<{ x: number; y: number }[] | null>(null);
  const onSignalsRef = useRef(onSignals);
  const [status, setStatus] = useState("Starting camera…");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [hr, setHr] = useState<{ bpm: number | null; confidence: number; coverage: number; live: boolean }>({ bpm: null, confidence: 0, coverage: 0, live: false });

  smileRef.current = smileTest;
  measureRef.current = measurePulse;
  onSignalsRef.current = onSignals;

  useImperativeHandle(ref, () => ({
    capture: (maxWidth = 640) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return null;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const c = document.createElement("canvas");
      c.width = Math.round(video.videoWidth * scale);
      c.height = Math.round(video.videoHeight * scale);
      c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.8).split(",")[1];
    },
    // Jev judges skin, eyes and lips far better on a close-up than on a whole room: crop a square
    // around the last detected face with a third of its size as margin, scaled to 360 px.
    captureFace: () => {
      const video = videoRef.current, lm = lastFace.current;
      if (!video || !video.videoWidth || !lm) return null;
      const xs = lm.map((p) => p.x), ys = lm.map((p) => p.y);
      const w = video.videoWidth, h = video.videoHeight;
      const cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * w, cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * h;
      const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * Math.max(w, h) * 1.7;
      const x0 = Math.max(0, cx - size / 2), y0 = Math.max(0, cy - size / 2);
      const sw = Math.min(size, w - x0), sh = Math.min(size, h - y0);
      const c = document.createElement("canvas");
      c.width = c.height = 360;
      c.getContext("2d")!.drawImage(video, x0, y0, sw, sh, 0, 0, 360, 360);
      return c.toDataURL("image/jpeg", 0.85).split(",")[1];
    },
    startSmileTest: () => droop.current.startSmileTest(),
    finishSmileTest: () => droop.current.finishSmileTest(),
    readPulse: () => {
      const est = pulse.current.estimate();
      return { bpm: est?.bpm ?? null, confidence: est?.confidence ?? 0 };
    },
    reset: () => {
      droop.current.reset();
      pulse.current.reset();
      wasMeasuring.current = false;
    },
  }));

  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let landmarker: FaceLandmarker | null = null;
    let lastVideoTime = -1;
    let faceVisible = false;
    let lastEmit = 0;
    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d", { willReadFrequently: true });

    (async () => {
      try {
        const video = videoRef.current!;
        if (remote) {
          setStatus("Connecting to the pod's camera…");
          stream = await podStream(remote, () => stopped, setStatus);
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
        }
        video.srcObject = stream;
        await video.play();
        setStatus("Loading face model…");
        const fileset = await FilesetResolver.forVisionTasks(WASM);
        landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
        });
        setStatus("");
        loop();
      } catch (e) {
        setStatus(`Camera unavailable: ${e instanceof Error ? e.message : e}`);
      }
    })();

    function loop() {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video || !landmarker || video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      const now = performance.now();
      const res = landmarker.detectForVideo(video, now);
      const lm = res.faceLandmarks?.[0];
      faceVisible = Boolean(lm);
      lastFace.current = lm ?? null;

      if (lm) droop.current.push(measureFrame(lm, res.faceBlendshapes?.[0]?.categories));

      // Pulse is sampled only while the visit asked for it. The estimator keeps the last window
      // after that, so the reading stays on screen for the rest of the visit.
      if (measureRef.current) {
        if (!wasMeasuring.current) {
          pulse.current.reset();
          wasMeasuring.current = true;
        }
        const rgb = sctx ? sampleSkin(sctx, scratch, video, lm) : null;
        if (rgb) pulse.current.push(now / 1000, rgb.r, rgb.g, rgb.b);
      } else if (wasMeasuring.current) {
        wasMeasuring.current = false;
      }

      if (now - lastEmit > 500) {
        lastEmit = now;
        const est = pulse.current.estimate();
        const coverage = pulse.current.coverage();
        const reading = {
          bpm: est?.bpm ?? null,
          confidence: est?.confidence ?? 0,
          coverage,
          live: measureRef.current,
        };
        setHr(reading);
        onSignalsRef.current({
          heartRateBpm: est?.bpm ?? null,
          heartRateConfidence: est?.confidence ?? 0,
          droop: null,
          smileTest: smileRef.current,
          faceVisible,
          hrCoverage: coverage,
        });
      }
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      landmarker?.close();
    };
  }, [remote]);

  // Scoring honesty, for the operator: what the live scan thinks it sees and why the pod did or did
  // not act on it ("face droop 0.52 × 1 burst — not asked (needs 3)"). Read from /api/scan every
  // two seconds; shown on the operator screen (/pod) only, never on the patient-facing kiosk.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (window.location.pathname.startsWith("/kiosk")) {
        setEvidence([]);
        return;
      }
      try {
        const res = await fetch("/api/scan", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as { at: number; evidence: string[] };
          setEvidence(Date.now() - d.at < 15_000 ? d.evidence : []); // stale lines vanish when the scan stops
        }
      } catch {
        /* the line is a courtesy; the camera keeps running */
      }
    };
    const id = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const pulseLabel = hr.live
    ? hr.bpm != null
      ? `${Math.round(hr.bpm)}`
      : "…"
    : hr.bpm != null
      ? `${Math.round(hr.bpm)}`
      : "—";

  return (
    <div className="pod-cam relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
      <div className="pointer-events-none absolute inset-3 rounded-xl border border-cyan-200/25" />
      <div className="pointer-events-none absolute left-5 top-5 h-4 w-4 border-l border-t border-cyan-200/80" />
      <div className="pointer-events-none absolute right-5 top-5 h-4 w-4 border-r border-t border-cyan-200/80" />
      <div className="pointer-events-none absolute bottom-5 left-5 h-4 w-4 border-b border-l border-cyan-200/80" />
      <div className="pointer-events-none absolute bottom-5 right-5 h-4 w-4 border-b border-r border-cyan-200/80" />
      {hr.live && <div className="pod-sweep pointer-events-none absolute inset-x-6 top-0 h-px bg-cyan-200/80" />}
      {armPrompt && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/45 px-4 text-center">
          <p className="text-xl font-semibold text-white">Place your arm on the sensor and hold still.</p>
          <p className="mt-4 font-mono text-6xl font-semibold tabular-nums leading-none text-white">
            {externalBpm != null ? externalBpm : "—"}
            <span className="ml-2 text-lg font-normal text-cyan-100">bpm</span>
          </p>
          <p className="mt-3 text-sm text-cyan-100">{externalBpm != null ? "Pulse, on the video" : "The number shows here once the arm is on"}</p>
        </div>
      )}
      <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3 rounded-lg bg-black/55 px-3 py-2 font-mono text-[11px] text-cyan-100 backdrop-blur-sm">
        <div>
          <p className="tracking-[0.22em] text-cyan-200/70">{armPrompt ? "SHOW YOUR PULSE" : hr.live ? "READING PULSE" : externalBpm != null || hr.bpm != null ? "PULSE" : "PULSE STANDBY"}</p>
          <p className="text-2xl font-semibold tabular-nums leading-none text-white">
            {externalBpm != null ? externalBpm : pulseLabel}
            <span className="ml-1 text-xs font-normal text-cyan-100/70">bpm</span>
          </p>
        </div>
        <p className="max-w-[11rem] text-right leading-snug text-cyan-100/80">
          {armPrompt
            ? "Arm on the sensor"
            : externalBpm != null
              ? "from the watch"
              : hr.live && hr.coverage < 8
                ? `Hold still ${Math.max(0, Math.ceil(8 - hr.coverage))}s`
                : hr.bpm != null
                  ? `confidence ${Math.round(hr.confidence * 100)}%`
                  : "Asked only if the heart is part of it"}
        </p>
      </div>
      {status && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 p-6 text-center text-sm text-slate-300">{status}</div>
      )}
      {evidence.length > 0 && (
        <div className="absolute inset-x-0 top-0 space-y-0.5 bg-slate-950/75 px-3 py-2 font-mono text-[11px] leading-snug text-amber-200">
          {evidence.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
});

// Average colour of a small skin patch. Landmarks aim it at the forehead and cheeks;
// with no mesh, the upper middle of the frame is used. Nothing is stroked onto the picture.
function sampleSkin(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  lm: NormalizedLandmark[] | undefined,
): { r: number; g: number; b: number } | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(video, 0, 0, w, h);
  const patches = lm
    ? [10, 67, 297, 50, 280].filter((i) => lm[i]).map((i) => ({ x: lm[i].x * w - 7, y: lm[i].y * h - 7, w: 14, h: 14 }))
    : [{ x: w * 0.35, y: h * 0.2, w: w * 0.3, h: h * 0.16 }];
  let r = 0, g = 0, b = 0, n = 0;
  for (const p of patches) {
    const hit = avgRect(ctx, p.x, p.y, p.w, p.h, w, h);
    if (!hit) continue;
    r += hit.r;
    g += hit.g;
    b += hit.b;
    n++;
  }
  return n ? { r: r / n, g: g / n, b: b / n } : null;
}

function avgRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, maxW: number, maxH: number) {
  const x0 = Math.max(0, Math.min(maxW - 2, Math.round(x)));
  const y0 = Math.max(0, Math.min(maxH - 2, Math.round(y)));
  const rw = Math.max(2, Math.min(maxW - x0, Math.round(w)));
  const rh = Math.max(2, Math.min(maxH - y0, Math.round(h)));
  const data = ctx.getImageData(x0, y0, rw, rh).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  return n ? { r: r / n, g: g / n, b: b / n } : null;
}

// Turn the pod head's pictures (base64 JPEGs over Wi-Fi) into a normal video stream, so the face
// tracking, the live scan and the tests all work exactly as with a webcam.
async function podStream(base: string, stopped: () => boolean, setStatus: (s: string) => void): Promise<MediaStream> {
  const url = base.replace(/\/$/, "");
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 480, 480);
  const img = new Image();
  let got = false;
  const pull = async () => {
    while (!stopped()) {
      try {
        const res = await fetch(`${url}/frame`, { cache: "no-store" });
        if (res.ok) {
          img.src = `data:image/jpeg;base64,${await res.text()}`;
          await img.decode();
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          ctx.drawImage(img, 0, 0);
          if (!got) setStatus("");
          got = true;
        }
        await new Promise((r) => setTimeout(r, 150)); // at most ~6 pictures a second: the pod's chip is small
      } catch {
        setStatus(`Can't reach the pod at ${url} — same Wi-Fi? switched on?`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };
  void pull();
  return canvas.captureStream(10);
}
