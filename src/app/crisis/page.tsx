"use client";

import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";
import { GROUND } from "@/lib/map/pin";

// Crisis drill: mission control for "the rainy-season week from hell". One button starts the
// situation inside SpacetimeDB (start_crisis) and runs the real dispatch planner and route planner
// over it (POST /api/crisis/run); this page shows what happens. Every number here is read from the
// live tables through the page's own subscriptions (orders, plans, carriers, stock, visits, blocks)
// or from the orchestrator's measured totals (GET /api/crisis/status); nothing is drawn that is not
// in a table. The globe draws every planned road (a multi-stop run once), the blocked legs in red,
// the roads that went around them in green, and lights each post by the worst visit open there.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";

type Ts = { microsSinceUnixEpoch: bigint };
type Village = { id: number; name: string; lat: number; lng: number; hub: boolean; population: number };
type Carrier = { id: number; name: string; kind: string; operator: string; baseVillageId: number; status: string };
type Plan = { id: bigint; orderId: bigint; carrierId: number; waypoints: string; km: number; minutes: number; floodRisk: string; status: string; reason: string };
type Order = { id: bigint; kind: string; patientName: string; toVillageId: number; fromVillageId: number; item: string; qty: number; status: string; travelSeconds: number; createdAt: Ts; departedAt?: Ts };
type Visit = { villageId: number; urgency: string; summary: string; createdAt: Ts };
type Stock = { villageId: number; item: string; qty: number };
type Block = { id: bigint; legFromVillageId: number; legToVillageId: number; risk: string; reason: string };
type Crisis = { level: number; status: string; startedAt: Ts; postsHit: number; redVisits: number; yellowVisits: number; stockOuts: number; blocks: number; carriersDown: number; note: string };
type Step = { n: number; title: string; detail: string; startedAt: string; ms: number | null; status: "running" | "done" | "failed" };
type Totals = {
  trips: number; runs: number; kmTotal: number; minutesTotal: number; naiveTrips: number; naiveKm: number; naiveMinutes: number; kmSaved: number; minutesSaved: number;
  carriersUsed: number; carriersByKind: Record<string, number>; legsRerouted: number; tripsRerouted: number; recheck: { checked: number; rerouted: number; changed: number };
  unreachable: { post: string; why: string; instead: string; orders: number }[]; lent: { lender: string; qty: number; items: { item: string; qty: number; to: string }[] }[];
  found: { leg: string; risk: string; reason: string; outcomes: string[] }[]; notes: string[]; shipments: number; shipmentsByTier: Record<string, number>; items: number; kg: number; postsInNeed: number; totalMs: number;
};
type Run = { level: number; startedAt: string; finishedAt: string | null; running: boolean; steps: Step[]; totals: Totals | null; error: string | null };
type BlockLeg = { id: number; from: string; to: string; risk: string; reason: string; until: string; km: number; points: [number, number][] };
type Status = { running: boolean; run: Run | null; blocks: BlockLeg[]; carriers: { down: number; out: number; idle: number } };
type Marker =
  | { kind: "village"; id: number; lat: number; lng: number; name: string; hub: boolean; tone: "red" | "yellow" | "active" | "quiet" }
  | { kind: "carrier"; id: number; lat: number; lng: number; name: string; ckind: string };
type PathRow = { id: string; points: [number, number][]; color: string; stroke: number; dash: number; gap: number; anim: number; status: string };

