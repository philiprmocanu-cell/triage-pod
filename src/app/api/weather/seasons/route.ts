import { NextResponse } from "next/server";
import { getSeasons, seasonFor, AREA_TO_POINT, CLOSURE_WEEK_MIN_FREQ } from "@/lib/weather/seasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The seasonal calendar per post, from ten years of ERA5 daily rain (Open-Meteo archive, keyless):
//   GET /api/weather/seasons[?refresh=1]
//   → { posts: [{ villageId, name, wetSeasonStart, wetSeasonEnd, closureWeeks[], closureStart,
//                 closureEnd, cutOffDaysByMonth[12], malariaPeak {from,to}, confidence, source, … }],
//       fetchedAt, range, note, errors }
// Dates are placed in the current or coming season (1 July → 30 June). See docs/WEATHER.md.
export async function GET(req: Request) {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    const { store, sites } = await getSeasons({ refresh });
    const posts = sites.flatMap((s) => { const p = seasonFor(s, store); return p ? [p] : []; });
    return NextResponse.json({
      posts,
      fetchedAt: new Date(store.fetchedAt).toISOString(),
      range: store.range,
      cells: Object.keys(store.cells).length,
      areaToPoint: AREA_TO_POINT,
      closureWeekMinFrequency: CLOSURE_WEEK_MIN_FREQ,
      note: `ESTIMATED from ERA5 reanalysis (a ~28 km cell average, scaled ×${AREA_TO_POINT} to stand for one road); a closure week is one where ${Math.round(CLOSURE_WEEK_MIN_FREQ * 10)} of 10 years reached the road-closing mark. The district's own record of which roads closed when should replace these marks.`,
      errors: store.errors ?? null,
      missing: sites.length - posts.length || undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), posts: [] }, { status: 502 });
  }
}
