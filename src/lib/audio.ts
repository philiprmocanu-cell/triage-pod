// Microphone recording -> 16 kHz mono WAV (a format every speech-to-text model accepts),
// and playback of the pod's voice (streamed PCM) with a browser-voice fallback.
//
// One microphone stream and one AudioContext are opened for the whole visit and reused by every
// turn: reopening the device per turn is what made the mic "choose not to work" (the previous
// recorder, or the camera, still held it -> NotReadableError; or a new AudioContext started
// suspended with no click on record -> the level meter read silence forever).

let sharedCtx: AudioContext | null = null;
export function audioCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext();
  return sharedCtx;
}

// Call from a click / key press: browsers only let audio start after a gesture.
export async function unlockAudio(): Promise<boolean> {
  try {
    const ctx = audioCtx();
    if (ctx.state !== "running") await ctx.resume();
    return ctx.state === "running";
  } catch {
    return false;
  }
}
export const audioUnlocked = () => sharedCtx?.state === "running";

let mic: MediaStream | null = null;
let micPending: Promise<MediaStream> | null = null;

// Open the microphone once and keep it for the whole visit. Throws a DOMException the caller can
// turn into words with micErrorText().
export function getMic(): Promise<MediaStream> {
  if (mic && mic.getAudioTracks().some((t) => t.readyState === "live")) return Promise.resolve(mic);
  if (micPending) return micPending;
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("no-media-devices"));
  micPending = navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then((s) => {
      mic = s;
      // The device was unplugged or taken by another app: forget it so the next turn reopens.
      s.getAudioTracks().forEach((t) => (t.onended = () => (mic = null)));
      return s;
    })
    .finally(() => (micPending = null));
  return micPending;
}

export function releaseMic() {
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
}

// What went wrong with the microphone, and what to do about it, in plain words.
export function micErrorText(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as { message?: string })?.message ?? String(e);
  if (!window.isSecureContext) return "The microphone only works over https or on localhost. Open the pod at http://localhost or an https address.";
  if (msg === "no-media-devices") return "This browser has no microphone access (navigator.mediaDevices missing). Use Chrome over https or localhost.";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError")
    return "Chrome blocked the microphone for this site — click the lock icon left of the address bar → Microphone → Allow, then reload the page.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone found — plug one in, or pick one in System Settings → Sound → Input, then press Test my microphone.";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
    return "The microphone is held by another app or tab (Zoom, another browser tab, a previous pod window) — close it and press Test my microphone.";
  if (name === "OverconstrainedError") return "The microphone does not support the requested settings — pick another input in System Settings → Sound.";
  return `Microphone error: ${name ? `${name}: ` : ""}${msg}`;
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async start() {
    const stream = await getMic();
    this.chunks = [];
    this.rec = new MediaRecorder(stream);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
  }

  async stop(): Promise<Blob> {
    const rec = this.rec;
    if (!rec) throw new Error("Not recording");
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    this.rec = null;
    return toWav(new Blob(this.chunks, { type: rec.mimeType }));
  }
}

export type Utterance = {
  wav: Blob;
  spokeMs: number; // how long the patient was actually voiced
  t: { opened: number; speechStart: number; speechEnd: number }; // performance.now() stamps
};

