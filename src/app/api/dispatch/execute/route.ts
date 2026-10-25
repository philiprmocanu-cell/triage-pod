import { NextResponse } from "next/server";
import { planDispatch, type Shipment } from "@/lib/dispatch/plan";
import { callReducer, loadState, sql } from "@/lib/dispatch/state";
import { appendExecution, appendLog, type Execution } from "@/lib/dispatch/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Turns chosen shipments into delivery orders on the live network.
//   body: { shipmentIds: string[] } or { which: "urgent" | "all" }
// Ids are `${priority}-${villageId}`, so the plan is recomputed here from the live tables and
// the chosen shipments are placed as they stand now.
//
// How an order is placed: the module's `restock(toVillageId, item, qty, reason)` reducer when
// it exists; otherwise through `report_visit` with patientName "<village> health post
// pre-position" (the only reducer today that creates an order for an arbitrary item), which
// also adds a green visit row for the post. Then /api/routes/plan is asked for a route for each
// new order when that route exists, and one line per shipment goes to `agent_log` through
// `log_agent` (or to data/dispatch.json until that reducer exists).

const short = (name: string) => name.replace(/ \(.*\)$/, "");

async function reducerExists(name: string) {
  // A call with no body: a missing reducer is 404; an existing one complains about the arguments.
  try {
    const base = process.env.SPACETIME_HTTP ?? "http://127.0.0.1:3000";
    const db = process.env.SPACETIME_DB ?? "podnet";
    const res = await fetch(`${base}/v1/database/${db}/call/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]", signal: AbortSignal.timeout(3000) });
    return res.status !== 404;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  const body = (await req.json().catch(() => ({}))) as { shipmentIds?: string[]; which?: "urgent" | "all" };
  try {
    const state = await loadState(origin);
    const plan = planDispatch(state);
    const wanted = new Set(body.shipmentIds ?? []);
    const chosen: Shipment[] = plan.shipments.filter((s) => (body.which === "all" ? true : body.which === "urgent" ? s.priority === "emergency" || s.priority === "urgent" : wanted.has(s.id)));
    if (!chosen.length) return NextResponse.json({ error: "No shipment matched. Plan again and pick from the current plan.", executed: 0 }, { status: 400 });

    const villageName = (id: number) => state.posts.find((p) => p.id === id)?.name ?? `#${id}`;
    const hubId = state.posts.find((x) => x.hub)?.id ?? 1;
    const notes: string[] = [];
    const hasRestock = await reducerExists("restock");
    const hasLogAgent = await reducerExists("log_agent");
    if (!hasRestock) notes.push("No `restock` reducer in the module: orders placed through report_visit as '<village> health post pre-position' (adds a green visit row per shipment).");
    if (!hasLogAgent) notes.push("No `log_agent` reducer in the module: the planner's lines are kept in data/dispatch.json and shown from there.");

    const before = Math.max(0, ...(await sql("SELECT id FROM delivery_order")).map((r) => Number(r.id)));
    const placed: { shipment: Shipment; ok: boolean; error?: string }[] = [];
    for (const s of chosen) {
      const name = villageName(s.toVillageId);
      const reason = `${s.priority}: ${s.why[0]}`;
      try {
        if (hasRestock) {
          // restock(toVillageId, fromVillageId, item, qty, reason): the lender the plan chose, else the
          // hub (0 would let the module pick its own nearest idle stock).
          for (const i of s.items) await callReducer("restock", [s.toVillageId, i.fromVillageId ?? (s.fromVillageId !== s.toVillageId ? s.fromVillageId : hubId), i.item, i.qty, `${reason}; ${i.why}`]);
        } else {
          await callReducer("report_visit", [name, `${short(name)} health post pre-position`, "green", `Dispatch planner, ${s.priority}: ${s.why[0]}`, s.items.map((i) => ({ item: i.item, qty: i.qty }))]);
        }
        placed.push({ shipment: s, ok: true });
      } catch (err) {
        placed.push({ shipment: s, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // The orders that appeared.
    const after = await sql(`SELECT * FROM delivery_order WHERE id > ${before}`);
    const orders: Execution["orders"] = after.map((o) => ({ id: Number(o.id), toVillageId: Number(o.to_village_id), item: String(o.item), qty: Number(o.qty), mode: String(o.mode), via: hasRestock ? "restock" : "report_visit" }));
    for (const p of placed.filter((x) => x.ok)) {
      const landed = orders.filter((o) => o.toVillageId === p.shipment.toVillageId);
      if (!landed.length) notes.push(`${p.shipment.toVillage}: the reducer accepted the call but no order appeared (the village name may have matched another post).`);
      else if (p.shipment.fromVillageId !== state.posts.find((x) => x.hub)?.id && !hasRestock) notes.push(`${p.shipment.toVillage}: the plan wanted ${p.shipment.fromVillage}'s idle stock; report_visit picks its own source.`);
    }

    // A route for each new order. Orders whose shipments ride one batched run (two or more posts)
    // are planned together as a multi-stop run: one road from the base through every stop, the run
    // id in each route_plan's reason ("run A stop 2 of 4"). The rest are planned one by one.
    let routed = 0;
    let routesExist = true;
    const runs: { id: string; carrierId: number | null; orderIds: number[]; posts: Set<number> }[] = [];
    const singles: typeof orders = [];
    for (const o of orders) {
      const s = chosen.find((x) => x.toVillageId === o.toVillageId && x.run);
      if (!s?.run) { singles.push(o); continue; }
      let r = runs.find((x) => x.id === s.run);
      if (!r) { r = { id: s.run, carrierId: s.carrierId, orderIds: [], posts: new Set() }; runs.push(r); }
      r.orderIds.push(o.id);
      r.posts.add(o.toVillageId);
    }
    const planned: { run: string; stops: number; orders: number; km: number; carrier: string; floodRisk: string }[] = [];
    for (const r of runs) {
      if (!routesExist) break;
      if (r.posts.size < 2) { singles.push(...orders.filter((o) => r.orderIds.includes(o.id))); continue; }
      try {
        const res = await fetch(`${origin}/api/routes/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: { id: r.id, orderIds: r.orderIds, carrierId: r.carrierId ?? undefined } }), signal: AbortSignal.timeout(120_000) });
        if (res.status === 404) { routesExist = false; notes.push("No /api/routes/plan yet: orders are placed without a route plan."); break; }
        const j = (await res.json()) as { error?: string; stops?: unknown[]; km?: number; carrier?: { name: string }; floodRisk?: string };
        if (!res.ok) { notes.push(`/api/routes/plan ${res.status} for ${r.id}: ${j.error ?? ""}`); singles.push(...orders.filter((o) => r.orderIds.includes(o.id))); continue; }
        routed += r.orderIds.length;
        planned.push({ run: r.id, stops: j.stops?.length ?? r.posts.size, orders: r.orderIds.length, km: j.km ?? 0, carrier: j.carrier?.name ?? "", floodRisk: j.floodRisk ?? "" });
      } catch (err) {
        notes.push(`/api/routes/plan failed for ${r.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const o of singles) {
      if (!routesExist) break;
      try {
        const res = await fetch(`${origin}/api/routes/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: o.id }), signal: AbortSignal.timeout(30_000) });
        if (res.status === 404) {
          routesExist = false;
          notes.push("No /api/routes/plan yet: orders are placed without a route plan.");
        } else if (res.ok) routed++;
        else notes.push(`/api/routes/plan ${res.status} for order ${o.id}.`);
      } catch (err) {
        notes.push(`/api/routes/plan failed for order ${o.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const p of planned) notes.push(`${p.run.replace("run-", "Run ")}: one road through ${p.stops} posts for ${p.orders} orders, ${p.km} km by ${p.carrier}, flood risk ${p.floodRisk}; drawn once on the Routes page with numbered stops.`);

    // One log line per shipment, written where it can be.
    const lines = placed.map((p) => {
      const s = p.shipment;
      const text = p.ok
        ? `${s.toVillage}: ${s.priority.toUpperCase()} — ${s.items.map((i) => `${i.qty} ${i.item}`).join(", ")} by ${s.carrierName} from ${s.fromVillage}, send by ${s.sendBy}${s.etaMinutes ? `, ~${s.etaMinutes} min` : ""}. Why: ${s.why.slice(0, 2).join("; ")}.`
        : `${s.toVillage}: could not place the ${s.priority} shipment (${p.error}).`;
      return { villageId: s.toVillageId, village: s.toVillage, text };
    });
    let logged: "agent_log" | "file" = "file";
    if (hasLogAgent) {
      try {
        for (const l of lines) await callReducer("log_agent", ["Dispatch planner", villageName(l.villageId), l.text]);
        logged = "agent_log";
      } catch (err) {
        notes.push(`log_agent failed (${err instanceof Error ? err.message : err}); lines kept in data/dispatch.json.`);
      }
    }
    const at = new Date().toISOString();
    await appendLog(lines.map((l) => ({ at, villageId: l.villageId, village: l.village, text: l.text, where: logged }))).catch(() => {});

    const execution: Execution = { at, shipmentIds: chosen.map((s) => s.id), orders, routed, notes, runs: planned };
    await appendExecution(execution).catch(() => {});
    return NextResponse.json({ executed: placed.filter((p) => p.ok).length, failed: placed.filter((p) => !p.ok).map((p) => ({ id: p.shipment.id, error: p.error })), orders, routed, logged, notes });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Execute failed" }, { status: 500 });
  }
}
