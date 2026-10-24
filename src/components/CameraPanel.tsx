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
  startSmileTest: () => void;
  finishSmileTest: () => "normal" | "asymmetric" | null;
  reset: () => void;
};

export type LiveCamera = CameraSignals & { faceVisible: boolean; hrCoverage: number };

type Props = { onSignals: (s: LiveCamera) => void; smileTest: CameraSignals["smileTest"] };

export const CameraPanel = forwardRef<CameraHandle, Props>(function CameraPanel({ onSignals, smileTest }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const droop = useRef(new DroopTracker());
  const hr = useRef(new HeartRateEstimator());
  const smileRef = useRef(smileTest);
  const onSignalsRef = useRef(onSignals);
  const [status, setStatus] = useState("Starting camera…");

  smileRef.current = smileTest;
  onSignalsRef.current = onSignals;

  useImperativeHandle(ref, () => ({
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
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
        const video = videoRef.current!;
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
  }, []);

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
      <canvas ref={overlayRef} className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
      {status && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-slate-300">{status}</div>
      )}
    </div>
  );
});
