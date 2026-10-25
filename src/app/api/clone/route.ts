import { NextResponse } from "next/server";
import { cloneGrokVoice, clonedVoice, forgetClonedVoice } from "@/lib/grokVoice";

export const runtime = "nodejs";

// Learn a consenting local speaker so Grok Voice speaks with that region's accent:
// the post's health worker ("teach accent"), or a patient who said yes at the end of a visit.
// With a community, the voice is used for that village.
export async function POST(req: Request) {
  const form = await req.formData();
  const clip = form.get("clip");
  const locale = String(form.get("locale") ?? "es-MX");
  const name = String(form.get("name") ?? "Health worker");
  const community = form.get("community") ? String(form.get("community")) : undefined;
  if (!(clip instanceof File)) return NextResponse.json({ error: "No clip" }, { status: 400 });

  try {
    const voice = await cloneGrokVoice(clip, { name, locale, community });
    return NextResponse.json({ id: voice.id, name: voice.name, locale, community: community ?? null });
  } catch (err) {
    console.error("grok voice clone failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not learn the voice" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const locale = url.searchParams.get("locale") ?? "es-MX";
  const community = url.searchParams.get("community") ?? undefined;
  return NextResponse.json({ voice: await clonedVoice(locale, community) });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const locale = url.searchParams.get("locale") ?? "es-MX";
  const community = url.searchParams.get("community") ?? undefined;
  await forgetClonedVoice(community ? `${locale}@${community.trim().toLowerCase()}` : locale);
  return NextResponse.json({ ok: true });
}
