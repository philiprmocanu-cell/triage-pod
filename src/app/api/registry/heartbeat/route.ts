import { NextResponse } from "next/server";
import { podHeartbeat, type PodStatus } from "@/lib/spacetime";

export const runtime = "nodejs";

const STATUSES = new Set<PodStatus>(["idle", "listening", "thinking", "speaking", "offline"]);

// The pod screen tells the network it is here and what it is doing: every few seconds, and on
// every change. Body: { village, status, step?, language? }. The map and the government view
// show the pod as online with that step; it goes offline 20 s after the last beat.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { village?: string; status?: string; step?: string; language?: string };
  const status = (STATUSES.has(body.status as PodStatus) ? body.status : "idle") as PodStatus;
  try {
    await podHeartbeat({ village: body.village || "Katete", status, step: body.step ?? "", language: body.language ?? "" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
