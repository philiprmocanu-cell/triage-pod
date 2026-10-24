import { NextResponse } from "next/server";
import { cartesia, pickVoice, TTS_MODEL } from "@/lib/cartesia";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { text, locale } = (await req.json()) as { text: string; locale: string };
  try {
    const voice = await pickVoice(locale);
    const res = await cartesia().tts.generate({
      model_id: TTS_MODEL,
      transcript: text,
      voice: voice.id,
      locale,
      output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 },
    });
    return new Response(await res.arrayBuffer(), {
      headers: {
        "Content-Type": "audio/wav",
        "X-Voice-Name": encodeURIComponent(voice.name),
        "X-Voice-Match": voice.match,
      },
    });
  } catch (err) {
    console.error("tts failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Speech failed" }, { status: 500 });
  }
}
