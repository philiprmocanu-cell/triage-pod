import { NextResponse } from "next/server";
import { grokTranscribe } from "@/lib/grokVoice";
import { communityLexicon, dialectKeyterms } from "@/lib/triage/dialect";

export const runtime = "nodejs";

// Transcribe one recording with Grok Voice. On the first turn the client sends several
// candidate languages; we transcribe under each, biased toward that variety's words, and
// let the triage brain pick the transcript that reads as real speech.
export async function POST(req: Request) {
  const form = await req.formData();
  const audio = form.get("audio");
  const languages = String(form.get("languages") ?? "es").split(",").filter(Boolean);
  const locale = String(form.get("locale") ?? languages[0] ?? "en");
  const community = form.get("community") ? String(form.get("community")) : undefined;
  if (!(audio instanceof File)) return NextResponse.json({ error: "No audio" }, { status: 400 });

  try {
    const learned = await communityLexicon(community);
    const results = await Promise.all(
      languages.map(async (language) => {
        const variety = locale.split("-")[0] === language.split("-")[0] ? locale : language;
        const res = await grokTranscribe(audio, variety, dialectKeyterms(variety, variety === locale ? learned : {}));
        return [language, { text: res.text, speech: speechStats(res.words) }] as const;
      }),
    );
    return NextResponse.json({ transcripts: Object.fromEntries(results), model: "grok-voice-transcribe-2.0" });
  } catch (err) {
    console.error("grok voice stt failed", err);
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
