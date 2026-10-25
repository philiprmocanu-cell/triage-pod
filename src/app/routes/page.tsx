"use client";

import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";
import type { Settlement } from "@/lib/settlements/geo";
import { GROUND, bandOf, restrokePaths, type Band } from "@/lib/map/pin";
import { KIND_COLOR, KIND_WORD, alongPath, routeColor, routeStroke, runOf, type RouteState } from "@/lib/map/routes";
import { RouteLegend } from "@/lib/map/legend";
import { dotTexture, settlementGroups, settlementStyle, type ThreeLite } from "@/lib/map/settlements";

// Where every delivery actually goes: the real carriers (ZAMMSA trucks, district pickups, CHA
// motorbikes, CHW bicycles, Luangwa boats, proposed drones) and the road each planned order
// follows, straight from the `carrier` and `route_plan` tables in SpacetimeDB. Lines follow
// real roads (Google Maps with a key, OpenStreetMap/OSRM without); red where the flood check
// said high. A multi-stop run is drawn once with numbered stops. The map carries no text by
// default: click a road or a carrier for its panel; posts are quiet dots, amber while an order
// is open for them (the same rule as the live map); idle carriers are small dots at their base
// and only a moving carrier gets an icon. Carriers glide along the road on the order's own
// clock (departedAt / travelSeconds, exactly as the live map moves its markers).
//
// Everything on the ground is at altitude 0 (posts, carriers, stops, roads, the village dots):
// a marker lifted above the ground in globe units slides off its village when the view is oblique
// (0.004 was ~90 px at the near zoom). Marker moves are written without a tween, so a carrier is
// where its road says it is on this very frame. Line colours, widths and the legend are shared
// with the live map (src/lib/map).

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";

type Village = { id: number; name: string; lat: number; lng: number; hub: boolean; population: number };
type Carrier = { id: number; name: string; kind: string; operator: string; baseVillageId: number; capacityKg: number; speedKmh: number; costPerKm: number; status: string };
type Plan = { id: bigint; orderId: bigint; carrierId: number; waypoints: string; km: number; minutes: number; floodRisk: string; status: string; reason: string; createdAt: { microsSinceUnixEpoch: bigint } };
type Order = { id: bigint; kind: string; patientName: string; toVillageId: number; fromVillageId: number; item: string; qty: number; status: string; travelSeconds: number; departedAt?: { microsSinceUnixEpoch: bigint } };
type Visit = { villageId: number; fromPod: boolean };
type Marker =
  | { kind: "village"; id: number; lat: number; lng: number; name: string; hub: boolean; active: boolean; picked: boolean }
  | { kind: "carrier"; id: number; lat: number; lng: number; name: string; ckind: string; status: string; moving: boolean; picked: boolean }
  | { kind: "stop"; id: string; lat: number; lng: number; n: number; run: string; name: string };
type PathRow = { id: string; points: [number, number][]; kind: string | undefined; flood: string; status: string; state: RouteState };
type Surface = { pavedKm: number; gravelKm: number; trackKm: number; assumedKm: number; worstSurface: string; totalKm: number; text: string };
type Recheck = { at: string | null; checked: number; rerouted: { orderId: number; from: string; to: string; after: string }[]; changed: unknown[]; errors: string[] };
type Meta = { router: string; googleKey: boolean; cachedPairs: number; surfacedPairs: number; surfaces: Record<string, Surface | null>; lastRecheck: Recheck | null };

const short = (name: string) => name.replace(/ \(.*\)$/, "");
const RECHECK_EVERY_MS = 10 * 60_000; // the watcher re-scores every live route this often while the page is open
const WEATHER_POLL_MS = 60_000; // and as soon as the forecast cache has been refreshed
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const DONE_ROADS_SHOWN = 40;

