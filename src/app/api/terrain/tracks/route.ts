import { NextResponse } from "next/server";
import { generationInProgress, readMeta, readPads, readTracks } from "@/lib/terrain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every proposed off-road track and drone pad the terrain tool has written so far, with the
// per-post summaries (sources, rules, what was dropped). 404 until the tool has run once.
// ?village=<id> keeps only one post's tracks and pads.
export async function GET(req: Request) {
  const tracks = await readTracks();
  if (tracks === null) {
    return new NextResponse("No terrain tracks yet. Run tools/terrain/setup.sh, then POST /api/terrain/generate?village=29 (or press Generate on the Tracks page).", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  const url = new URL(req.url);
  const village = url.searchParams.get("village");
  const vid = village ? Number(village) : null;
  const [pads, meta] = await Promise.all([readPads(), readMeta()]);
  return NextResponse.json({
    tracks: vid === null ? tracks : tracks.filter((t) => t.fromVillageId === vid),
    pads: vid === null ? pads : pads.filter((p) => p.villageId === vid),
    posts: vid === null ? meta.posts : Object.fromEntries(Object.entries(meta.posts).filter(([k]) => Number(k) === vid)),
    sources: meta.sources,
    updatedAt: meta.updatedAt ?? null,
    generating: generationInProgress(),
  });
}
