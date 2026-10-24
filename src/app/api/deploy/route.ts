import { NextResponse } from "next/server";
import { COUNTRIES, liveStats } from "@/lib/countries";

export const runtime = "nodejs";

export async function GET() {
  try {
    const stats = await liveStats();
    return NextResponse.json({ countries: COUNTRIES.map((c) => ({ ...c, stats: stats[c.iso3] ?? {} })), source: "World Bank Open Data (api.worldbank.org), most recent year per indicator" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not reach the World Bank" }, { status: 502 });
  }
}