export default function RoutesPage() {
  const el = useRef<HTMLDivElement>(null);
  const globeRef = useRef<import("globe.gl").GlobeInstance | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const villages = useRef(new Map<number, Village>());
  const activeIds = useRef(new Set<number>()); // posts with an open order or a pod visit (amber)
  const [connected, setConnected] = useState<"connecting" | "live" | "offline">("connecting");
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<"routes" | "carriers">("routes");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [flooded, setFlooded] = useState<string[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [recheck, setRecheck] = useState<Recheck | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [picked, setPicked] = useState<bigint | null>(null); // a road (plan id)
  const pickedRef = useRef<bigint | null>(null);
  const [pickedCarrier, setPickedCarrier] = useState<number | null>(null);
  const pickedCarrierRef = useRef<number | null>(null);
  const settlements = useRef<Settlement[] | null>(null);
  const markerPool = useRef(new Map<string, Marker>());
  const band = useRef<Band>("far");

  const vname = (id: number) => short(villages.current.get(id)?.name ?? `#${id}`);
  const pickRoad = (id: bigint | null) => { pickedRef.current = id; setPicked(id); if (id !== null) { pickedCarrierRef.current = null; setPickedCarrier(null); } };
  const pickCarrier = (id: number | null) => { pickedCarrierRef.current = id; setPickedCarrier(id); if (id !== null) { pickedRef.current = null; setPicked(null); } };

  const readMeta = () =>
    fetch("/api/routes")
      .then((r) => r.json())
      .then((j) => {
        setMeta({ router: j.router, googleKey: !!j.googleKey, cachedPairs: j.cachedPairs, surfacedPairs: j.surfacedPairs ?? 0, surfaces: Object.fromEntries((j.plans ?? []).map((p: { id: number; surface: Surface | null }) => [String(p.id), p.surface])), lastRecheck: j.lastRecheck ?? null });
        if (j.lastRecheck) setRecheck((r) => (r && j.lastRecheck.at && r.at && r.at >= j.lastRecheck.at ? r : j.lastRecheck));
        setFlooded((j.floods ?? []).map((f: { name: string }) => f.name));
      })
      .catch(() => undefined);

  // The route watcher: every live route re-scored against the latest forecast and road surface,
  // every 10 minutes while this page is open and right after the weather cache refreshes.
  const runRecheck = async () => {
    setRechecking(true);
    try {
      const r = await fetch("/api/routes/recheck", { method: "POST" });
      const j = (await r.json()) as Recheck & { error?: string };
      if (r.ok) setRecheck(j);
    } catch {
      // the next tick tries again
    } finally {
      setRechecking(false);
      readMeta();
    }
  };
  useEffect(() => {
    let weatherAt: string | null = null;
    const poll = async () => {
      try {
        const j = (await (await fetch("/api/weather/outlook?meta=1")).json()) as { fetchedAt?: string };
        if (j.fetchedAt && weatherAt && j.fetchedAt !== weatherAt) runRecheck(); // the forecast changed: look at every route again
        if (j.fetchedAt) weatherAt = j.fetchedAt;
      } catch {
        // weather route down: the 10-minute tick still runs
      }
    };
    const t0 = setTimeout(() => { runRecheck(); poll(); }, 4000); // once the tables have loaded
    const every = setInterval(runRecheck, RECHECK_EVERY_MS);
    const weather = setInterval(poll, WEATHER_POLL_MS);
    return () => { clearTimeout(t0); clearInterval(every); clearInterval(weather); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every settlement (23k of them) as a quiet dot on the ground: the same particles layer as the
  // live map, one GPU draw, sized and faded by zoom band.
  const drawSettlements = () => {
    const g = globeRef.current;
    if (!g || !settlements.current) return;
    g.particlesData(settlementGroups(settlements.current));
    const st = settlementStyle(band.current);
    g.particlesSize(st.size);
    g.particlesColor(st.color);
  };
  useEffect(() => {
    fetch("/api/settlements")
      .then((r) => (r.ok ? r.json() : fetch("/settlements/eastern-province.json").then((f) => f.json())))
      .then((j: { points?: Settlement[] }) => {
        settlements.current = (j?.points ?? []).filter((s) => Number.isFinite(s.la) && Number.isFinite(s.ln));
        drawSettlements();
      })
      .catch(() => undefined);
  }, []);

  // ---- the map ----
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const fit = () => {
      const r = el.current?.getBoundingClientRect();
      if (r && r.width && r.height) globeRef.current?.width(r.width).height(r.height);
    };
    (async () => {
      // `three` ships no types here; only CanvasTexture is needed, for the round dot sprite.
      const [{ default: Globe }, THREE] = await Promise.all([import("globe.gl"), import(("three") as string) as Promise<ThreeLite>]);
      if (disposed || !el.current) return;
      const g = new Globe(el.current)
        .globeImageUrl("/globe/earth-blue-marble.jpg")
        .globeTileEngineUrl((x: number, y: number, l: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`)
        .bumpImageUrl("/globe/earth-topology.png")
        .backgroundImageUrl("/globe/night-sky.png")
        .atmosphereColor("#7dd3fc")
        .atmosphereAltitude(0.18)
        .htmlElementsData([])
        .htmlLat((d: object) => (d as Marker).lat)
        .htmlLng((d: object) => (d as Marker).lng)
        .htmlAltitude(GROUND) // on the ground, or it slides off its village when the view is oblique
        .htmlTransitionDuration(0) // a moving carrier is drawn where it is now, not where it was a second ago
        .htmlElement((d: object) => markerEl(d as Marker, pickCarrier))
        .particlesData([])
        .particlesList("list")
        .particleLat("la")
        .particleLng("ln")
        .particleAltitude(GROUND)
        .particlesSize("size")
        .particlesSizeAttenuation(true)
        .particlesColor("rgba(226,232,240,0.5)")
        .particlesTexture(dotTexture(THREE))
        .particleLabel(() => "")
        .pathsData([])
        .pathPoints((d: object) => (d as PathRow).points)
        .pathPointLat((p: unknown) => (p as [number, number])[0])
        .pathPointLng((p: unknown) => (p as [number, number])[1])
        .pathPointAlt(GROUND)
        .pathResolution(1)
        .pathColor((d: object) => routeColor((d as PathRow).kind, (d as PathRow).flood, (d as PathRow).state))
        .pathStroke((d: object) => routeStroke(band.current, (d as PathRow).state)) // pixels; re-stroked when the zoom band changes
        .pathDashLength((d: object) => ((d as PathRow).status === "moving" ? 0.08 : 1))
        .pathDashGap((d: object) => ((d as PathRow).status === "moving" ? 0.05 : 0))
        .pathDashAnimateTime((d: object) => ((d as PathRow).status === "moving" ? 2600 : 0))
        .pathTransitionDuration(0)
        .onPathClick((p: object) => pickRoad(BigInt((p as PathRow).id)));
      // The particle mesh would otherwise catch clicks meant for the roads and carriers near a village.
      g.pointerEventsFilter((o: object) => (o as { __globeObjType?: string }).__globeObjType !== "particles");
      g.pointOfView({ lat: -13.3, lng: 32.2, altitude: 0.26 });
      g.controls().autoRotate = false;
      g.controls().zoomSpeed = 1.2;
      g.onGlobeClick(() => { pickRoad(null); pickCarrier(null); });
      globeRef.current = g;
      (window as unknown as { __globe?: unknown }).__globe = g; // for measuring from the console
      fit();
      drawSettlements();
      // A timer rather than requestAnimationFrame, so the roads and carriers are current the moment
      // a hidden tab is shown again (rAF stops while the page is not visible).
      const refresh = () => {
        const conn = connRef.current;
        if (!conn || disposed) return;
        const alt = g.pointOfView()?.altitude ?? 1;
        el.current?.classList.toggle("far", alt > 0.12);
        const b = bandOf(alt);
        if (b !== band.current) {
          band.current = b;
          drawSettlements();
          restrokePaths(g.pathsData() as PathRow[], (d) => routeStroke(b, d.state));
        }
        draw(conn);
      };
      timer = setInterval(refresh, 120);
    })();
    const ro = new ResizeObserver(fit);
    if (el.current) ro.observe(el.current);
    window.addEventListener("resize", fit);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      ro.disconnect();
      window.removeEventListener("resize", fit);
      globeRef.current?._destructor?.();
    };
  }, []);

  // Paths and markers from the tables, a few times a second (carriers glide along moving plans).
  const draw = (conn: DbConnection) => {
    const g = globeRef.current;
    if (!g) return;
    const plansNow = [...conn.db.routePlan.iter()] as Plan[];
    const ordersNow = new Map(([...conn.db.deliveryOrder.iter()] as Order[]).map((o) => [String(o.id), o]));
    const carriersNow = [...conn.db.carrier.iter()] as Carrier[];
    const p = pickedRef.current, pc = pickedCarrierRef.current;
    const paths: PathRow[] = [];
    const where = new Map<number, { lat: number; lng: number }>(); // carriers on the move
    const nowUs = BigInt(Date.now()) * BigInt(1000); // the same clock as the live map's movers
    // A multi-stop run is drawn once (every order in it carries the same road) with numbered stops.
    const runsDrawn = new Map<string, { planId: bigint; ids: Set<bigint> }>();
    const stopMarkers: Marker[] = [];
    for (const plan of plansNow) {
      const run = runOf(plan.reason);
      if (run) {
        const seen = runsDrawn.get(run.key);
        if (seen) { seen.ids.add(plan.id); continue; }
        runsDrawn.set(run.key, { planId: plan.id, ids: new Set([plan.id]) });
      }
    }
    const runPicked = p !== null ? [...runsDrawn.values()].find((r) => r.ids.has(p)) ?? null : null;
    // Delivered routes stay as dim lines, but only the most recent few dozen (a crisis leaves hundreds).
    let doneShown = 0;
    for (const plan of [...plansNow].sort((a, b) => Number(b.id - a.id))) {
      let points: [number, number][] = [];
      try {
        points = JSON.parse(plan.waypoints);
      } catch {
        continue;
      }
      if (points.length < 2) continue;
      const run = runOf(plan.reason);
      const drawn = run ? runsDrawn.get(run.key) : undefined;
      const c = carriersNow.find((x) => x.id === plan.carrierId);
      const o = ordersNow.get(String(plan.orderId));
      // The carrier's position comes from the order's own departure time and travel time, the
      // formula the live map uses for its movers, so both pages show it in the same place.
      if (c && o && o.status === "on_the_way" && o.departedAt && o.travelSeconds > 0 && !where.has(c.id)) {
        const t = Math.min(1, Number(nowUs - o.departedAt.microsSinceUnixEpoch) / 1e6 / o.travelSeconds);
        const [lat, lng] = alongPath(points, t);
        where.set(c.id, { lat, lng });
      }
      if (run && o && o.status !== "delivered" && plan.status !== "done") { // numbered stops only while the run is open
        const v = villages.current.get(o.toVillageId);
        if (v && !stopMarkers.some((m) => m.kind === "stop" && m.id === `${run.key}#${run.stop}`)) stopMarkers.push({ kind: "stop", id: `${run.key}#${run.stop}`, lat: v.lat, lng: v.lng, n: run.stop, run: run.id, name: short(v.name) });
      }
      if (drawn && drawn.planId !== plan.id) continue; // the run's road is drawn once
      const isPicked = p === plan.id || (runPicked !== null && drawn !== undefined && runPicked.planId === drawn.planId);
      const mine = (p === null && pc === null) || isPicked || (pc !== null && plan.carrierId === pc);
      const done = plan.status === "done" || o?.status === "delivered";
      if (done && !isPicked && ++doneShown > DONE_ROADS_SHOWN) continue;
      // Bright and thick when picked, dashed while moving, dim once delivered or when another route is picked.
      const state: RouteState = isPicked ? "picked" : !mine ? "dim" : done ? "done" : plan.status === "moving" || o?.status === "on_the_way" ? "moving" : "planned";
      paths.push({ id: String(plan.id), points, kind: c?.kind, flood: plan.floodRisk, status: done ? "done" : plan.status, state });
    }
    // Keep the same row object while nothing about a road changed, so globe.gl leaves its line alone.
    const prev = new Map((g.pathsData() as PathRow[]).map((r) => [r.id, r]));
    g.pathsData(paths.map((r) => { const old = prev.get(r.id); return old && old.state === r.state && old.flood === r.flood && old.kind === r.kind && old.status === r.status && old.points.length === r.points.length ? old : r; }));
    // Markers keep their identity between frames (globe.gl only builds the element once per
    // object), so nothing flickers; a marker whose look changes (active, moving, picked) gets a
    // new key and a fresh element. Positions are updated in place.
    const pool = markerPool.current;
    const next: Marker[] = [];
    const keep = (key: string, make: () => Marker, move?: (m: Marker) => void) => {
      let m = pool.get(key);
      if (!m) { m = make(); pool.set(key, m); }
      move?.(m);
      next.push(m);
      return m;
    };
    for (const v of villages.current.values()) {
      const active = activeIds.current.has(v.id);
      keep(`v:${v.id}:${active}`, () => ({ kind: "village", id: v.id, lat: v.lat, lng: v.lng, name: short(v.name), hub: v.hub, active, picked: false }));
    }
    for (const s of stopMarkers) keep(`s:${s.kind === "stop" ? s.id : ""}`, () => s);
    // Idle carriers are a quiet dot at their base (fanned a little so they do not stack); a moving
    // carrier is an icon on its road.
    const perBase = new Map<number, number>();
    for (const c of carriersNow) {
      const moving = where.get(c.id);
      const base = villages.current.get(c.baseVillageId);
      if (!moving && !base) continue;
      const n = perBase.get(c.baseVillageId) ?? 0;
      perBase.set(c.baseVillageId, n + 1);
      const angle = (n / 6) * Math.PI * 2;
      const lat = moving ? moving.lat : base!.lat + Math.sin(angle) * 0.03;
      const lng = moving ? moving.lng : base!.lng + Math.cos(angle) * 0.03;
      const picked = pc === c.id;
      keep(`c:${c.id}:${!!moving}:${picked}:${c.status}`, () => ({ kind: "carrier", id: c.id, lat, lng, name: c.name, ckind: c.kind, status: c.status, moving: !!moving, picked }), (m) => { m.lat = lat; m.lng = lng; });
    }
    const live = new Set(next);
    for (const [k, m] of pool) if (!live.has(m)) pool.delete(k);
    g.htmlElementsData(next);
  };

  // ---- SpacetimeDB ----
  useEffect(() => {
    const sync = (conn: DbConnection) => {
      villages.current = new Map([...conn.db.village.iter()].map((v) => [v.id, v as Village]));
      const ordersNow = [...conn.db.deliveryOrder.iter()] as Order[];
      // A post is "active" (amber) while it has an order open or a pod visit, as on the live map.
      const active = new Set<number>();
      for (const o of ordersNow) if (o.status !== "delivered") active.add(o.toVillageId);
      for (const v of [...conn.db.visit.iter()] as Visit[]) if (v.fromPod) active.add(v.villageId);
      activeIds.current = active;
      setCarriers(([...conn.db.carrier.iter()] as Carrier[]).sort((a, b) => a.id - b.id));
      setPlans(([...conn.db.routePlan.iter()] as Plan[]).sort((a, b) => Number(b.id - a.id)));
      setOrders(ordersNow);
    };
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setConnected("live");
        c.subscriptionBuilder()
          .onApplied(() => sync(c))
          .subscribe(["SELECT * FROM village", "SELECT * FROM carrier", "SELECT * FROM route_plan", "SELECT * FROM delivery_order", "SELECT * FROM visit"]);
      })
      .onConnectError(() => setConnected("offline"))
      .onDisconnect(() => setConnected("offline"))
      .build();
    connRef.current = conn;
    for (const t of [conn.db.village, conn.db.carrier, conn.db.routePlan, conn.db.deliveryOrder, conn.db.visit]) {
      t.onInsert(() => sync(conn));
      t.onUpdate(() => sync(conn));
      t.onDelete(() => sync(conn));
    }
    readMeta();
    return () => conn.disconnect();
  }, []);
  // New plans need their surface line from the server.
  useEffect(() => {
    if (plans.length) readMeta();
  }, [plans.length]);

  const post = async (label: string, url: string, body: unknown) => {
    setBusy(label);
    setNote("");
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      return j;
    } catch (e) {
      setNote(`${label} failed: ${(e as Error).message}`);
      return null;
    } finally {
      setBusy(null);
      readMeta();
    }
  };

  const planAll = async () => {
    const j = (await post("Plan routes", "/api/routes/plan", { all: true })) as { results: ({ error?: string; status?: string })[] } | null;
    if (j) {
      const ok = j.results.filter((r) => !r.error);
      setNote(ok.length ? `Planned ${ok.length} route${ok.length === 1 ? "" : "s"}${ok.some((r) => r.status === "rerouted") ? ", some re-routed" : ""}.` : "Every open order already has a route. Open a pod or switch the simulation on to create orders.");
    }
  };

  const kateteFlooded = flooded.some((f) => f.toLowerCase().startsWith("katete"));
  const toggleFlood = async () => {
    const j = (await post("Flood switch", "/api/routes/flood", { village: "Katete", on: !kateteFlooded })) as { replanned: { status?: string; error?: string }[] } | null;
    if (j) {
      const re = j.replanned.filter((r) => r.status === "rerouted").length;
      setNote(!kateteFlooded ? `Katete road under water: ${j.replanned.length} open order${j.replanned.length === 1 ? "" : "s"} planned again, ${re} re-routed.` : `Katete road dry again: ${j.replanned.length} order${j.replanned.length === 1 ? "" : "s"} planned again.`);
    }
  };

  const ordersById = new Map(orders.map((o) => [String(o.id), o]));
  const carrierById = new Map(carriers.map((c) => [c.id, c]));
  const openUnplanned = orders.filter((o) => o.status !== "delivered" && !plans.some((p) => p.orderId === o.id)).length;
  const counts = { planned: plans.filter((p) => p.status === "planned").length, moving: plans.filter((p) => p.status === "moving").length, rerouted: plans.filter((p) => p.status === "rerouted").length, high: plans.filter((p) => p.floodRisk === "high").length };
  const whereIs = (c: Carrier) => {
    const p = plans.find((x) => x.carrierId === c.id && x.status === "moving");
    if (p) {
      const o = ordersById.get(String(p.orderId));
      return o ? `on the road ${vname(o.fromVillageId)} → ${vname(o.toVillageId)}` : "on the road";
    }
    return `at ${vname(c.baseVillageId)}`;
  };
  const pickedPlan = picked !== null ? plans.find((p) => p.id === picked) ?? null : null;
  const pickedCar = pickedCarrier !== null ? carrierById.get(pickedCarrier) ?? null : null;
  const surfaceText = (p: Plan) => { const s = meta?.surfaces[String(p.id)]; return s ? s.text.replace(/^[\d.]+ km: /, `${s.totalKm} km: `) : null; };

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-slate-100">
      <style>{CSS}</style>
      <div ref={el} className="absolute inset-0 far" />

      <div className="pointer-events-none absolute left-5 top-14 z-10 max-w-md">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-300">Routes · carriers</p>
        <h1 className="text-2xl font-bold">Who carries it, and which road</h1>
        <p className="mt-1 text-sm text-slate-300">
          The carriers Zambia really uses: ZAMMSA trucks from the Chipata hub, district health office pickups, Community Health Assistants on motorbikes, health workers on bicycles, banana boats on the Luangwa. Drones are a proposed partner only. Each planned order is drawn on the road it will follow; red means the flood check said high. Click a road or a carrier for its details.
        </p>
        <div className="pointer-events-auto mt-4 grid grid-cols-5 gap-2 text-center">
          <Kpi label="carriers" value={carriers.length} tone="text-slate-200" />
          <Kpi label="planned" value={counts.planned} tone="text-amber-300" />
          <Kpi label="moving" value={counts.moving} tone="text-sky-300" />
          <Kpi label="re-routed" value={counts.rerouted} tone="text-orange-300" />
          <Kpi label="flooded" value={counts.high} tone="text-red-400" />
        </div>
        <div className="pointer-events-auto mt-3 flex flex-wrap gap-2 text-xs">
          <button disabled={!!busy} onClick={planAll} className="rounded-lg border border-sky-700 bg-sky-950/80 px-3 py-1.5 text-sky-100 hover:bg-sky-900 disabled:opacity-50">
            {busy === "Plan routes" ? "Planning…" : `Plan routes for all open orders${openUnplanned ? ` (${openUnplanned})` : ""}`}
          </button>
          <button disabled={!!busy} onClick={toggleFlood} className={`rounded-lg border px-3 py-1.5 disabled:opacity-50 ${kateteFlooded ? "border-red-600 bg-red-950/80 text-red-200 hover:bg-red-900" : "border-slate-600 bg-slate-900/80 hover:bg-slate-800"}`}>
            {busy === "Flood switch" ? "Re-planning…" : kateteFlooded ? "Katete road flooded: dry it again" : "Flood the Katete road (test)"}
          </button>
          <span className={`self-center ${connected === "live" ? "text-emerald-300" : "text-amber-300"}`}>
            ● {connected === "live" ? "SpacetimeDB live" : connected === "connecting" ? "connecting…" : "SpacetimeDB offline — run `spacetime start`"}
          </span>
        </div>
        <p className="pointer-events-auto mt-2 text-xs text-slate-400">
          {meta?.googleKey ? "Roads: Google Maps (GOOGLE_MAPS_API_KEY set: live traffic and road closures)." : "Roads: OpenStreetMap (free). Add GOOGLE_MAPS_API_KEY to .env.local for Google's live traffic and road closures."}
          {meta ? ` ${meta.cachedPairs} road pairs cached, ${meta.surfacedPairs} with their surface from OpenStreetMap.` : ""}
          {flooded.length ? ` Under water: ${flooded.join(", ")}.` : ""}
        </p>
        <p className="pointer-events-auto mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
          <span>
            {rechecking ? "Re-checking every live route against the latest forecast…" : recheck?.at ? `Last re-check ${hhmm(recheck.at)} · ${recheck.checked} route${recheck.checked === 1 ? "" : "s"} · ${recheck.rerouted.length} rerouted${recheck.changed.length ? ` · ${recheck.changed.length} changed level` : ""}` : "Route watcher: first re-check pending"}
          </span>
          <button onClick={runRecheck} disabled={rechecking || !!busy} className="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">re-check now</button>
          <span className="text-slate-500">(every 10 min while open, and when the forecast refreshes)</span>
        </p>
        {note && <p className="pointer-events-auto mt-2 rounded-md border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs text-slate-200">{note}</p>}
        <RouteLegend className="pointer-events-auto mt-3" />
        <div className="pointer-events-auto mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" />
            Post with an open order
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-400 align-middle opacity-70" />
            Idle carrier at its base
          </span>
        </div>
      </div>

      {(pickedPlan || pickedCar) && (
        <div className="absolute bottom-5 left-5 z-10 max-h-[50vh] w-[24rem] overflow-y-auto rounded-2xl border border-slate-700/70 bg-slate-950/90 p-4 text-xs backdrop-blur">
          {pickedPlan && (() => {
            const o = ordersById.get(String(pickedPlan.orderId));
            const c = carrierById.get(pickedPlan.carrierId);
            const run = runOf(pickedPlan.reason);
            const surface = surfaceText(pickedPlan);
            return (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-100">{run ? `Run ${run.id} · ${run.tour}` : o ? `${vname(o.fromVillageId)} → ${vname(o.toVillageId)}` : `order #${String(pickedPlan.orderId)}`}</p>
                  <button onClick={() => pickRoad(null)} className="text-slate-400 hover:text-white" aria-label="close">✕</button>
                </div>
                <p className="mt-1 text-slate-300">
                  {o ? `${o.qty} ${o.item} for ${o.kind === "restock" ? `${vname(o.toVillageId)} post` : o.patientName}` : ""}{run ? ` · stop ${run.stop} of ${run.of}` : ""}
                </p>
                <p className="mt-1 text-slate-400">
                  <span style={{ color: KIND_COLOR[c?.kind ?? ""] }}>{c?.name ?? `carrier #${pickedPlan.carrierId}`}</span> · {pickedPlan.km} km · ~{pickedPlan.minutes} min ·{" "}
                  <span className={pickedPlan.floodRisk === "high" ? "text-red-400" : pickedPlan.floodRisk === "medium" ? "text-amber-300" : "text-emerald-300"}>flood {pickedPlan.floodRisk}</span> ·{" "}
                  <span className={`rounded px-1 py-0.5 font-mono text-[10px] uppercase ${STATUS_TONE[pickedPlan.status] ?? "bg-slate-800 text-slate-300"}`}>{pickedPlan.status}</span>
                </p>
                <p className="mt-1 text-slate-500">{surface ?? "surface: measuring…"}</p>
                <p className={`mt-2 leading-relaxed ${pickedPlan.status === "rerouted" ? "text-orange-200" : "text-slate-400"}`}>{pickedPlan.reason}</p>
              </>
            );
          })()}
          {pickedCar && (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold" style={{ color: KIND_COLOR[pickedCar.kind] }}>{pickedCar.name}</p>
                <button onClick={() => pickCarrier(null)} className="text-slate-400 hover:text-white" aria-label="close">✕</button>
              </div>
              <p className="mt-1 text-slate-300">{KIND_WORD[pickedCar.kind] ?? pickedCar.kind} · {pickedCar.operator} · {whereIs(pickedCar)}</p>
              <p className="mt-1 text-slate-500">carries {pickedCar.capacityKg} kg · {pickedCar.speedKmh} km/h · K{pickedCar.costPerKm}/km · {pickedCar.status}</p>
              {plans.filter((p) => p.carrierId === pickedCar.id && p.status !== "done").slice(0, 6).map((p) => {
                const o = ordersById.get(String(p.orderId));
                const run = runOf(p.reason);
                return (
                  <button key={String(p.id)} onClick={() => pickRoad(p.id)} className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-left hover:border-slate-600">
                    {run ? `run ${run.id} · ${run.tour}` : o ? `${vname(o.fromVillageId)} → ${vname(o.toVillageId)} · ${o.qty} ${o.item}` : `order #${String(p.orderId)}`} · {p.km} km · <span className={p.floodRisk === "high" ? "text-red-400" : p.floodRisk === "medium" ? "text-amber-300" : "text-emerald-300"}>flood {p.floodRisk}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}

      <div className="hud absolute bottom-5 right-5 top-14 z-10 flex w-[27rem] flex-col p-4">
        <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em]">
          <button onClick={() => setTab("routes")} className={`rounded px-2 py-1 ${tab === "routes" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-white"}`}>
            Planned routes ({plans.length})
          </button>
          <button onClick={() => setTab("carriers")} className={`rounded px-2 py-1 ${tab === "carriers" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-white"}`}>
            Carriers ({carriers.length})
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {tab === "routes" &&
            (plans.length ? (
              plans.map((p) => {
                const o = ordersById.get(String(p.orderId));
                const c = carrierById.get(p.carrierId);
                const on = picked === p.id;
                const run = runOf(p.reason);
                const surface = surfaceText(p);
                return (
                  <button
                    key={String(p.id)}
                    onClick={() => pickRoad(on ? null : p.id)}
                    className={`block w-full rounded-lg border px-3 py-2 text-left text-xs ${on ? "border-sky-500 bg-sky-950/60" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-100">
                        {o ? `${o.qty} ${o.item} → ${o.kind === "restock" ? `${vname(o.toVillageId)} post` : o.patientName}` : `order #${String(p.orderId)}`}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {run && <span className="rounded bg-teal-900/80 px-1.5 py-0.5 font-mono text-[10px] uppercase text-teal-200">run {run.id} · stop {run.stop}/{run.of}</span>}
                        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_TONE[p.status] ?? "bg-slate-800 text-slate-300"}`}>{p.status}</span>
                      </span>
                    </div>
                    <div className="mt-1 text-slate-400">
                      {run ? `${run.tour} · ` : o ? `${vname(o.fromVillageId)} → ${vname(o.toVillageId)} · ` : ""}
                      <span style={{ color: KIND_COLOR[c?.kind ?? ""] }}>{c?.name ?? `carrier #${p.carrierId}`}</span> · {p.km} km · ~{p.minutes} min ·{" "}
                      <span className={p.floodRisk === "high" ? "text-red-400" : p.floodRisk === "medium" ? "text-amber-300" : "text-emerald-300"}>flood {p.floodRisk}</span>
                    </div>
                    <div className="mt-0.5 text-slate-500" title={surface ? "road surface from OpenStreetMap" : "road surface not measured yet (OpenStreetMap lookup runs in the background)"}>
                      {surface ?? "surface: measuring…"}
                    </div>
                    {on && <div className={`mt-1 leading-relaxed ${p.status === "rerouted" ? "text-orange-200" : "text-slate-500"}`}>{p.reason}</div>}
                  </button>
                );
              })
            ) : (
              <p className="font-mono text-xs leading-relaxed text-slate-500">
                No routes planned yet. {openUnplanned ? `${openUnplanned} open order${openUnplanned === 1 ? "" : "s"} waiting: press "Plan routes".` : "Orders appear when a pod flags a need (open a pod, or switch simulated visits on in the live map)."}
              </p>
            ))}
          {tab === "carriers" &&
            carriers.map((c) => (
              <button key={c.id} onClick={() => pickCarrier(pickedCarrier === c.id ? null : c.id)} className={`block w-full rounded-lg border px-3 py-2 text-left text-xs ${pickedCarrier === c.id ? "border-sky-500 bg-sky-950/60" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium" style={{ color: KIND_COLOR[c.kind] }}>
                    {c.name}
                  </span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${c.status === "out" ? "bg-sky-900 text-sky-200" : c.status === "down" ? "bg-red-900 text-red-200" : "bg-slate-800 text-slate-300"}`}>{c.status}</span>
                </div>
                <div className="mt-1 text-slate-400">
                  {KIND_WORD[c.kind] ?? c.kind} · {c.operator} · {whereIs(c)}
                </div>
                <div className="mt-0.5 text-slate-500">
                  carries {c.capacityKg} kg · {c.speedKmh} km/h · K{c.costPerKm}/km
                </div>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { planned: "bg-amber-900/70 text-amber-200", moving: "bg-sky-900 text-sky-200", done: "bg-emerald-900/70 text-emerald-200", rerouted: "bg-orange-900 text-orange-200" };

function markerEl(m: Marker, onPickCarrier: (id: number) => void) {
  const d = document.createElement("div");
  if (m.kind === "village") {
    d.className = `vil ${m.hub ? "hub" : ""} ${m.active ? "active" : ""}`;
    d.innerHTML = `<i></i><b>${m.name}</b>`;
    d.title = m.name;
    return d;
  }
  if (m.kind === "stop") {
    d.className = "stop";
    d.innerHTML = `<i>${m.n}</i>`;
    d.title = `run ${m.run}, stop ${m.n}: ${m.name}`;
    return d;
  }
  d.className = `car ${m.ckind} ${m.status} ${m.moving ? "moving" : "idle"} ${m.picked ? "picked" : ""}`;
  const icon = { truck: "T", pickup: "P", motorbike: "M", bicycle: "B", boat: "W", drone: "D" }[m.ckind] ?? "?";
  d.innerHTML = `<i style="background:${KIND_COLOR[m.ckind] ?? "#e2e8f0"}">${m.moving ? icon : ""}</i>`;
  d.title = m.name;
  d.style.pointerEvents = "auto";
  d.onclick = (e) => {
    e.stopPropagation();
    onPickCarrier(m.id);
  };
  return d;
}

function Kpi({ label, value, tone = "text-amber-300" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-2 py-1.5">
      <div className={`font-mono text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

const CSS = `
.hud { background: linear-gradient(180deg, rgba(6,11,20,.92), rgba(6,11,20,.8)); border: 1px solid rgba(56,189,248,.18); border-radius: 14px; backdrop-filter: blur(8px); }
.vil { position: relative; transform: translate(-50%, -50%); pointer-events: none; }
.vil i { display: block; width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; box-shadow: 0 0 0 2px rgba(2,6,23,.8), 0 0 8px rgba(148,163,184,.6); }
.vil.hub i { width: 13px; height: 13px; background: #34d399; box-shadow: 0 0 0 3px rgba(2,6,23,.85), 0 0 0 5px rgba(52,211,153,.55), 0 0 16px rgba(52,211,153,.8); }
.vil.active i { background: #fbbf24; box-shadow: 0 0 0 2px rgba(2,6,23,.85), 0 0 0 4px rgba(251,191,36,.45), 0 0 14px rgba(251,191,36,.9); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.35); } }
.vil b { position: absolute; left: 11px; top: -3px; font: 500 10px/1 var(--font-space-grotesk), sans-serif; color: #e2e8f0; white-space: nowrap; text-shadow: 0 1px 2px #000; }
.far .vil:not(.hub) b { display: none; }
.car { position: relative; transform: translate(-50%, -50%); cursor: pointer; }
.car i { display: grid; place-items: center; width: 15px; height: 15px; border-radius: 4px; color: #0b1220; font: 700 9px/1 var(--font-geist-mono), monospace; box-shadow: 0 0 0 1.5px rgba(2,6,23,.9); font-style: normal; }
.car.idle i { width: 6px; height: 6px; border-radius: 50%; opacity: .7; box-shadow: 0 0 0 1px rgba(2,6,23,.9); }
.car.down i { filter: grayscale(1); opacity: .45; }
.car.picked i { box-shadow: 0 0 0 2px #38bdf8, 0 0 10px rgba(56,189,248,.9); opacity: 1; }
.stop { position: relative; transform: translate(-50%, -50%); pointer-events: none; }
.stop i { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: #0f766e; color: #ecfeff; font: 700 10px/1 var(--font-geist-mono), monospace; font-style: normal; box-shadow: 0 0 0 2px #99f6e4, 0 0 0 3.5px rgba(2,6,23,.9); }
`;
