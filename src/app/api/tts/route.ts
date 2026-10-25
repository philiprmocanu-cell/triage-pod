import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { SAMPLE_RATE, grokSpeak, pickGrokVoice } from "@/lib/grokVoice";

export const runtime = "nodejs";

// Fixed questions are spoken the same way at every visit: once generated, the PCM
// lives in data/tts-cache/<hash>.pcm and plays with no round trip to Grok Voice.
const cacheDir = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "tts-cache");
const cacheKey = (text: string, voiceId: string, language: string) =>
  createHash("sha1").update(`grok-voice|${voiceId}|${language}|${SAMPLE_RATE}|${text}`).digest("hex");

export async function POST(req: Request) {
  const t0 = Date.now();
  const { text, locale, community, format } = (await req.json()) as { text: string; locale: string; community?: string; format?: "pcm" | "wav" };
  try {
    const voice = await pickGrokVoice(locale, community);
    const headers: Record<string, string> = {
      "X-Voice-Name": encodeURIComponent(voice.name),
      "X-Voice-Match": encodeURIComponent(voice.match),
      "X-Voice-Model": "grok-voice",
      "X-Sample-Rate": String(SAMPLE_RATE),
      "Cache-Control": "no-store",
    };

    if (format === "wav") {
      const res = await grokSpeak(text, voice, "wav");
      return new Response(await res.arrayBuffer(), {
        headers: { ...headers, "Content-Type": "audio/wav", "X-Cache": "bypass", "X-Tts-Ms": String(Date.now() - t0) },
      });
    }

    const file = path.join(cacheDir(), `${cacheKey(text, voice.id, voice.language)}.pcm`);
    const cached = await fs.readFile(file).catch(() => null);
    if (cached && cached.length > 1000) {
      return new Response(new Uint8Array(cached), {
        headers: { ...headers, "Content-Type": "audio/pcm", "X-Cache": "hit", "X-Tts-Ms": String(Date.now() - t0) },
      });
    }

    const res = await grokSpeak(text, voice, "pcm");
    const upstream = res.body;
    if (!upstream) {
      const buf = Buffer.from(await res.arrayBuffer());
      void saveCache(file, [buf]);
      return new Response(new Uint8Array(buf), {
        headers: { ...headers, "Content-Type": "audio/pcm", "X-Cache": "miss", "X-Tts-Ms": String(Date.now() - t0) },
      });
    }
    const parts: Buffer[] = [];
    const tee = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        parts.push(Buffer.from(chunk));
        controller.enqueue(chunk);
      },
      flush() {
        void saveCache(file, parts);
      },
    });
    return new Response(upstream.pipeThrough(tee), {
      headers: { ...headers, "Content-Type": "audio/pcm", "X-Cache": "miss", "X-Tts-Ms": String(Date.now() - t0) },
    });
  } catch (err) {
    console.error("grok voice tts failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Speech failed" }, { status: 500 });
  }
}

async function saveCache(file: string, parts: Buffer[]) {
  try {
    const all = Buffer.concat(parts);
    if (all.length < 1000) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, all);
    await fs.rename(`${file}.tmp`, file);
  } catch (e) {
    console.warn("tts cache write failed", e);
  }
}
