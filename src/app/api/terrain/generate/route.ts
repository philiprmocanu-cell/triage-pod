import { NextResponse } from "next/server";
import { generateFor, generationInProgress, readMeta } from "@/lib/terrain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 660;

// Runs the Python terrain tool for one post (tools/terrain, 10-minute cap, output appended to
// data/terrain.log) and answers when it has finished with the post's new summary.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("village");
  const villageId = raw ? Number(raw) : NaN;
  if (!Number.isInteger(villageId) || villageId <= 0) {
    return NextResponse.json({ error: "Pass ?village=<post id>, for example ?village=29 for Jumbe." }, { status: 400 });
  }
  const busy = generationInProgress();
  if (busy && busy.villageId !== villageId) {
    return NextResponse.json({ error: `Already generating for post #${busy.villageId}. One at a time.`, generating: busy }, { status: 409 });
  }
  const result = await generateFor(villageId);
  const meta = await readMeta();
  const summary = meta.posts[String(villageId)] ?? null;
  const tail = result.output.split("\n").filter(Boolean).slice(-40).join("\n");
  if (!result.ok) {
    return NextResponse.json({ ok: false, villageId, error: result.error, seconds: result.seconds, log: tail, summary }, { status: 500 });
  }
  return NextResponse.json({ ok: true, villageId, seconds: result.seconds, summary, log: tail });
}

export async function GET() {
  return NextResponse.json({ generating: generationInProgress() });
}
