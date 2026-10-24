import { NextResponse } from "next/server";
import { readSightings, removeSightings, sightingsByVillage, sightingsFor } from "@/lib/mosquito/sightings";

export const runtime = "nodejs";

// GET /api/mosquito/sightings?village=Katete&days=7 -> counts for one village (Anopheles vs other)
// GET /api/mosquito/sightings?days=7               -> counts for every village heard from
// GET /api/mosquito/sightings?village=Katete&list=1 -> the clips themselves
// DELETE /api/mosquito/sightings?village=X[&tag=seed] -> remove that village's clips (test seeds)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const village = url.searchParams.get("village")?.trim();
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") ?? 7) || 7));
  if (village && url.searchParams.get("list")) {
    const since = Date.now() - days * 86_400_000;
    const v = village.toLowerCase();
    return NextResponse.json({ village, days, clips: (await readSightings()).filter((s) => s.village.toLowerCase() === v && Date.parse(s.at) >= since) });
  }
  if (village) return NextResponse.json(await sightingsFor(village, days));
  return NextResponse.json({ days, villages: await sightingsByVillage(days) });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const village = url.searchParams.get("village")?.trim();
  if (!village) return NextResponse.json({ error: "village required" }, { status: 400 });
  const removed = await removeSightings(village, url.searchParams.get("tag") ?? undefined);
  return NextResponse.json({ village, removed });
}
