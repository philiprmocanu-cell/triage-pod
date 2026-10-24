import { NextResponse } from "next/server";
import { cartesia, STT_MODEL } from "@/lib/cartesia";

export const runtime = "nodejs";

// Transcribe one recording. On the first turn the client sends several candidate languages;
// we transcribe under each and let the triage brain pick the one that reads as real speech.
export async function POST(req: Request) {
  const form = await req.formData();
  const audio = form.get("audio");
  const languages = String(form.get("languages") ?? "es").split(",").filter(Boolean);
  if (!(audio instanceof File)) return NextResponse.json({ error: "No audio" }, { status: 400 });

  try {
    const results = await Promise.all(
      languages.map(async (language) => {
        const res = await cartesia().stt.transcribe({ file: audio, model: STT_MODEL, language, timestamp_granularities: ["word"] });
        return [language, { text: res.text.trim(), speech: speechStats(res.words ?? []) }] as const;
      }),
    );
    return NextResponse.json({ transcripts: Object.fromEntries(results) });
  } catch (err) {
    console.error("stt failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Transcription failed" }, { status: 500 });
  }
}

// How the patient is speaking, not just what: very slow speech or long pauses can go with
// confusion, breathlessness or a stroke.
function speechStats(words: { start: number; end: number }[]) {
  if (words.length < 2) return { wordsPerSecond: 0, longPauses: 0 };
  const span = words[words.length - 1].end - words[0].start;
  let longPauses = 0;
  for (let i = 1; i < words.length; i++) if (words[i].start - words[i - 1].end > 1.5) longPauses++;
  return { wordsPerSecond: span > 0 ? words.length / span : 0, longPauses };
}