// Hands-free listening: waits for the patient to start talking, and stops by itself after they
// have been quiet for a moment. Returns null if nobody spoke within `waitMs`.
export async function listenForUtterance(opts: {
  waitMs?: number;
  silenceMs?: number;
  maxMs?: number;
  onLevel?: (level: number, speaking: boolean) => void;
  onPhase?: (phase: "waiting" | "speaking" | "finishing") => void;
  signal?: AbortSignal;
}): Promise<Utterance | null> {
  // silenceMs: how long the patient must be quiet before the pod answers. 1.2 s reads as a
  // natural pause; a short "no" ends even sooner (0.7x) because spokeMs is small.
  const { waitMs = 8000, silenceMs = 1200, maxMs = 20000, onLevel, onPhase, signal } = opts;
  const stream = await getMic();
  const ctx = audioCtx();
  try {
    await ctx.resume();
  } catch {
    /* handled below */
  }
  const meterWorks = ctx.state === "running";
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(100);
  onPhase?.("waiting");

  const buf = new Float32Array(analyser.fftSize);
  const t0 = performance.now();
  let noise = 0.01, calibrated = 0, speechAt = 0, lastVoice = 0, spokeMs = 0, last = t0, speechEnd = 0;
  const outcome = await new Promise<"speech" | "none">((resolve) => {
    const step = () => {
      if (signal?.aborted) return resolve("none");
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      const now = performance.now();
      if (calibrated < 15) {
        noise = Math.max(noise, rms);
        calibrated++;
      }
      const threshold = Math.max(0.02, noise * 2.5);
      const voiced = rms > threshold;
      if (voiced) {
        if (!speechAt) {
          speechAt = now;
          onPhase?.("speaking");
        }
        lastVoice = now;
        spokeMs += now - last;
      }
      last = now;
      onLevel?.(Math.min(1, rms / (threshold * 3)), Boolean(speechAt));
      if (!meterWorks) {
        // No level meter: take a fixed 7-second window and let speech-to-text decide.
        onLevel?.(0.5, true);
        if (now - t0 > 7000) {
          speechAt ||= t0;
          speechEnd = now;
          return resolve("speech");
        }
        return void requestAnimationFrame(step);
      }
      const quietFor = spokeMs < 1500 ? silenceMs * 0.7 : silenceMs; // a one-word answer needs less waiting
      if (speechAt && spokeMs > 250 && now - lastVoice > quietFor) {
        speechEnd = lastVoice;
        return resolve("speech");
      }
      if (!speechAt && now - t0 > waitMs) return resolve("none");
      if (now - t0 > maxMs) {
        speechEnd = now;
        return resolve(speechAt ? "speech" : "none");
      }
      requestAnimationFrame(step);
    };
    step();
  });

  onPhase?.("finishing");
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.stop();
  });
  source.disconnect();
  analyser.disconnect();
  onLevel?.(0, false);
  if (outcome === "none") return null;
  const wav = await toWav(new Blob(chunks, { type: rec.mimeType }));
  return { wav, spokeMs, t: { opened: t0, speechStart: speechAt, speechEnd } };
}

// "Test my microphone": open it, watch the level for `ms`, report the peak or the exact error.
export async function testMicrophone(opts: { ms?: number; onLevel?: (level: number) => void }): Promise<{ ok: true; peak: number } | { ok: false; error: string }> {
  const { ms = 5000, onLevel } = opts;
  try {
    const stream = await getMic();
    const ctx = audioCtx();
    await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const t0 = performance.now();
    let peak = 0;
    await new Promise<void>((resolve) => {
      const step = () => {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        peak = Math.max(peak, rms);
        onLevel?.(Math.min(1, rms / 0.1));
        if (performance.now() - t0 > ms) return resolve();
        requestAnimationFrame(step);
      };
      step();
    });
    source.disconnect();
    onLevel?.(0);
    if (ctx.state !== "running") return { ok: false, error: "The browser's audio engine is paused (no click on record). Click anywhere on the page, then test again." };
    if (peak < 0.005) return { ok: false, error: "The microphone opened but heard nothing (level stayed at zero). Check the input device in System Settings → Sound → Input and that it is not muted." };
    return { ok: true, peak };
  } catch (e) {
    return { ok: false, error: micErrorText(e) };
  }
}

async function toWav(blob: Blob, rate = 16000): Promise<Blob> {
  const decoded = await audioCtx().decodeAudioData(await blob.arrayBuffer());
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);

  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Play 16-bit mono PCM as it streams in from /api/tts: the first chunk sounds within a few
