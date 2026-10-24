import { NextResponse } from "next/server";
import { cartesia, registerClonedVoice } from "@/lib/cartesia";

export const runtime = "nodejs";

// Clone a consenting local speaker (e.g. the post's health worker) from a short clip so the pod
// speaks with that region's accent. Never used on patients.
export async function POST(req: Request) {
  const form = await req.formData();
  const clip = form.get("clip");
  const locale = String(form.get("locale") ?? "es-MX");
  const name = String(form.get("name") ?? "Health worker");
  if (!(clip instanceof File)) return NextResponse.json({ error: "No clip" }, { status: 400 });

  try {
    const voice = await cartesia().voices.clone({ clip, language: locale.split("-")[0], name: `${name} (${locale})` });
    registerClonedVoice(locale, voice.id, voice.name);
    return NextResponse.json({ id: voice.id, name: voice.name, locale });
  } catch (err) {
    console.error("clone failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Clone failed" }, { status: 500 });
  }
}
