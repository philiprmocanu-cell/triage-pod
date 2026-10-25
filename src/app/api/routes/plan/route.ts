import { NextResponse } from "next/server";
import { planAllOpen, planOrder, planRun } from "@/lib/routes/planner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { orderId } plans one order; POST { all: true } plans every open order without a plan
// ({ all: true, replan: true } plans them all again, e.g. after a road floods).
// POST { run: { id: "A", orderIds: [12, 13, 14], carrierId?: 2 } } plans several orders as one
// multi-stop run (nearest-neighbour then 2-opt from the base), one route_plan per order sharing
// the run id in `reason` ("run A stop 2 of 4 (…)").
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { orderId?: number | string; all?: boolean; replan?: boolean; run?: { id: string; orderIds: (number | string)[]; carrierId?: number } };
  const origin = new URL(req.url).origin;
  try {
    if (body.all) return NextResponse.json({ results: await planAllOpen(origin, { replan: !!body.replan }) });
    if (body.run) {
      if (!body.run.id || !Array.isArray(body.run.orderIds) || !body.run.orderIds.length) return NextResponse.json({ error: "run needs an id and orderIds" }, { status: 400 });
      return NextResponse.json(await planRun({ id: String(body.run.id), orderIds: body.run.orderIds.map(Number), carrierId: body.run.carrierId ? Number(body.run.carrierId) : undefined }, origin));
    }
    const id = Number(body.orderId);
    if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: "orderId required" }, { status: 400 });
    return NextResponse.json(await planOrder(id, origin));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
