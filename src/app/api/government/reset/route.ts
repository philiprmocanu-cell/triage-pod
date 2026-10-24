import { NextResponse } from "next/server";

export const runtime = "nodejs";

// The presenter's "reset everything" button: put the live network (SpacetimeDB) back to its seed
// from the server side, so the browser never has to talk to the database directly.
const URL_BASE = process.env.SPACETIME_HTTP ?? "http://127.0.0.1:3000";
const DB = process.env.SPACETIME_DB ?? "podnet";

export async function POST() {
  try {
    const res = await fetch(`${URL_BASE}/v1/database/${DB}/call/reset_demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return NextResponse.json({ error: `SpacetimeDB reset_demo ${res.status}: ${await res.text()}` }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "SpacetimeDB unreachable" }, { status: 502 });
  }
}
