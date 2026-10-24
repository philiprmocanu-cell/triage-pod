import { NextResponse } from "next/server";
import { cartesia, clonedVoice, forgetClonedVoice, registerClonedVoice, voiceKey } from "@/lib/cartesia";

export const runtime = "nodejs";

// Clone a consenting local speaker from a short clip so the pod speaks with that region's accent:
// the post's health worker ("teach accent"), or a patient who said yes to "may the pod learn your
// way of speaking" at the end of a visit. With a `community`, the voice is used for that village.
export async function POST(req: Request) {
  const form = await req.formData();
  const clip = form.get("clip");
  const locale = String(form.get("locale") ?? "es-MX");
  const name = String(form.get("name") ?? "Health worker");
  const community = form.get("community") ? String(form.get("community")) : undefined;
  if (!(clip instanceof File)) return NextResponse.json({ error: "No clip" }, { status: 400 });

  try {
    const voice = await cartesia().voices.clone({ clip, language: locale.split("-")[0], name: `${name} (${locale})` });
    await registerClonedVoice(voiceKey(locale, community), voice.id, voice.name);
    return NextResponse.json({ id: voice.id, name: voice.name, locale, community: community ?? null });
  } catch (err) {
    console.error("clone failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Clone failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const locale = new URL(req.url).searchParams.get("locale") ?? "es-MX";
  return NextResponse.json({ voice: await clonedVoice(locale) });
}

// Go back to the catalog voice for this region.
export async function DELETE(req: Request) {
  const locale = new URL(req.url).searchParams.get("locale") ?? "es-MX";
  await forgetClonedVoice(locale);
  return NextResponse.json({ ok: true });
}
