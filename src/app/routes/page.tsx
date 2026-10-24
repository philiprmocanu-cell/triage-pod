"use client";

import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";

// Where every delivery actually goes: the real carriers (ZAMMSA trucks, district pickups, CHA
// motorbikes, CHW bicycles, Luangwa boats, proposed drones) and the road each planned order
// follows, straight from the `carrier` and `route_plan` tables in SpacetimeDB. Lines follow
// real roads (Google Maps with a key, OpenStreetMap/OSRM without); red where the flood check
// said high. The test switch floods the Katete road and plans every open order again.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";

type Village = { id: number; name: string; lat: number; lng: number; hub: boolean };
type Carrier = { id: number; name: string; kind: string; operator: string; baseVillageId: number; capacityKg: number; speedKmh: number; costPerKm: number; status: string };
type Plan = { id: bigint; orderId: bigint; carrierId: number; waypoints: string; km: number; minutes: number; floodRisk: string; status: string; reason: string; createdAt: { microsSinceUnixEpoch: bigint } };
type Order = { id: bigint; kind: string; patientName: string; toVillageId: number; fromVillageId: number; item: string; qty: number; status: string; travelSeconds: number; departedAt?: { microsSinceUnixEpoch: bigint } };
type Marker =
  | { kind: "village"; id: number; lat: number; lng: number; name: string; hub: boolean }
  | { kind: "carrier"; id: number; lat: number; lng: number; name: string; ckind: string; status: string; label: string };
type PathRow = { id: string; points: [number, number][]; color: string; high: boolean; status: string; stroke: number };

const KIND_COLOR: Record<string, string> = { truck: "#f59e0b", pickup: "#fb923c", motorbike: "#38bdf8", bicycle: "#34d399", boat: "#22d3ee", drone: "#a78bfa" };
const KIND_WORD: Record<string, string> = { truck: "Truck", pickup: "Pickup", motorbike: "Motorbike", bicycle: "Bicycle", boat: "Boat", drone: "Drone (proposed)" };
const short = (name: string) => name.replace(/ \(.*\)$/, "");

