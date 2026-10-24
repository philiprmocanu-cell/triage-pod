"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";

// Live 3D view of the pod network, fed straight from SpacetimeDB. Every need a pod flags pops up
// as "+1 …" over the village, becomes an order with the patient's name, and flies (drone) or
// drives (truck) from wherever the medicine actually is to the patient's home.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";

type Village = { id: number; name: string; lat: number; lng: number; population: number; hub: boolean };
type Order = {
  id: bigint;
  patientName: string;
  toVillageId: number;
  fromVillageId: number;
  item: string;
  qty: number;
  mode: string;
  status: string;
  travelSeconds: number;
  etaMinutes: number;
  departedAt?: { microsSinceUnixEpoch: bigint };
};
type FeedItem = { id: number; text: string; tone: "need" | "move" | "done" | "alert" | "live" };
type Marker =
  | { kind: "village"; v: Village; lat: number; lng: number }
  | { kind: "pop"; id: number; lat: number; lng: number; text: string; tone: string }
  | { kind: "mover"; id: string; lat: number; lng: number; icon: string };

let feedSeq = 0;

export default function GlobePage() {
  const el = useRef<HTMLDivElement>(null);
  const globeRef = useRef<import("globe.gl").GlobeInstance | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const villages = useRef(new Map<number, Village>());
  const pops = useRef<Marker[]>([]);
  const movers = useRef(new Map<string, Marker & { kind: "mover" }>());
  const villageMarkers = useRef<Marker[]>([]);
  const [connected, setConnected] = useState<"connecting" | "live" | "offline">("connecting");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [kpi, setKpi] = useState({ visits: 0, live: 0, orders: 0, flying: 0, delivered: 0 });
  const [simulate, setSimulate] = useState(true);
  const [picked, setPicked] = useState<Village | null>(null);
  const [stockOf, setStockOf] = useState<{ item: string; qty: number }[]>([]);

  const push = (text: string, tone: FeedItem["tone"]) => setFeed((f) => [{ id: ++feedSeq, text, tone }, ...f].slice(0, 40));
  const vname = (id: number) => villages.current.get(id)?.name.replace(/ \(.*\)$/, "") ?? `#${id}`;

  // ---- globe ----
  useEffect(() => {
    let raf = 0;
    let disposed = false;
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
        .htmlAltitude((d: object) => ((d as Marker).kind === "mover" ? 0.02 : (d as Marker).kind === "pop" ? 0.01 : 0.004))
        .htmlElement((d: object) => markerEl(d as Marker, (v) => setPicked(v)))
        .arcsData([])
        .arcStartLat((d: object) => (d as { a: Village }).a.lat)
        .arcStartLng((d: object) => (d as { a: Village }).a.lng)
        .arcEndLat((d: object) => (d as { b: Village }).b.lat)
        .arcEndLng((d: object) => (d as { b: Village }).b.lng)
        .arcColor((d: object) => ((d as { mode: string }).mode === "drone" ? ["#38bdf8", "#e0f2fe"] : ["#a78bfa", "#ede9fe"]))
        .arcAltitude(0.012)
        .arcStroke(0.05)
        .arcDashLength(0.35)
        .arcDashGap(0.15)
        .arcDashAnimateTime(1400)
        .ringsData([])
        .ringColor((d: object) => (t: number) => `rgba(${(d as { rgb: string }).rgb},${1 - t})`)
        .ringMaxRadius(0.35)
        .ringPropagationSpeed(1.6)
        .ringRepeatPeriod(700);
      g.pointOfView({ lat: 0, lng: 15, altitude: 3.2 });
      setTimeout(() => g.pointOfView({ lat: -12.75, lng: 33.35, altitude: 0.14 }, 4200), 700); // fly in from space
      g.controls().autoRotate = false;
      globeRef.current = g;

      // Movers (drones/trucks) glide between towns; refresh markers a few times a second.
      const loop = () => {
        raf = requestAnimationFrame(loop);
        refreshMarkers();
      };
      let last = 0;
      const refreshMarkers = () => {
        const now = performance.now();
        if (now - last < 120) return;
        last = now;
        const conn = connRef.current;
        if (conn) {
          const nowUs = BigInt(Date.now()) * BigInt(1000);
          for (const o of conn.db.deliveryOrder.iter() as Iterable<Order>) {
            const key = String(o.id);
            if (o.status !== "on_the_way" || o.mode === "walk" || !o.departedAt) {
              movers.current.delete(key);
              continue;
            }
            const a = villages.current.get(o.fromVillageId), b = villages.current.get(o.toVillageId);
            if (!a || !b) continue;
            const t = Math.min(1, Number(nowUs - o.departedAt.microsSinceUnixEpoch) / 1e6 / o.travelSeconds);
            const m = movers.current.get(key) ?? { kind: "mover" as const, id: key, lat: a.lat, lng: a.lng, icon: o.mode === "drone" ? "🛩️" : "🚚" };
            m.lat = a.lat + (b.lat - a.lat) * t;
            m.lng = a.lng + (b.lng - a.lng) * t;
            movers.current.set(key, m);
          }
        }
        g.htmlElementsData([...villageMarkers.current, ...pops.current, ...movers.current.values()]);
      };
      loop();
    })();
    const onResize = () => globeRef.current?.width(window.innerWidth).height(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      globeRef.current?._destructor?.();
    };
  }, []);

  // ---- SpacetimeDB ----
  useEffect(() => {
    const refreshKpis = (conn: DbConnection) => {
      const visits = [...conn.db.visit.iter()];
      const orders = [...conn.db.deliveryOrder.iter()] as Order[];
      setKpi({
        visits: visits.length,
        live: visits.filter((v) => v.fromPod).length,
        orders: orders.length,
        flying: orders.filter((o) => o.status === "on_the_way").length,
        delivered: orders.filter((o) => o.status === "delivered").length,
      });
      const arcs = orders
        .filter((o) => o.status !== "delivered" && o.mode !== "walk")
        .map((o) => ({ a: villages.current.get(o.fromVillageId), b: villages.current.get(o.toVillageId), mode: o.mode }))
        .filter((x) => x.a && x.b);
      globeRef.current?.arcsData(arcs);
      const s = [...conn.db.settings.iter()][0];
      if (s) setSimulate(s.simulate);
    };

    const syncVillages = (conn: DbConnection) => {
      villages.current = new Map([...conn.db.village.iter()].map((v) => [v.id, v as Village]));
      villageMarkers.current = [...villages.current.values()].map((v) => ({ kind: "village" as const, v, lat: v.lat, lng: v.lng }));
    };

    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setConnected("live");
        c.subscriptionBuilder()
          .onApplied(() => {
            syncVillages(c);
            refreshKpis(c);
          })
          .subscribe(["SELECT * FROM village", "SELECT * FROM stock", "SELECT * FROM visit", "SELECT * FROM delivery_order", "SELECT * FROM settings", "SELECT * FROM pop"]);
      })
      .onConnectError(() => setConnected("offline"))
      .onDisconnect(() => setConnected("offline"))
      .build();
    connRef.current = conn;

    conn.db.village.onInsert(() => syncVillages(conn));
    conn.db.settings.onUpdate(() => refreshKpis(conn));
    conn.db.visit.onInsert((_ctx, v) => {
      refreshKpis(conn);
      if (v.fromPod) push(`LIVE POD · ${v.patientName} checked in ${vname(v.villageId)} — ${v.urgency === "green" ? "no needs found" : v.urgency.toUpperCase()}`, "live");
    });
    conn.db.deliveryOrder.onInsert((_ctx, o) => {
      refreshKpis(conn);
      push(`Ordered: ${o.item} for ${o.patientName} (${vname(o.toVillageId)}) — ${o.mode === "walk" ? "from the village post" : `${o.mode} from ${vname(o.fromVillageId)}, ~${o.etaMinutes} min`}`, "move");
    });
    conn.db.deliveryOrder.onUpdate((_ctx, _old, o) => {
      refreshKpis(conn);
      if (o.status === "on_the_way" && o.mode !== "walk") push(`${o.mode === "drone" ? "🛩 Drone" : "🚚 Truck"} left ${vname(o.fromVillageId)} with ${o.item} for ${o.patientName}`, "move");
    });
    conn.db.pop.onInsert((_ctx, p) => {
      const v = villages.current.get(p.villageId);
      if (!v) return;
      const id = ++feedSeq;
      const tone = p.kind === "delivered" ? "done" : p.kind === "alert" ? "alert" : "need";
      pops.current.push({ kind: "pop", id, lat: v.lat, lng: v.lng, text: p.text, tone });
      setTimeout(() => (pops.current = pops.current.filter((x) => x.kind !== "pop" || x.id !== id)), 2600);
      const g = globeRef.current;
      if (g) {
        const ring = { lat: v.lat, lng: v.lng, rgb: tone === "done" ? "52,211,153" : tone === "alert" ? "239,68,68" : "251,191,36" };
        g.ringsData([...(g.ringsData() as object[]), ring]);
        setTimeout(() => g.ringsData((g.ringsData() as object[]).filter((r) => r !== ring)), 2200);
      }
      if (tone === "done") push(`📦 ${p.text.replace(/^📦 /, "")} — delivered (${vname(p.villageId)})`, "done");
      else if (tone === "alert") push(`${p.text} (${vname(p.villageId)})`, "alert");
      else push(`${p.text} — ${vname(p.villageId)}`, "need");
    });
    return () => conn.disconnect();
  }, []);

  // Stock of the village you click.
  useEffect(() => {
    const conn = connRef.current;
    if (!picked || !conn) return;
    const read = () => setStockOf([...conn.db.stock.iter()].filter((s) => s.villageId === picked.id).map((s) => ({ item: s.item, qty: s.qty })));
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, [picked]);

  const conn = connRef.current;
  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-slate-100">
      <style>{CSS}</style>
      <div ref={el} className="absolute inset-0" />

      <div className="pointer-events-none absolute left-5 top-5 z-10 max-w-md">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-300">Pod network · live</p>
        <h1 className="text-2xl font-bold">Eastern Province, Zambia</h1>
        <p className="mt-1 text-sm text-slate-300">
          The medicine is in Chipata. The village posts run out. Every pod visit turns a flagged need into a delivery to that patient&apos;s home.
        </p>
        <div className="pointer-events-auto mt-4 grid grid-cols-5 gap-2 text-center">
          <Kpi label="patients" value={kpi.visits} />
          <Kpi label="live pods" value={kpi.live} tone="text-sky-300" />
          <Kpi label="orders" value={kpi.orders} tone="text-amber-300" />
          <Kpi label="on the way" value={kpi.flying} tone="text-sky-300" />
          <Kpi label="delivered" value={kpi.delivered} tone="text-emerald-300" />
        </div>
        <div className="pointer-events-auto mt-3 flex gap-2 text-xs">
          <button onClick={() => conn?.reducers.setSimulation({ on: !simulate })} className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 hover:bg-slate-800">
            {simulate ? "Pause other villages" : "Resume other villages"}
          </button>
          <button onClick={() => conn?.reducers.resetDemo({})} className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 hover:bg-slate-800">
            Reset
          </button>
          <Link href="/kiosk?village=Katete" className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 hover:bg-slate-800">
            Open the Katete pod
          </Link>
          <span className={`self-center ${connected === "live" ? "text-emerald-300" : "text-amber-300"}`}>
            ● {connected === "live" ? "SpacetimeDB live" : connected === "connecting" ? "connecting…" : "SpacetimeDB offline — run `spacetime start`"}
          </span>
        </div>
      </div>

      <div className="absolute bottom-5 right-5 top-5 z-10 flex w-96 flex-col rounded-2xl border border-slate-700/70 bg-slate-950/75 p-4 backdrop-blur">
        <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">What just happened</p>
        <div className="flex-1 space-y-1.5 overflow-hidden">
          {feed.map((f) => (
            <p key={f.id} className={`feed rounded-lg px-2.5 py-1.5 text-sm ${TONE[f.tone]}`}>
              {f.text}
            </p>
          ))}
          {!feed.length && <p className="text-sm text-slate-500">Waiting for the first patient…</p>}
        </div>
      </div>

      {picked && (
        <div className="absolute bottom-5 left-5 z-10 w-80 rounded-2xl border border-slate-700/70 bg-slate-950/85 p-4 backdrop-blur">
          <div className="flex items-baseline justify-between">
            <p className="font-semibold">{picked.name}</p>
            <button onClick={() => setPicked(null)} className="text-slate-400">✕</button>
          </div>
          <p className="text-xs text-slate-400">{picked.hub ? "Regional hub" : `Village post · ${picked.population.toLocaleString()} people`}</p>
          <div className="mt-2 space-y-1">
            {stockOf.map((s) => (
              <div key={s.item} className="flex justify-between text-sm">
                <span>{s.item}</span>
                <span className={`tabular-nums ${s.qty <= 0 ? "text-red-400" : s.qty < 5 ? "text-amber-300" : "text-emerald-300"}`}>{s.qty}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const TONE: Record<FeedItem["tone"], string> = {
  need: "bg-amber-500/15 text-amber-100",
  move: "bg-sky-500/10 text-sky-100",
  done: "bg-emerald-500/15 text-emerald-100",
  alert: "bg-red-500/20 text-red-100",
  live: "bg-violet-500/25 text-violet-100 font-semibold",
};

function Kpi({ label, value, tone = "text-white" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-700/70 bg-slate-950/70 px-2 py-2 backdrop-blur">
      <p className={`text-xl font-bold tabular-nums ${tone}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
    </div>
  );
}

// Sims-style markers: a tile per village, floating "+1" bubbles, little drones and trucks.
function markerEl(d: Marker, onPick: (v: Village) => void): HTMLElement {
  const n = document.createElement("div");
  if (d.kind === "village") {
    n.className = `village ${d.v.hub ? "hub" : ""}`;
    n.innerHTML = `<span class="pin">${d.v.hub ? "🏥" : "🏘️"}</span><span class="name">${d.v.name.replace(/ \(.*\)$/, "")}</span>`;
    n.style.pointerEvents = "auto";
    n.onclick = () => onPick(d.v);
  } else if (d.kind === "pop") {
    n.className = `pop ${d.tone}`;
    n.textContent = d.text;
  } else {
    n.className = "mover";
    n.textContent = d.icon;
  }
  return n;
}

const CSS = `
.village{display:flex;align-items:center;gap:4px;transform:translate(-50%,-50%);cursor:pointer;white-space:nowrap}
.village .pin{font-size:20px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.7))}
.village .name{font:600 11px/1.2 system-ui;background:rgba(2,6,23,.75);border:1px solid rgba(148,163,184,.4);padding:2px 6px;border-radius:999px}
.village.hub .name{border-color:#34d399;color:#a7f3d0}
.pop{z-index:999!important;font:800 15px/1 system-ui;padding:6px 10px;border:2px solid rgba(255,255,255,.85);border-radius:999px;white-space:nowrap;animation:floatup 2.6s ease-out forwards;box-shadow:0 4px 14px rgba(0,0,0,.5)}
.pop.need{background:#fbbf24;color:#1c1917}
.pop.done{background:#34d399;color:#052e16}
.pop.alert{background:#ef4444;color:white}
@keyframes floatup{0%{opacity:0;margin-top:-10px;scale:.6}12%{opacity:1;margin-top:-34px;scale:1.1}20%{scale:1}75%{opacity:1}100%{opacity:0;margin-top:-80px}}
.mover{transform:translate(-50%,-50%);font-size:20px;filter:drop-shadow(0 0 6px rgba(56,189,248,.9))}
.feed{animation:feedin .35s ease-out}
@keyframes feedin{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
`;