const KIND_COLOR: Record<string, string> = { truck: "#f59e0b", pickup: "#fb923c", motorbike: "#38bdf8", bicycle: "#34d399", boat: "#22d3ee", drone: "#a78bfa" };
const GREEN = "#22c55e", RED = "#ef4444";
const GROUND_ALT = GROUND;
const RUN_RE = /run ([A-Z0-9]+) stop (\d+) of (\d+) \(([^)]+)\)/;
const short = (name: string) => name.replace(/ \(.*\)$/, "");
const us = (t?: Ts | null) => (t ? Number(t.microsSinceUnixEpoch) : 0);
const isRerouted = (p: Plan) => p.status === "rerouted" || /^rerouted/i.test(p.reason);
const hhmm = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m)} min`);
const fmt = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
const secs = (ms: number | null) => (ms === null ? "…" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

export default function CrisisPage() {
  const el = useRef<HTMLDivElement>(null);
  const globeRef = useRef<import("globe.gl").GlobeInstance | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const [connected, setConnected] = useState<"connecting" | "live" | "offline">("connecting");
  const [villages, setVillages] = useState<Village[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stock, setStock] = useState<Stock[]>([]);
  const [blocksT, setBlocksT] = useState<Block[]>([]);
  const [crisis, setCrisis] = useState<Crisis | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [level, setLevel] = useState(3);
  const [busy, setBusy] = useState<"start" | "clear" | null>(null);
  const [note, setNote] = useState("");
  const [tick, setTick] = useState(0);
  const markerPool = useRef(new Map<string, Marker>());
  const drawState = useRef<{ villages: Village[]; carriers: Carrier[]; plans: Plan[]; orders: Order[]; visits: Visit[]; crisis: Crisis | null; blocks: BlockLeg[] }>({ villages: [], carriers: [], plans: [], orders: [], visits: [], crisis: null, blocks: [] });

  // ---- SpacetimeDB ----
  useEffect(() => {
    const sync = (conn: DbConnection) => {
      setVillages([...conn.db.village.iter()] as Village[]);
      setCarriers(([...conn.db.carrier.iter()] as Carrier[]).sort((a, b) => a.id - b.id));
      setPlans([...conn.db.routePlan.iter()] as Plan[]);
      setOrders([...conn.db.deliveryOrder.iter()] as Order[]);
      setVisits([...conn.db.visit.iter()] as Visit[]);
      setStock([...conn.db.stock.iter()] as Stock[]);
      setBlocksT([...conn.db.roadBlock.iter()] as Block[]);
      setCrisis(([...conn.db.crisis.iter()] as Crisis[])[0] ?? null);
    };
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setConnected("live");
        c.subscriptionBuilder()
          .onApplied(() => sync(c))
          .subscribe(["SELECT * FROM village", "SELECT * FROM carrier", "SELECT * FROM route_plan", "SELECT * FROM delivery_order", "SELECT * FROM visit", "SELECT * FROM stock", "SELECT * FROM road_block", "SELECT * FROM crisis"]);
      })
      .onConnectError(() => setConnected("offline"))
      .onDisconnect(() => setConnected("offline"))
      .build();
    connRef.current = conn;
    let pending = 0;
    const later = () => { if (pending) return; pending = window.setTimeout(() => { pending = 0; sync(conn); }, 150); };
    for (const t of [conn.db.village, conn.db.carrier, conn.db.routePlan, conn.db.deliveryOrder, conn.db.visit, conn.db.stock, conn.db.roadBlock, conn.db.crisis]) {
      t.onInsert(later);
      t.onUpdate(later);
      t.onDelete(later);
    }
    return () => conn.disconnect();
  }, []);

  // ---- the orchestrator's progress ----
  const readStatus = () =>
    fetch("/api/crisis/status")
      .then((r) => r.json())
      .then((j: Status) => setStatus(j))
      .catch(() => undefined);
  useEffect(() => {
    readStatus();
    const id = setInterval(readStatus, status?.running || busy ? 1000 : 4000);
    return () => clearInterval(id);
  }, [status?.running, busy]);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000); // the counters that depend on the clock
    return () => clearInterval(id);
  }, []);

  const start = async () => {
    setBusy("start");
    setNote("");
    try {
      const res = await fetch("/api/crisis/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level }) });
      const j = (await res.json()) as Run & { error?: string };
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setNote(`Run finished in ${(j.totals?.totalMs ? j.totals.totalMs / 1000 : 0).toFixed(1)} s.`);
    } catch (e) {
      setNote(`Start failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      readStatus();
    }
  };
  const clear = async () => {
    setBusy("clear");
    setNote("");
    try {
      const res = await fetch("/api/crisis/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: true }) });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setNote("Cleared: roads open, carriers back, undelivered drill orders recalled.");
    } catch (e) {
      setNote(`Clear failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      readStatus();
    }
  };

  // ---- what belongs to this drill (orders and visits from the moment it started) ----
  const since = crisis && crisis.status === "active" ? us(crisis.startedAt) : crisis ? us(crisis.startedAt) : Infinity;
  const vmap = new Map(villages.map((v) => [v.id, v]));
  const hub = villages.find((v) => v.hub);
  const vname = (id: number) => short(vmap.get(id)?.name ?? `#${id}`);
  const mine = orders.filter((o) => us(o.createdAt) >= since);
  const mineIds = new Set(mine.map((o) => String(o.id)));
  const minePlans = plans.filter((p) => mineIds.has(String(p.orderId)));
  const trips = new Map<string, Plan & { orders: number }>();
  for (const p of minePlans) {
    const key = `${p.carrierId}|${p.waypoints}`;
    const t = trips.get(key);
    if (t) t.orders++;
    else trips.set(key, { ...p, orders: 1 });
  }
  const tripList = [...trips.values()];
  const open = mine.filter((o) => o.status !== "delivered").length;
  const delivered = mine.filter((o) => o.status === "delivered").length;
  const moving = mine.filter((o) => o.status === "on_the_way").length;
  const km = Math.round(tripList.reduce((s, t) => s + t.km, 0));
  const rerouted = tripList.filter(isRerouted).length;
  const carriersOut = carriers.filter((c) => c.status === "out").length;
  const carriersDown = carriers.filter((c) => c.status === "down").length;
  const runs = new Set(minePlans.map((p) => RUN_RE.exec(p.reason)).filter((m) => m && Number(m[3]) >= 2).map((m) => m![1])).size;
  const mineVisits = visits.filter((v) => us(v.createdAt) >= since);
  const worstAt = new Map<number, "red" | "yellow">();
  for (const v of mineVisits) if (v.urgency === "red" || (v.urgency === "yellow" && worstAt.get(v.villageId) !== "red")) worstAt.set(v.villageId, v.urgency as "red" | "yellow");
  const postsLit = new Set([...worstAt.keys(), ...mine.filter((o) => o.status !== "delivered").map((o) => o.toVillageId)]).size;

  // Resources: per item, what the hub holds now and where this drill's stock is.
  const hubStock = new Map(stock.filter((s) => hub && s.villageId === hub.id).map((s) => [s.item, s.qty]));
  const items = new Map<string, { hub: number; committed: number; moving: number; delivered: number; lent: number }>();
  for (const o of mine) {
    let r = items.get(o.item);
    if (!r) { r = { hub: hubStock.get(o.item) ?? 0, committed: 0, moving: 0, delivered: 0, lent: 0 }; items.set(o.item, r); }
    if (o.status === "ordered") r.committed += o.qty;
    else if (o.status === "on_the_way") r.moving += o.qty;
    else r.delivered += o.qty;
    if (o.kind === "restock" && hub && o.fromVillageId !== hub.id && o.fromVillageId !== o.toVillageId) r.lent += o.qty;
  }
  const itemRows = [...items].sort((a, b) => b[1].committed + b[1].moving + b[1].delivered - (a[1].committed + a[1].moving + a[1].delivered));
  const lenders = new Map<number, { qty: number; to: Set<number>; items: Set<string> }>();
  for (const o of mine) {
    if (o.kind !== "restock" || !hub || o.fromVillageId === hub.id || o.fromVillageId === o.toVillageId) continue;
    let l = lenders.get(o.fromVillageId);
    if (!l) { l = { qty: 0, to: new Set(), items: new Set() }; lenders.set(o.fromVillageId, l); }
    l.qty += o.qty;
    l.to.add(o.toVillageId);
    l.items.add(o.item);
  }

  drawState.current = { villages, carriers, plans: minePlans, orders, visits: mineVisits, crisis, blocks: status?.blocks ?? [] };

  // ---- the globe ----
  useEffect(() => {
    let disposed = false;
    let raf = 0;
    const fit = () => {
      const r = el.current?.getBoundingClientRect();
      if (r && r.width && r.height) globeRef.current?.width(r.width).height(r.height);
    };
    (async () => {
      const Globe = (await import("globe.gl")).default;
      if (disposed || !el.current) return;
      const g = new Globe(el.current)
        .globeImageUrl("/globe/earth-blue-marble.jpg")
        .globeTileEngineUrl((x: number, y: number, l: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`)
        .bumpImageUrl("/globe/earth-topology.png")
        .backgroundColor("#02050c")
        .showAtmosphere(true)
        .atmosphereColor("#ef4444")
        .atmosphereAltitude(0.12)
        .htmlElementsData([])
        .htmlLat((d: object) => (d as Marker).lat)
        .htmlLng((d: object) => (d as Marker).lng)
        .htmlAltitude(GROUND_ALT)
        .htmlElement((d: object) => markerEl(d as Marker))
        .pathsData([])
        .pathPoints((d: object) => (d as PathRow).points)
        .pathPointLat((p: unknown) => (p as [number, number])[0])
        .pathPointLng((p: unknown) => (p as [number, number])[1])
        .pathPointAlt(GROUND_ALT)
        .pathResolution(1)
        .pathColor((d: object) => (d as PathRow).color)
        .pathStroke((d: object) => (d as PathRow).stroke)
        .pathDashLength((d: object) => (d as PathRow).dash)
        .pathDashGap((d: object) => (d as PathRow).gap)
        .pathDashAnimateTime((d: object) => (d as PathRow).anim)
        .pathTransitionDuration(0);
      g.pointOfView({ lat: -13.3, lng: 32.0, altitude: 0.17 });
      g.controls().autoRotate = false;
      g.controls().zoomSpeed = 1.2;
      globeRef.current = g;
      fit();
      setTimeout(() => { fit(); g.pointOfView({ lat: -13.3, lng: 32.0, altitude: 0.17 }, 600); }, 1200); // once the container has its final size
      let last = 0;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        if (now - last < 150) return;
        last = now;
        const alt = g.pointOfView()?.altitude ?? 1;
        el.current?.classList.toggle("far", alt > 0.14);
        draw();
      };
      loop();
    })();
    const ro = new ResizeObserver(fit);
    if (el.current) ro.observe(el.current);
    window.addEventListener("resize", fit);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", fit);
      globeRef.current?._destructor?.();
    };
  }, []);

  const draw = () => {
    const g = globeRef.current;
    if (!g) return;
    const { villages, carriers, plans, orders, visits, blocks } = drawState.current;
    const vmap = new Map(villages.map((v) => [v.id, v]));
    const omap = new Map(orders.map((o) => [String(o.id), o]));
    const paths: PathRow[] = [];
    const where = new Map<number, { lat: number; lng: number }>();
    const nowUs = BigInt(Date.now()) * BigInt(1000);
    const seen = new Set<string>(); // a run (or any shared road) is drawn once
    for (const p of plans) {
      const key = `${p.carrierId}|${p.waypoints}`;
      let points: [number, number][] = [];
      try { points = JSON.parse(p.waypoints); } catch { continue; }
      if (points.length < 2) continue;
      const c = carriers.find((x) => x.id === p.carrierId);
      const o = omap.get(String(p.orderId));
      if (c && o && o.status === "on_the_way" && o.departedAt && o.travelSeconds > 0 && !where.has(c.id)) {
        const t = Math.min(1, Number(nowUs - o.departedAt.microsSinceUnixEpoch) / 1e6 / o.travelSeconds);
        const [lat, lng] = along(points, t);
        where.set(c.id, { lat, lng });
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const around = isRerouted(p);
      const high = p.floodRisk === "high";
      const color = around ? GREEN : high ? RED : KIND_COLOR[c?.kind ?? ""] ?? "#e2e8f0";
      const done = p.status === "done";
      paths.push({ id: String(p.id), points, color: done ? color + "55" : color, stroke: around ? 0.8 : done ? 0.35 : 0.55, dash: p.status === "moving" ? 0.08 : done ? 0.02 : 1, gap: p.status === "moving" ? 0.04 : done ? 0.02 : 0, anim: p.status === "moving" ? 5000 : 0, status: p.status });
    }
    for (const b of blocks) paths.push({ id: `block:${b.id}`, points: b.points, color: b.risk === "high" ? RED : "#f59e0b", stroke: 1.3, dash: 0.05, gap: 0.03, anim: 2500, status: "block" });
    g.pathsData(paths);
    // Markers keep their identity between frames so nothing flickers.
    const pool = markerPool.current;
    const next: Marker[] = [];
    const keep = (key: string, make: () => Marker, move?: (m: Marker) => void) => {
      let m = pool.get(key);
      if (!m) { m = make(); pool.set(key, m); }
      move?.(m);
      next.push(m);
    };
    const worst = new Map<number, "red" | "yellow">();
    for (const v of visits) if (v.urgency === "red" || (v.urgency === "yellow" && worst.get(v.villageId) !== "red")) worst.set(v.villageId, v.urgency as "red" | "yellow");
    const active = new Set(orders.filter((o) => o.status !== "delivered" && us(o.createdAt) >= since).map((o) => o.toVillageId));
    for (const v of villages) {
      const tone: "red" | "yellow" | "active" | "quiet" = worst.get(v.id) ?? (active.has(v.id) ? "active" : "quiet");
      keep(`v:${v.id}:${tone}`, () => ({ kind: "village", id: v.id, lat: v.lat, lng: v.lng, name: short(v.name), hub: v.hub, tone }));
    }
    for (const c of carriers) {
      const at = where.get(c.id);
      if (!at) continue;
      keep(`c:${c.id}`, () => ({ kind: "carrier", id: c.id, lat: at.lat, lng: at.lng, name: c.name, ckind: c.kind }), (m) => { m.lat = at.lat; m.lng = at.lng; });
    }
    const live = new Set(next);
    for (const [k, m] of pool) if (!live.has(m)) pool.delete(k);
    g.htmlElementsData(next);
  };

  const run = status?.run ?? null;
  const totals = run?.totals ?? null;
  const running = !!status?.running || busy === "start";
  const active = crisis?.status === "active";
  const blocks = status?.blocks ?? [];
  void tick;

  return (
    <div className="fixed bottom-0 left-0 right-0 top-11 overflow-hidden bg-black text-slate-100">
      <style>{CSS}</style>
      <div className="grid h-full w-full grid-cols-[360px_1fr_380px] grid-rows-[auto_1fr] gap-2 p-2 pt-10">
        {/* ---- header row ---- */}
        <div className="hud col-span-3 flex flex-wrap items-center gap-3 px-4 py-2">
          <div className="min-w-[260px]">
            <p className="text-[10px] uppercase tracking-[0.3em] text-red-300">Crisis drill · mission control</p>
            <h1 className="text-lg font-bold leading-tight">The rainy-season week from hell</h1>
            <p className="text-[11px] text-slate-400">{crisis?.note ?? "Nothing started. Level 3 hits 26 of 40 posts, empties 47 shelves, floods 6 roads and takes 3 carriers off the fleet; the planner has to find a way."}</p>
          </div>
          <div className="flex items-center gap-2">
            <select value={level} onChange={(e) => setLevel(Number(e.target.value))} disabled={running || !!busy} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs">
              <option value={1}>Level 1 · Luangwa valley</option>
              <option value={2}>Level 2 · + malaria cluster</option>
              <option value={3}>Level 3 · the whole week</option>
            </select>
            <button onClick={start} disabled={running || !!busy || connected !== "live"} className="rounded-lg border border-red-500 bg-red-700/80 px-4 py-2 text-sm font-semibold text-white shadow-[0_0_24px_rgba(239,68,68,.45)] hover:bg-red-600 disabled:opacity-40">
              {running ? "Running…" : `Start the crisis (level ${level})`}
            </button>
            <button onClick={clear} disabled={running || !!busy || !active} className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-40">
              {busy === "clear" ? "Clearing…" : "Clear"}
            </button>
            <span className={`text-[11px] ${connected === "live" ? "text-emerald-300" : "text-amber-300"}`}>● {connected === "live" ? "SpacetimeDB live" : connected === "connecting" ? "connecting…" : "SpacetimeDB offline"}</span>
            {note && <span className="text-[11px] text-slate-300">{note}</span>}
          </div>
          <div className="ml-auto grid grid-cols-8 gap-1.5 text-center">
            <Kpi label="posts lit" value={postsLit} tone="text-red-300" />
            <Kpi label="requests open" value={open} tone="text-amber-300" />
            <Kpi label="orders" value={mine.length} tone="text-slate-200" />
            <Kpi label="routes drawn" value={tripList.length} tone="text-sky-300" />
            <Kpi label="carriers out" value={carriersOut} sub={carriersDown ? `${carriersDown} down` : undefined} tone="text-orange-300" />
            <Kpi label="km planned" value={km} tone="text-slate-200" />
            <Kpi label="re-routed" value={rerouted} tone="text-emerald-300" />
            <Kpi label="delivered" value={delivered} sub={moving ? `${moving} moving` : undefined} tone="text-emerald-200" />
          </div>
        </div>

        {/* ---- left: the timeline ---- */}
        <div className="hud flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-slate-800 px-4 py-2">
            <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">What the planner is doing</p>
            <p className="text-[11px] text-slate-500">{run ? `Level ${run.level} · started ${new Date(run.startedAt).toLocaleTimeString([], { hour12: false })}${run.finishedAt ? ` · finished in ${run.totals ? (run.totals.totalMs / 1000).toFixed(1) : "?"} s` : " · running"}` : "No run yet"}</p>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs">
            {(run?.steps ?? []).map((s) => (
              <li key={s.n} className="relative mb-2 rounded-lg border border-slate-800/80 bg-slate-950/60 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-slate-100">
                    <span className={`mr-2 inline-block h-2 w-2 rounded-full align-middle ${s.status === "done" ? "bg-emerald-400" : s.status === "failed" ? "bg-red-500" : "bg-amber-400 animate-pulse"}`} />
                    {s.n}. {s.title}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">{secs(s.ms)}</span>
                </div>
                <p className="mt-1 leading-snug text-slate-300">{s.detail}</p>
              </li>
            ))}
            {!run && <li className="px-1 py-2 text-slate-500">Press Start. The module creates the situation in one transaction; the dispatch planner ranks every post; the route planner draws every road and goes around the blocks; the watcher checks it all again; then it is measured against the naive plan.</li>}
            {run?.error && <li className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-red-200">{run.error}</li>}
          </ol>
          {totals && (
            <div className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-300">
              <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">Versus the naive plan</p>
              <p className="mb-1 text-slate-500">Naive: every order its own trip, straight from the hub on the direct road.</p>
              <Bar label="km" a={totals.kmTotal} b={totals.naiveKm} fmtA={`${fmt(totals.kmTotal)} km`} fmtB={`${fmt(totals.naiveKm)} km`} />
              <Bar label="trips" a={totals.trips} b={totals.naiveTrips} fmtA={`${totals.trips}`} fmtB={`${totals.naiveTrips}`} />
              <Bar label="hours" a={totals.minutesTotal} b={totals.naiveMinutes} fmtA={hhmm(totals.minutesTotal)} fmtB={hhmm(totals.naiveMinutes)} />
              <p className="mt-1 text-emerald-300">{fmt(totals.kmSaved)} km and {hhmm(totals.minutesSaved)} of driving saved; {totals.carriersUsed} carriers used ({Object.entries(totals.carriersByKind).map(([k, n]) => `${n} ${k}`).join(", ")}).</p>
            </div>
          )}
        </div>

        {/* ---- centre: the globe ---- */}
        <div className="relative min-h-0 overflow-hidden rounded-2xl border border-slate-800/70">
          <div ref={el} className="absolute inset-0 far" />
          <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-black/50 px-3 py-1.5 text-[11px] text-slate-300">
            <span><i className="mr-1 inline-block h-2 w-5 rounded-sm align-middle" style={{ background: RED }} />blocked road</span>
            <span><i className="mr-1 inline-block h-2 w-5 rounded-sm align-middle" style={{ background: GREEN }} />went around it</span>
            {Object.entries(KIND_COLOR).filter(([k]) => k !== "drone").map(([k, c]) => (
              <span key={k}><i className="mr-1 inline-block h-2 w-5 rounded-sm align-middle" style={{ background: c }} />{k}</span>
            ))}
            <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500 align-middle" />red visit</span>
            <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" />yellow visit</span>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-black/50 px-3 py-1.5 text-[11px] text-slate-300">
            {blocks.length} roads blocked · {runs} multi-stop runs · {tripList.length} roads drawn · {trips.size ? `${rerouted} around a block` : "no routes yet"}{active && crisis ? ` · level ${crisis.level} since ${new Date(us(crisis.startedAt) / 1000).toLocaleTimeString([], { hour12: false })}` : ""}
          </div>
        </div>

        {/* ---- right: resources, how it found a way ---- */}
        <div className="hud flex min-h-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="border-b border-slate-800 px-4 py-2">
              <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">Resources · hub shelf → waiting → moving → arrived</p>
              {itemRows.length ? (
                <table className="mt-1 w-full text-[11px]">
                  <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                    <tr><th className="text-left font-normal">item</th><th className="px-1 text-right font-normal">hub</th><th className="px-1 text-right font-normal">waiting</th><th className="px-1 text-right font-normal">moving</th><th className="px-1 text-right font-normal">arrived</th><th className="pl-1 text-right font-normal">lent</th></tr>
                  </thead>
                  <tbody>
                    {itemRows.slice(0, 14).map(([item, r]) => (
                      <tr key={item} className="border-t border-slate-800/60">
                        <td className="py-0.5 pr-1 text-slate-200">{item}</td>
                        <td className={`px-1 text-right font-mono ${r.hub <= 20 ? "text-red-300" : "text-slate-300"}`}>{r.hub}</td>
                        <td className="px-1 text-right font-mono text-amber-300">{r.committed || ""}</td>
                        <td className="px-1 text-right font-mono text-sky-300">{r.moving || ""}</td>
                        <td className="px-1 text-right font-mono text-emerald-300">{r.delivered || ""}</td>
                        <td className="pl-1 text-right font-mono text-violet-300">{r.lent || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-1 text-[11px] text-slate-500">No drill orders yet.</p>
              )}
              {lenders.size > 0 && (
                <p className="mt-2 text-[11px] text-violet-200">
                  Lent between posts instead of trucked from the hub:{" "}
                  {[...lenders].map(([id, l]) => `${vname(id)} lends ${l.qty} units (${[...l.items].slice(0, 3).join(", ")}${l.items.size > 3 ? "…" : ""}) to ${[...l.to].map(vname).join(", ")}`).join("; ")}.
                </p>
              )}
            </section>
            <section className="border-b border-slate-800 px-4 py-2">
              <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">How it found a way · {blocks.length} blocked legs</p>
              {blocks.length === 0 && <p className="mt-1 text-[11px] text-slate-500">No road is blocked.</p>}
              <ul className="mt-1 space-y-1.5 text-[11px]">
                {blocks.map((b) => {
                  const f = totals?.found.find((x) => x.leg === `${b.from} → ${b.to}`);
                  return (
                    <li key={b.id} className="rounded-md border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                      <p className="font-semibold">
                        <span className={b.risk === "high" ? "text-red-300" : "text-amber-300"}>{b.from} → {b.to}</span>
                        <span className="ml-2 font-normal text-slate-400">{b.km} km · {b.risk === "high" ? "under water" : "passable with care"}</span>
                      </p>
                      <p className="text-slate-400">{b.reason}</p>
                      {f && f.outcomes.length > 0 ? (
                        <ul className="mt-1 list-disc pl-4 text-emerald-200">
                          {f.outcomes.slice(0, 5).map((o, i) => <li key={i}>{o}</li>)}
                        </ul>
                      ) : (
                        <p className="mt-1 text-slate-500">{running ? "planning…" : totals ? "no planned route needed this leg" : "not planned yet"}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {totals && totals.unreachable.length > 0 && (
                <div className="mt-2 text-[11px]">
                  <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">Posts the road could not reach</p>
                  <ul className="mt-1 space-y-1">
                    {totals.unreachable.map((u) => (
                      <li key={u.post} className="text-slate-300"><span className="font-semibold text-red-200">{u.post}</span> · {u.orders} orders · {u.instead}. <span className="text-slate-500">{u.why.replace(/ \(until [^)]*\)/, "")}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            {totals && (
              <section className="px-4 py-2 text-[11px] text-slate-300">
                <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">The plan in numbers</p>
                <p className="mt-1">{totals.shipments} shipments for {totals.postsInNeed} posts ({Object.entries(totals.shipmentsByTier).map(([k, n]) => `${n} ${k.replace("pre-position-seasonal", "seasonal")}`).join(", ")}), {fmt(totals.items)} items, {fmt(totals.kg)} kg; {totals.runs} multi-stop runs and {totals.trips - totals.runs} direct trips; {totals.legsRerouted} legs on an alternative road, {totals.tripsRerouted} trips re-routed; watcher re-checked {totals.recheck.checked} routes, {totals.recheck.rerouted} re-routed again.</p>
                {totals.notes.length > 0 && (
                  <p className="mt-1 text-slate-500">Could not do: {totals.notes.slice(0, 4).join(" ")}{totals.notes.length > 4 ? ` (+${totals.notes.length - 4} more)` : ""}</p>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone = "text-amber-300" }: { label: string; value: number; sub?: string; tone?: string }) {
  return (
    <div className="min-w-[72px] rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-1">
      <div className={`font-mono text-lg font-semibold leading-tight ${tone}`}>{value.toLocaleString()}</div>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}{sub ? <span className="ml-1 normal-case tracking-normal text-slate-400">{sub}</span> : null}</div>
    </div>
  );
}

function Bar({ label, a, b, fmtA, fmtB }: { label: string; a: number; b: number; fmtA: string; fmtB: string }) {
  const max = Math.max(a, b, 1);
  return (
    <div className="mb-1">
      <div className="flex justify-between text-[10px] text-slate-400"><span>{label}</span><span>planned {fmtA} · naive {fmtB}</span></div>
      <div className="h-1.5 w-full rounded bg-slate-800"><div className="h-1.5 rounded bg-emerald-400" style={{ width: `${(100 * a) / max}%` }} /></div>
      <div className="mt-0.5 h-1.5 w-full rounded bg-slate-800"><div className="h-1.5 rounded bg-slate-500" style={{ width: `${(100 * b) / max}%` }} /></div>
    </div>
  );
}

// A point a fraction t of the way along a polyline (by straight segment length).
function along(points: [number, number][], t: number): [number, number] {
  if (t <= 0) return points[0];
  if (t >= 1) return points[points.length - 1];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], (points[i][1] - points[i - 1][1]) * Math.cos((points[i][0] * Math.PI) / 180));
    seg.push(d);
    total += d;
  }
  let want = t * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i]) {
      const f = seg[i] ? want / seg[i] : 0;
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f];
    }
    want -= seg[i];
  }
  return points[points.length - 1];
}

function markerEl(m: Marker) {
  const d = document.createElement("div");
  if (m.kind === "village") {
    d.className = `vil ${m.hub ? "hub" : ""} ${m.tone}`;
    d.innerHTML = `<i></i><b>${m.name}</b>`;
    d.title = m.name;
    return d;
  }
  d.className = `car ${m.ckind}`;
  const icon = { truck: "T", pickup: "P", motorbike: "M", bicycle: "B", boat: "W", drone: "D" }[m.ckind] ?? "?";
  d.innerHTML = `<i style="background:${KIND_COLOR[m.ckind] ?? "#e2e8f0"}">${icon}</i>`;
  d.title = m.name;
  return d;
}

const CSS = `
.hud { background: linear-gradient(180deg, rgba(6,11,20,.94), rgba(6,11,20,.86)); border: 1px solid rgba(239,68,68,.16); border-radius: 14px; backdrop-filter: blur(8px); }
.vil { position: relative; transform: translate(-50%, -50%); pointer-events: none; }
.vil i { display: block; width: 6px; height: 6px; border-radius: 50%; background: #64748b; box-shadow: 0 0 0 2px rgba(2,6,23,.8); }
.vil.hub i { width: 13px; height: 13px; background: #34d399; box-shadow: 0 0 0 3px rgba(2,6,23,.85), 0 0 0 5px rgba(52,211,153,.55), 0 0 16px rgba(52,211,153,.8); }
.vil.active i { background: #fde68a; box-shadow: 0 0 0 2px rgba(2,6,23,.85), 0 0 8px rgba(253,230,138,.7); }
.vil.yellow i { width: 9px; height: 9px; background: #fbbf24; box-shadow: 0 0 0 2px rgba(2,6,23,.85), 0 0 0 4px rgba(251,191,36,.4), 0 0 14px rgba(251,191,36,.9); animation: pulse 1.6s ease-in-out infinite; }
.vil.red i { width: 11px; height: 11px; background: #ef4444; box-shadow: 0 0 0 2px rgba(2,6,23,.85), 0 0 0 5px rgba(239,68,68,.45), 0 0 18px rgba(239,68,68,1); animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.35); } }
.vil b { position: absolute; left: 11px; top: -3px; font: 500 10px/1 var(--font-space-grotesk), sans-serif; color: #e2e8f0; white-space: nowrap; text-shadow: 0 1px 2px #000; }
.far .vil:not(.hub):not(.red) b { display: none; }
.car { position: relative; transform: translate(-50%, -50%); pointer-events: none; }
.car i { display: grid; place-items: center; width: 14px; height: 14px; border-radius: 4px; color: #0b1220; font: 700 9px/1 var(--font-geist-mono), monospace; box-shadow: 0 0 0 1.5px rgba(2,6,23,.9); font-style: normal; }
`;
