// Microphone recording -> 16 kHz mono WAV (a format every speech-to-text model accepts),
// and playback of the pod's voice with a browser-voice fallback.

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.rec = null;
    return toWav(new Blob(this.chunks, { type: rec.mimeType }));
  }
}

// Hands-free listening: waits for the patient to start talking, and stops by itself after they
// have been quiet for a moment. Returns null if nobody spoke within `waitMs`.
export async function listenForUtterance(opts: {
  waitMs?: number;
  silenceMs?: number;
  maxMs?: number;
  onLevel?: (level: number, speaking: boolean) => void;
  signal?: AbortSignal;
}): Promise<Blob | null> {
  const { waitMs = 12000, silenceMs = 1300, maxMs = 25000, onLevel, signal } = opts;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(100);

  const buf = new Float32Array(analyser.fftSize);
  const t0 = performance.now();
  let noise = 0.01, calibrated = 0, speechAt = 0, lastVoice = 0, spokeMs = 0, last = t0;
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
        if (!speechAt) speechAt = now;
        lastVoice = now;
        spokeMs += now - last;
      }
      last = now;
      onLevel?.(Math.min(1, rms / (threshold * 3)), Boolean(speechAt));
      if (speechAt && spokeMs > 250 && now - lastVoice > silenceMs) return resolve("speech");
      if (!speechAt && now - t0 > waitMs) return resolve("none");
      if (now - t0 > maxMs) return resolve(speechAt ? "speech" : "none");
      requestAnimationFrame(step);
    };
    step();
  });

  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.stop();
  });
  stream.getTracks().forEach((t) => t.stop());
  await ctx.close();
  onLevel?.(0, false);
  if (outcome === "none") return null;
  return toWav(new Blob(chunks, { type: rec.mimeType }));
}

async function toWav(blob: Blob, rate = 16000): Promise<Blob> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
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
