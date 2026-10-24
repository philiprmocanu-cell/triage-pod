import { NextResponse } from "next/server";
import { agentsSnapshot, postBriefing } from "@/lib/agents";
import { act, snapshot } from "@/lib/network";
import { coordinatorBriefing } from "@/lib/triage/brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const network = await snapshot(); // advances the network and lets every agent act
  return NextResponse.json({ ...agentsSnapshot(), kpis: network.kpis, posts: network.posts.map((p) => ({ id: p.id, name: p.name, status: p.status, outbreak: p.outbreak })) });
}

// Demo controls and the coordinator's plain-language briefing.
export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; post?: string; kind?: "malaria" | "diarrhea" | "respiratory" };
  if (body.action === "briefing") {
    const network = await snapshot();
    const agents = agentsSnapshot();
    try {
      postBriefing(await coordinatorBriefing({ kpis: network.kpis, alerts: network.alerts.map((a) => a.text), shortages: network.shortages.slice(0, 6).map((x) => `${x.label} at ${x.postName}`), recent: agents.bus.slice(0, 25).map((m) => `${m.from} → ${m.to}: ${m.text}`), queue: agents.queue.slice(0, 5).map((q) => `${q.urgency} ${q.summary} (${q.doctor})`) }));
    } catch (err) {
      postBriefing(`Briefing unavailable: ${err instanceof Error ? err.message : err}`);
    }
  } else if (body.action === "outbreak") act({ type: "outbreak", post: body.post, kind: body.kind });
  else if (body.action === "approve_all") act({ type: "approve_all" });
  else if (body.action === "reset") {
    act({ type: "reset" });
    (globalThis as unknown as { __agents?: unknown }).__agents = undefined;
  }
  await snapshot();
  return NextResponse.json({ ok: true });
}
