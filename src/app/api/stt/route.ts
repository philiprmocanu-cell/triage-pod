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
        const res = await cartesia().stt.transcribe({ file: audio, model: STT_MODEL, language });
        return [language, res.text.trim()] as const;
      }),
    );
    return NextResponse.json({ transcripts: Object.fromEntries(results) });
  } catch (err) {
    console.error("stt failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Transcription failed" }, { status: 500 });
  }
}
