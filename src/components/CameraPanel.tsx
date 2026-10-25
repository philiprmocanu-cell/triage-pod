"use client";

import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DroopTracker, measureFrame } from "@/lib/camera/faceDroop";
import { HeartRateEstimator } from "@/lib/camera/heartRate";
import type { CameraSignals } from "@/lib/triage/types";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Skin patches for the heart-rate signal: forehead centre and both cheeks.
const ROI_POINTS = [151, 50, 280];
const FACE_EDGE = [234, 454];

export type CameraHandle = {
  capture: (maxWidth?: number) => string | null; // base64 JPEG of the current frame, for Jev
  captureFace: () => string | null; // square close-up of the face (360 px), null when no face
  startSmileTest: () => void;
  finishSmileTest: () => "normal" | "asymmetric" | null;
  reset: () => void;
};

export type LiveCamera = CameraSignals & { faceVisible: boolean; hrCoverage: number };

// `remote`: address of the wireless pod head (e.g. http://triagepod.local); pictures come from its
// camera over Wi-Fi instead of a webcam plugged into this computer.
type Props = { onSignals: (s: LiveCamera) => void; smileTest: CameraSignals["smileTest"]; remote?: string };

export const CameraPanel = forwardRef<CameraHandle, Props>(function CameraPanel({ onSignals, smileTest, remote }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const droop = useRef(new DroopTracker());
  const hr = useRef(new HeartRateEstimator());
  const smileRef = useRef(smileTest);
  const lastFace = useRef<{ x: number; y: number }[] | null>(null);
  const onSignalsRef = useRef(onSignals);
  const [status, setStatus] = useState("Starting camera…");
  const [evidence, setEvidence] = useState<string[]>([]);

  smileRef.current = smileTest;
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
    reset: () => {
      droop.current.reset();
      hr.current.reset();
    },
  }));

  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let landmarker: FaceLandmarker | null = null;
    const sampler = document.createElement("canvas");
    sampler.width = 320;
    sampler.height = 240;
    const sctx = sampler.getContext("2d", { willReadFrequently: true })!;
    let lastVideoTime = -1;
    let faceVisible = false;
    let lastEmit = 0;

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
      const overlay = overlayRef.current;
      const octx = overlay?.getContext("2d");
      if (overlay && octx) {
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;
        octx.clearRect(0, 0, overlay.width, overlay.height);
      }

      if (lm) {
        droop.current.push(measureFrame(lm, res.faceBlendshapes?.[0]?.categories));
        sampleSkin(lm, now / 1000);
        if (overlay && octx) drawOverlay(octx, lm, overlay.width, overlay.height);
      }

      if (now - lastEmit > 500) {
        lastEmit = now;
        const est = hr.current.estimate();
        onSignalsRef.current({
          heartRateBpm: est?.bpm ?? null,
          heartRateConfidence: est?.confidence ?? 0,
          droop: faceVisible ? droop.current.state() : null,
          smileTest: smileRef.current,
          faceVisible,
          hrCoverage: hr.current.coverage(),
        });
      }
    }

    function sampleSkin(lm: NormalizedLandmark[], t: number) {
      const video = videoRef.current!;
      sctx.drawImage(video, 0, 0, sampler.width, sampler.height);
      const faceW = Math.abs(lm[FACE_EDGE[1]].x - lm[FACE_EDGE[0]].x) * sampler.width;
      const half = Math.max(3, Math.round(faceW * 0.07));
      let r = 0, g = 0, b = 0, n = 0;
      for (const idx of ROI_POINTS) {
        const cx = Math.round(lm[idx].x * sampler.width), cy = Math.round(lm[idx].y * sampler.height);
        const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
        const w = Math.min(sampler.width - x0, half * 2), h = Math.min(sampler.height - y0, half * 2);
        if (w <= 0 || h <= 0) continue;
        const d = sctx.getImageData(x0, y0, w, h).data;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          n++;
        }
      }
      if (n) hr.current.push(t, r / n, g / n, b / n);
    }

    function drawOverlay(ctx: CanvasRenderingContext2D, lm: NormalizedLandmark[], w: number, h: number) {
      const p = (i: number) => [lm[i].x * w, lm[i].y * h] as const;
      const flagged = droop.current.state().flagged;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(56,189,248,0.9)";
      ctx.beginPath();
      ctx.moveTo(...p(33));
      ctx.lineTo(...p(263));
      ctx.stroke();
      ctx.strokeStyle = flagged ? "rgba(239,68,68,0.95)" : "rgba(52,211,153,0.9)";
      ctx.beginPath();
      ctx.moveTo(...p(61));
      ctx.lineTo(...p(291));
      ctx.stroke();
      const faceW = Math.abs(lm[454].x - lm[234].x) * w;
      const half = faceW * 0.07;
      ctx.strokeStyle = "rgba(251,191,36,0.8)";
      for (const idx of ROI_POINTS) {
        const [x, y] = p(idx);
        ctx.strokeRect(x - half, y - half, half * 2, half * 2);
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

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
      <canvas ref={overlayRef} className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
      {status && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-slate-300">{status}</div>
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
