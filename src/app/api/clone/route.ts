import { NextResponse } from "next/server";
import { cartesia, clonedVoice, forgetClonedVoice, registerClonedVoice, voiceKey } from "@/lib/cartesia";

export const runtime = "nodejs";

// Clone a local speaker from a short clip so the pod speaks with that region's accent:
// the post's health worker ("teach accent"), or a patient during their visit. With a `community`,
// the voice is used for that village.
//
// Two ways to call it:
//  - clip + persist=0 : clone now, for THIS visit only. Nothing is written down; the caller
//    keeps the id and the pod's very next sentence can use it. Delete it (DELETE ?voice=id) if the
//    patient never says yes.
//  - clip (default)   : clone and keep it for every later patient here.
//  - voice=id, no clip: the patient said yes at the end: keep the voice cloned earlier this visit.
export async function POST(req: Request) {
  const form = await req.formData();
  const clip = form.get("clip");
  const locale = String(form.get("locale") ?? "es-MX");
  const name = String(form.get("name") ?? "Health worker");
  const community = form.get("community") ? String(form.get("community")) : undefined;
  const persist = form.get("persist") !== "0";
  const keep = form.get("voice") ? String(form.get("voice")) : null;

  try {
    if (keep && !(clip instanceof File)) {
      // Consent arrived for a voice already learned this visit.
      await registerClonedVoice(voiceKey(locale, community), keep, name);
      return NextResponse.json({ id: keep, name, locale, community: community ?? null, kept: true });
    }
    if (!(clip instanceof File)) return NextResponse.json({ error: "No clip" }, { status: 400 });
    const voice = await cartesia().voices.clone({ clip, language: locale.split("-")[0], name: `${name} (${locale})` });
    if (persist) await registerClonedVoice(voiceKey(locale, community), voice.id, voice.name);
    return NextResponse.json({ id: voice.id, name: voice.name, locale, community: community ?? null, kept: persist });
  } catch (err) {
    console.error("clone failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Clone failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const locale = new URL(req.url).searchParams.get("locale") ?? "es-MX";
  return NextResponse.json({ voice: await clonedVoice(locale) });
}

// Go back to the catalog voice for this region; or, with ?voice=id, throw away a voice learned
// this visit that the patient did not agree to keep.
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const voice = url.searchParams.get("voice");
  if (voice) {
    await cartesia().voices.delete(voice).catch((e) => console.error("voice delete failed", e));
    return NextResponse.json({ ok: true });
  }
  const locale = url.searchParams.get("locale") ?? "es-MX";
  await forgetClonedVoice(locale);
  return NextResponse.json({ ok: true });
}
