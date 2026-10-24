import { NextResponse } from "next/server";
import { planAllOpen, planOrder } from "@/lib/routes/planner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { orderId } plans one order; POST { all: true } plans every open order without a plan
// ({ all: true, replan: true } plans them all again, e.g. after a road floods).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { orderId?: number | string; all?: boolean; replan?: boolean };
  const origin = new URL(req.url).origin;
  try {
    if (body.all) return NextResponse.json({ results: await planAllOpen(origin, { replan: !!body.replan }) });
    const id = Number(body.orderId);
    if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: "orderId required" }, { status: 400 });
    return NextResponse.json(await planOrder(id, origin));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
