import { NextResponse } from "next/server";
import { loadWorld } from "@/lib/routes/planner";
import { warmRoutes } from "@/lib/routes/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Fill data/routes.json: POST {} fetches the road from the Chipata hub to every post (39 pairs,
// one OSRM request at a time); POST { pairs: "all" } adds every post-to-post pair (741 more,
// several minutes on the public server; post-to-post legs are otherwise fetched when first used).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { pairs?: "hub" | "all" };
  const { villages } = await loadWorld();
  return NextResponse.json(await warmRoutes(villages, body.pairs === "all" ? "all" : "hub"));
}
