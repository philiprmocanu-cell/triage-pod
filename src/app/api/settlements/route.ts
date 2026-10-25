import { NextResponse } from "next/server";
import { load } from "@/lib/settlements";

export const runtime = "nodejs";

// Every settlement in Eastern Province (OpenStreetMap + GeoNames, see tools/settlements/fetch.py),
// as the globe draws them: { count, sources, fetched, points: [{n, la, ln, p, k}] }. The file is
// generated and committed, so this just serves it with long cache headers; Next compresses it.

export async function GET() {
  try {
    const file = await load();
    return NextResponse.json(
      { count: file.points.length, sources: file.sources, fetched: file.fetched, points: file.points },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
    );
  } catch (e) {
    return NextResponse.json({ count: 0, sources: {}, points: [], error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
