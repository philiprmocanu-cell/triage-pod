import { NextResponse } from "next/server";
import { COUNTRIES, liveStats } from "@/lib/countries";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { data, fetchedAt, live } = await liveStats();
    return NextResponse.json({
      countries: COUNTRIES.map((c) => ({ ...c, stats: data[c.iso3] ?? {} })),
      source: live ? "World Bank Open Data (api.worldbank.org), most recent year per indicator" : `World Bank Open Data, last fetched ${fetchedAt.slice(0, 10)} (the API is unreachable right now)`,
    });
  } catch (err) {
    // No live data and nothing saved: still list the countries, so the page is not empty.
    return NextResponse.json({
      countries: COUNTRIES.map((c) => ({ ...c, stats: {} })),
      source: "World Bank unreachable and no saved copy yet; statistics will fill in when it answers",
      error: err instanceof Error ? err.message : "Could not reach the World Bank",
    });
  }
}