export default function RoutesPage() {
  const el = useRef<HTMLDivElement>(null);
  const globeRef = useRef<import("globe.gl").GlobeInstance | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const villages = useRef(new Map<number, Village>());
  const [connected, setConnected] = useState<"connecting" | "live" | "offline">("connecting");
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<"routes" | "carriers">("routes");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [flooded, setFlooded] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ router: string; cachedPairs: number } | null>(null);
  const [picked, setPicked] = useState<bigint | null>(null);
  const pickedRef = useRef<bigint | null>(null);

  const vname = (id: number) => short(villages.current.get(id)?.name ?? `#${id}`);

  const readMeta = () =>
    fetch("/api/routes")
      .then((r) => r.json())
      .then((j) => {
        setMeta({ router: j.router, cachedPairs: j.cachedPairs });
        setFlooded((j.floods ?? []).map((f: { name: string }) => f.name));
      })
      .catch(() => undefined);

  // ---- the map ----
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
        .backgroundImageUrl("/globe/night-sky.png")
        .atmosphereColor("#7dd3fc")
        .atmosphereAltitude(0.18)
        .htmlElementsData([])
        .htmlLat((d: object) => (d as Marker).lat)
        .htmlLng((d: object) => (d as Marker).lng)
        .htmlAltitude((d: object) => ((d as Marker).kind === "carrier" ? 0.012 : 0.003))
        .htmlElement((d: object) => markerEl(d as Marker))
        .pathsData([])
        .pathPoints((d: object) => (d as PathRow).points)
        .pathPointLat((p: unknown) => (p as [number, number])[0])
        .pathPointLng((p: unknown) => (p as [number, number])[1])
        .pathPointAlt(0.006)
        .pathResolution(1)
        .pathColor((d: object) => (d as PathRow).color)
        .pathStroke((d: object) => (d as PathRow).stroke)
        .pathDashLength((d: object) => ((d as PathRow).status === "moving" ? 0.08 : (d as PathRow).status === "done" ? 0.02 : 1))
        .pathDashGap((d: object) => ((d as PathRow).status === "moving" ? 0.04 : (d as PathRow).status === "done" ? 0.02 : 0))
        .pathDashAnimateTime((d: object) => ((d as PathRow).status === "moving" ? 6000 : 0))
        .pathTransitionDuration(0)
        .onPathClick((p: object) => {
          const id = BigInt((p as PathRow).id);
          pickedRef.current = id;
          setPicked(id);
        });
      g.pointOfView({ lat: -13.3, lng: 32.2, altitude: 0.26 });
      g.controls().autoRotate = false;
      g.controls().zoomSpeed = 1.2;
      g.onGlobeClick(() => {
        pickedRef.current = null;
        setPicked(null);
      });
      globeRef.current = g;
      fit();
      const loop = () => {
        raf = requestAnimationFrame(loop);
        refresh();
      };
      let last = 0;
      const refresh = () => {
        const now = performance.now();
        if (now - last < 250) return;
        last = now;
        const conn = connRef.current;
        if (!conn) return;
        const alt = g.pointOfView()?.altitude ?? 1;
        el.current?.classList.toggle("far", alt > 0.18);
        draw(conn);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paths and markers from the tables, every quarter second (carriers glide along moving plans).
  const draw = (conn: DbConnection) => {
    const g = globeRef.current;
    if (!g) return;
    const plansNow = [...conn.db.routePlan.iter()] as Plan[];
    const ordersNow = new Map(([...conn.db.deliveryOrder.iter()] as Order[]).map((o) => [String(o.id), o]));
    const carriersNow = [...conn.db.carrier.iter()] as Carrier[];
    const p = pickedRef.current;
    const paths: PathRow[] = [];
    const where = new Map<number, { lat: number; lng: number; label: string }>(); // carriers on the move
    const nowUs = BigInt(Date.now()) * BigInt(1000);
    for (const plan of plansNow) {
      let points: [number, number][] = [];
      try {
        points = JSON.parse(plan.waypoints);
      } catch {
        continue;
      }
      if (points.length < 2) continue;
      const c = carriersNow.find((x) => x.id === plan.carrierId);
      const mine = p === null || p === plan.id;
      const high = plan.floodRisk === "high";
      const color = high ? "#ef4444" : KIND_COLOR[c?.kind ?? ""] ?? "#e2e8f0";
      paths.push({ id: String(plan.id), points, color: mine ? color : dim(color), high, status: plan.status, stroke: p === plan.id ? 1.1 : plan.status === "done" ? 0.35 : 0.65 });
      const o = ordersNow.get(String(plan.orderId));
      if (c && plan.status === "moving" && o?.departedAt) {
        const t = Math.min(1, Number(nowUs - o.departedAt.microsSinceUnixEpoch) / 1e6 / Math.max(1, o.travelSeconds));
        const [lat, lng] = along(points, t);
        where.set(c.id, { lat, lng, label: `${o.item} · ${Math.max(1, Math.round(plan.minutes * (1 - t)))} min` });
      }
    }
    g.pathsData(paths);
    const markers: Marker[] = [...villages.current.values()].map((v) => ({ kind: "village", id: v.id, lat: v.lat, lng: v.lng, name: short(v.name), hub: v.hub }));
    // Several carriers share a base: fan them out a little so each chip stays readable.
    const perBase = new Map<number, number>();
    for (const c of carriersNow) {
      const moving = where.get(c.id);
      const base = villages.current.get(c.baseVillageId);
      if (!moving && !base) continue;
      const n = perBase.get(c.baseVillageId) ?? 0;
      perBase.set(c.baseVillageId, n + 1);
      const lat = moving ? moving.lat : base!.lat + 0.028 + n * 0.022;
      const lng = moving ? moving.lng : base!.lng + 0.03;
      markers.push({ kind: "carrier", id: c.id, lat, lng, name: c.name, ckind: c.kind, status: c.status, label: moving?.label ?? "" });
    }
    g.htmlElementsData(markers);
  };

  // ---- SpacetimeDB ----
  useEffect(() => {
    const sync = (conn: DbConnection) => {
      villages.current = new Map([...conn.db.village.iter()].map((v) => [v.id, v as Village]));
      setCarriers(([...conn.db.carrier.iter()] as Carrier[]).sort((a, b) => a.id - b.id));
      setPlans(([...conn.db.routePlan.iter()] as Plan[]).sort((a, b) => Number(b.id - a.id)));
      setOrders([...conn.db.deliveryOrder.iter()] as Order[]);
    };
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setConnected("live");
        c.subscriptionBuilder()
          .onApplied(() => sync(c))
          .subscribe(["SELECT * FROM village", "SELECT * FROM carrier", "SELECT * FROM route_plan", "SELECT * FROM delivery_order"]);
      })
      .onConnectError(() => setConnected("offline"))
      .onDisconnect(() => setConnected("offline"))
      .build();
    connRef.current = conn;
    for (const t of [conn.db.village, conn.db.carrier, conn.db.routePlan, conn.db.deliveryOrder]) {
      t.onInsert(() => sync(conn));
      t.onUpdate(() => sync(conn));
      t.onDelete(() => sync(conn));
    }
    readMeta();
    return () => conn.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-slate-100">
      <style>{CSS}</style>
      <div ref={el} className="absolute inset-0 far" />

      <div className="pointer-events-none absolute left-5 top-14 z-10 max-w-md">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-300">Routes · carriers</p>
        <h1 className="text-2xl font-bold">Who carries it, and which road</h1>
        <p className="mt-1 text-sm text-slate-300">
          The carriers Zambia really uses: ZAMMSA trucks from the Chipata hub, district health office pickups, Community Health Assistants on motorbikes, health workers on bicycles, banana boats on the Luangwa. Drones are a proposed partner only. Each planned order is drawn on the road it will follow; red means the flood check said high.
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
          Roads from {meta?.router === "google" ? "Google Maps (key set)" : "OpenStreetMap via OSRM (free, no key; add GOOGLE_MAPS_API_KEY to .env.local for Google)"}
          {meta ? ` · ${meta.cachedPairs} road pairs cached` : ""}
          {flooded.length ? ` · under water: ${flooded.join(", ")}` : ""}
        </p>
        {note && <p className="pointer-events-auto mt-2 rounded-md border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs text-slate-200">{note}</p>}
        <div className="pointer-events-auto mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
          {Object.entries(KIND_WORD).map(([k, w]) => (
            <span key={k}>
              <span className="mr-1 inline-block h-2 w-4 rounded-sm align-middle" style={{ background: KIND_COLOR[k] }} />
              {w}
            </span>
          ))}
          <span>
            <span className="mr-1 inline-block h-2 w-4 rounded-sm bg-red-500 align-middle" />
            Flood risk high
          </span>
        </div>
      </div>

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
                return (
                  <button
                    key={String(p.id)}
                    onClick={() => {
                      pickedRef.current = on ? null : p.id;
                      setPicked(on ? null : p.id);
                    }}
                    className={`block w-full rounded-lg border px-3 py-2 text-left text-xs ${on ? "border-sky-500 bg-sky-950/60" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-100">
                        {o ? `${o.qty} ${o.item} → ${o.kind === "restock" ? `${vname(o.toVillageId)} post` : o.patientName}` : `order #${String(p.orderId)}`}
                      </span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_TONE[p.status] ?? "bg-slate-800 text-slate-300"}`}>{p.status}</span>
                    </div>
                    <div className="mt-1 text-slate-400">
                      {o ? `${vname(o.fromVillageId)} → ${vname(o.toVillageId)} · ` : ""}
                      <span style={{ color: KIND_COLOR[c?.kind ?? ""] }}>{c?.name ?? `carrier #${p.carrierId}`}</span> · {p.km} km · ~{p.minutes} min ·{" "}
                      <span className={p.floodRisk === "high" ? "text-red-400" : p.floodRisk === "medium" ? "text-amber-300" : "text-emerald-300"}>flood {p.floodRisk}</span>
                    </div>
                    <div className={`mt-1 leading-relaxed ${p.status === "rerouted" ? "text-orange-200" : "text-slate-500"}`}>{p.reason}</div>
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
              <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs">
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
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { planned: "bg-amber-900/70 text-amber-200", moving: "bg-sky-900 text-sky-200", done: "bg-emerald-900/70 text-emerald-200", rerouted: "bg-orange-900 text-orange-200" };

function dim(hex: string) {
  return hex + "55";
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
    d.className = `vil ${m.hub ? "hub" : ""}`;
    d.innerHTML = `<i></i><b>${m.name}</b>`;
    return d;
  }
  d.className = `car ${m.ckind} ${m.status}`;
  const icon = { truck: "T", pickup: "P", motorbike: "M", bicycle: "B", boat: "W", drone: "D" }[m.ckind] ?? "?";
  d.innerHTML = `<i style="background:${KIND_COLOR[m.ckind] ?? "#e2e8f0"}">${icon}</i><b>${m.name}${m.label ? ` · ${m.label}` : ""}</b>`;
  d.title = m.name;
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
.vil i { display: block; width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; box-shadow: 0 0 0 2px rgba(15,23,42,.8); }
.vil.hub i { width: 11px; height: 11px; background: #fbbf24; }
.vil b { position: absolute; left: 10px; top: -4px; font: 500 10px/1 var(--font-space-grotesk), sans-serif; color: #e2e8f0; white-space: nowrap; text-shadow: 0 1px 2px #000; }
.far .vil:not(.hub) b { display: none; }
.car { position: relative; transform: translate(-50%, -50%); pointer-events: none; display: flex; align-items: center; gap: 4px; }
.car i { display: grid; place-items: center; width: 14px; height: 14px; border-radius: 4px; color: #0b1220; font: 700 9px/1 var(--font-geist-mono), monospace; box-shadow: 0 0 0 1.5px rgba(2,6,23,.9); font-style: normal; }
.car.idle i { opacity: .75; }
.car.down i { filter: grayscale(1); opacity: .5; }
.car b { font: 500 10px/1 var(--font-space-grotesk), sans-serif; color: #f1f5f9; white-space: nowrap; text-shadow: 0 1px 2px #000; }
.far .car.idle b { display: none; }
.far .car.idle i { width: 9px; height: 9px; font-size: 0; }
`;