// hundred milliseconds of the server starting to generate, instead of after the whole clip.
// Resolves when the last scheduled sample has played. Rejects if the browser will not play audio
// (no gesture on record), so the caller can tell the operator.
export function playPcmStream(res: Response, opts: { sampleRate?: number; onFirstAudio?: () => void; signal?: AbortSignal } = {}): Promise<void> {
  const { sampleRate = 24000, onFirstAudio, signal } = opts;
  return new Promise<void>((resolve, reject) => {
    (async () => {
      const ctx = audioCtx();
      await ctx.resume().catch(() => {});
      if (ctx.state !== "running") throw new Error("Audio is blocked until someone taps the screen");
      const body = res.body;
      if (!body) throw new Error("Empty audio stream");
      const reader = body.getReader();
      let nextAt = 0; // ctx time at which the next buffer starts
      let leftover = new Uint8Array(0);
      let first = true;
      let pending = new Uint8Array(0);
      const sources: AudioBufferSourceNode[] = [];
      const schedule = (bytes: Uint8Array) => {
        const n = Math.floor(bytes.length / 2);
        if (!n) return;
        const audio = ctx.createBuffer(1, n, sampleRate);
        const ch = audio.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
        for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
        const src = ctx.createBufferSource();
        src.buffer = audio;
        src.connect(ctx.destination);
        const startAt = Math.max(nextAt, ctx.currentTime + (first ? 0.03 : 0.01));
        src.start(startAt);
        nextAt = startAt + audio.duration;
        sources.push(src);
        if (first) {
          first = false;
          onFirstAudio?.();
        }
      };
      const flushPending = () => {
        if (pending.length) schedule(pending);
        pending = new Uint8Array(0);
      };
      const stop = () => {
        sources.forEach((s) => {
          try {
            s.stop();
          } catch {
            /* already ended */
          }
        });
        reader.cancel().catch(() => {});
      };
      signal?.addEventListener("abort", stop, { once: true });
      const guard = setTimeout(() => {
        stop();
        resolve();
      }, 45_000);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        // Keep sample boundaries across chunks (an odd byte belongs to the next sample).
        const joined = new Uint8Array(leftover.length + value.length);
        joined.set(leftover);
        joined.set(value, leftover.length);
        const even = joined.length - (joined.length % 2);
        leftover = joined.slice(even);
        const chunk = joined.subarray(0, even);
        const merged = new Uint8Array(pending.length + chunk.length);
        merged.set(pending);
        merged.set(chunk, pending.length);
        pending = merged;
        // Play the very first bytes at once; afterwards gather ~100 ms per buffer so the queue stays smooth.
        if (first || pending.length >= sampleRate / 5) flushPending();
      }
      flushPending();
      clearTimeout(guard);
      const waitMs = Math.max(0, (nextAt - ctx.currentTime) * 1000) + 60;
      await new Promise((r) => setTimeout(r, signal?.aborted ? 0 : waitMs));
      resolve();
    })().catch(reject);
  });
}

// Playback never holds the visit hostage: if the browser blocks audio or an output device
// stalls, the promise still resolves once the clip's own length (plus a margin) has passed.
export function playBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      URL.revokeObjectURL(url);
      resolve();
    };
    let guard = setTimeout(finish, 20_000);
    audio.onloadedmetadata = () => {
      clearTimeout(guard);
      guard = setTimeout(finish, (Number.isFinite(audio.duration) ? audio.duration * 1000 : 15_000) + 2_000);
    };
    audio.onended = audio.onerror = finish;
    audio.play().catch(finish);
  });
}

export function speakWithBrowser(text: string, locale: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    u.onend = u.onerror = finish;
    setTimeout(finish, Math.min(30_000, 2_000 + text.length * 90)); // ~11 chars/s plus a margin
    speechSynthesis.speak(u);
  });
}

// The pod's reply, cut into "first sentence" and "the rest" so the first can be spoken while the
// rest is still being generated. One part when the text is short or a single sentence.
export function splitForSpeech(text: string): string[] {
  const trimmed = text.trim();
  const m = trimmed.match(/^(.{20,}?[.!?…])\s+(\S[\s\S]{15,})$/);
  if (!m) return [trimmed];
  return [m[1], m[2]];
}

// Join several of the pod's own 16 kHz mono WAV recordings into one clip (for voice learning).
export function mergeWavs(blobsData: ArrayBuffer[]): Blob {
  const parts = blobsData.map((b) => b.slice(44));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new ArrayBuffer(44 + total);
  const v = new DataView(out);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + total, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, total, true);
  let off = 44;
  for (const p of parts) {
    new Uint8Array(out, off, p.byteLength).set(new Uint8Array(p));
    off += p.byteLength;
  }
  return new Blob([out], { type: "audio/wav" });
}
