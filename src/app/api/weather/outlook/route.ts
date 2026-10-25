import { NextResponse } from "next/server";
import { getWeather, outlookFor, TTL_MS } from "@/lib/weather";

export const runtime = "nodejs";

// The government / dispatch summary: for every health post, is it flooded now, will it be in the
// next two weeks, how much rain is coming, the malaria outlook six weeks out, and the day the
// roads may close. Sources and a caveat ride along so the page can print them. See docs/WEATHER.md.

// `?meta=1` answers only the cache's age (for the Routes page's watcher, which re-checks every
// live route when the forecast has been refreshed): { fetchedAt, cacheAgeSec, ttlSec, errors }.
export async function GET(req: Request) {
  try {
    const w = await getWeather();
    const cacheAgeSec = Math.max(0, Math.round((Date.now() - Date.parse(w.fetchedAt)) / 1000));
    if (new URL(req.url).searchParams.get("meta") === "1") return NextResponse.json({ fetchedAt: w.fetchedAt, cacheAgeSec, ttlSec: TTL_MS / 1000, errors: w.errors });
    const posts = w.sites.flatMap((s) => {
      const o = outlookFor(s, w);
      if (!o) return [];
      return [{
        villageId: o.villageId, id: o.id, name: o.name, lat: o.lat, lng: o.lng, hub: o.hub,
        floodRiskToday: o.floodRiskToday, floodRiskTodayReasons: o.floodRiskTodayReasons,
        floodRisk14d: o.floodRisk14d, floodRisk14dReasons: o.floodRisk14dReasons,
        cutOffRisk: o.cutOffRisk, cutOffDays: o.cutOffDays, cutOffDate: o.cutOffDate,
        rainNext14Mm: o.rainNext14Mm, wettestForecastDayMm: o.wettestForecastDayMm, wettestForecastDate: o.wettestForecastDate,
        rain72hMm: o.rain72hMm, rain7Mm: o.rain7Mm, rain30Mm: o.rain30Mm, meanTempC: o.meanTempC,
        malariaOutlook6w: o.malariaOutlook6w, malariaReason: o.malariaReason,
        rainNext14Days: o.rainNext14Days,
        river: o.river, floodNow: o.floodNow,
      }];
    });
    const missing = w.sites.length - posts.length;
    return NextResponse.json({
      posts,
      sources: w.sources,
      preliminary: w.preliminary,
      errors: w.errors,
      note: missing ? `${missing} posts have no forecast cell yet` : undefined,
      fetchedAt: w.fetchedAt,
      cacheAgeSec,
      ttlSec: TTL_MS / 1000,
      cached: true,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), posts: [], sources: [], preliminary: "" }, { status: 502 });
  }
}
