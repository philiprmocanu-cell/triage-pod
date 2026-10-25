import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { cartesia, pickVoice, TTS_MODEL, ttsLocale } from "@/lib/cartesia";

export const runtime = "nodejs";

const SAMPLE_RATE = 24000;

// Fixed questions are spoken the same way at every visit: once generated for a voice, the PCM
// lives in data/tts-cache/<hash>.pcm and plays with no round trip to Cartesia at all.
const cacheDir = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "tts-cache");
const cacheKey = (text: string, voiceId: string, locale: string) => createHash("sha1").update(`${TTS_MODEL}|${voiceId}|${locale}|${SAMPLE_RATE}|${text}`).digest("hex");

export async function POST(req: Request) {
  const t0 = Date.now();
  const { text, locale, community, format } = (await req.json()) as { text: string; locale: string; community?: string; format?: "pcm" | "wav" };
  try {
    const voice = await pickVoice(locale, community);
    const loc = ttsLocale(locale);
    const headers: Record<string, string> = {
      "X-Voice-Name": encodeURIComponent(voice.name),
      "X-Voice-Match": voice.match,
      "X-Sample-Rate": String(SAMPLE_RATE),
      "Cache-Control": "no-store",
    };

    if (format === "wav") {
      // Old callers (and scripts) that want a whole file.
      const res = await cartesia().tts.generate({
        model_id: TTS_MODEL,
        transcript: text,
        voice: voice.id,
        locale: loc,
        output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
      });
      return new Response(await res.arrayBuffer(), { headers: { ...headers, "Content-Type": "audio/wav", "X-Cache": "bypass", "X-Tts-Ms": String(Date.now() - t0) } });
    }

    const file = path.join(cacheDir(), `${cacheKey(text, voice.id, loc)}.pcm`);
    const cached = await fs.readFile(file).catch(() => null);
    if (cached && cached.length > 1000) {
      return new Response(new Uint8Array(cached), { headers: { ...headers, "Content-Type": "audio/pcm", "X-Cache": "hit", "X-Tts-Ms": String(Date.now() - t0) } });
    }

    // Raw 16-bit PCM streams out of Cartesia as it is generated; pass it straight through and
    // keep a copy for next time.
    const res = await cartesia().tts.generate({
      model_id: TTS_MODEL,
      transcript: text,
      voice: voice.id,
      locale: loc,
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
    });
    const upstream = res.body;
    if (!upstream) {
      const buf = Buffer.from(await res.arrayBuffer());
      void saveCache(file, [buf]);
      return new Response(new Uint8Array(buf), { headers: { ...headers, "Content-Type": "audio/pcm", "X-Cache": "miss", "X-Tts-Ms": String(Date.now() - t0) } });
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
    return new Response(upstream.pipeThrough(tee), { headers: { ...headers, "Content-Type": "audio/pcm", "X-Cache": "miss", "X-Tts-Ms": String(Date.now() - t0) } });
  } catch (err) {
    console.error("tts failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Speech failed" }, { status: 500 });
  }
}

async function saveCache(file: string, parts: Buffer[]) {
  try {
    const all = Buffer.concat(parts);
    if (all.length < 1000) return; // an empty or failed generation is not worth remembering
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, all);
    await fs.rename(`${file}.tmp`, file);
  } catch (e) {
    console.warn("tts cache write failed", e);
  }
}
