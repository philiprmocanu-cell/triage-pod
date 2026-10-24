import { NextResponse } from "next/server";
import { cartesia, pickVoice, PickedVoice, TTS_MODEL, ttsLocale, voiceNote } from "@/lib/cartesia";

export const runtime = "nodejs";

// Speak one line. `locale` is whatever the pod has heard so far (neutral until the patient's own
// words say otherwise). A `voice` cloned from this patient during the visit wins over the catalog.
export async function POST(req: Request) {
  const { text, locale, community, voice: own } = (await req.json()) as { text: string; locale: string; community?: string; voice?: { id: string; name: string } };
  try {
    const voice: PickedVoice = own ? { ...own, locale, match: "learned from this patient" } : await pickVoice(locale, community);
    const res = await cartesia().tts.generate({
      model_id: TTS_MODEL,
      transcript: text,
      voice: voice.id,
      locale: ttsLocale(locale),
      output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 },
    });
    return new Response(await res.arrayBuffer(), {
      headers: {
        "Content-Type": "audio/wav",
        "X-Voice-Name": encodeURIComponent(voice.name),
        "X-Voice-Match": voice.match,
        "X-Voice-Note": encodeURIComponent(voiceNote(locale, voice.match) ?? ""),
      },
    });
  } catch (err) {
    console.error("tts failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Speech failed" }, { status: 500 });
  }
}
