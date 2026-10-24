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
  kind: string;
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
type FeedItem = { id: number; at: string; text: string; tone: "need" | "move" | "done" | "alert" | "live" | "restock" | "agent" };
type Marker =
  | { kind: "village"; v: Village; lat: number; lng: number }
  | { kind: "pop"; id: number; lat: number; lng: number; text: string; tone: string }
  | { kind: "mover"; id: string; lat: number; lng: number; icon: string; label: string };

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

  const push = (text: string, tone: FeedItem["tone"]) =>
    setFeed((f) => [{ id: ++feedSeq, at: new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }), text, tone }, ...f].slice(0, 40));
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
        .arcColor((d: object) => {
          const o = d as { mode: string; kind: string };
          return o.kind === "restock" ? ["#34d399", "#d1fae5"] : o.mode === "drone" ? ["#38bdf8", "#e0f2fe"] : ["#a78bfa", "#ede9fe"];
        })
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
      // Fly in from space to a view that still shows the curve of the planet and the whole
      // province. (Any closer and the scroll wheel barely zooms: globe.gl scales the zoom step
      // with the distance to the ground.)
      setTimeout(() => g.pointOfView({ lat: -13.1, lng: 32.7, altitude: 0.2 }, 4200), 700);
      g.controls().autoRotate = false;
      g.controls().zoomSpeed = 1.2;
      globeRef.current = g;
      (window as unknown as { __globe?: unknown }).__globe = g; // for debugging from the console

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
            const m = movers.current.get(key) ?? { kind: "mover" as const, id: key, lat: a.lat, lng: a.lng, icon: o.mode === "drone" ? "🛩️" : "🚚", label: "" };
            m.lat = a.lat + (b.lat - a.lat) * t;
            m.lng = a.lng + (b.lng - a.lng) * t;
            m.label = `${o.item} · ${Math.max(1, Math.round(o.etaMinutes * (1 - t)))} min`;
            movers.current.set(key, m);
          }
        }
        const far = (g.pointOfView()?.altitude ?? 1) > 0.16; // ETA tags only once you zoom in
        el.current?.classList.toggle("far", far);
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
        .map((o) => ({ a: villages.current.get(o.fromVillageId), b: villages.current.get(o.toVillageId), mode: o.mode, kind: o.kind }))
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
          .subscribe(["SELECT * FROM village", "SELECT * FROM stock", "SELECT * FROM visit", "SELECT * FROM delivery_order", "SELECT * FROM settings", "SELECT * FROM pop", "SELECT * FROM agent_log"]);
      })
      .onConnectError(() => setConnected("offline"))
      .onDisconnect(() => setConnected("offline"))
      .build();
    connRef.current = conn;

    conn.db.village.onInsert(() => syncVillages(conn));
    conn.db.settings.onUpdate(() => refreshKpis(conn));
    conn.db.visit.onInsert((_ctx, v) => {
      refreshKpis(conn);
      if (v.fromPod) push(`LIVE POD ▸ ${v.patientName} · ${vname(v.villageId)} · ${v.urgency === "green" ? "nothing needed" : v.urgency.toUpperCase()}`, "live");
    });
    conn.db.deliveryOrder.onInsert((_ctx, o) => {
      refreshKpis(conn);
      if (o.kind === "restock") push(`RESTOCK ▸ ${o.qty} ${o.item} → ${vname(o.toVillageId)} post · ${o.mode} from ${vname(o.fromVillageId)} · ~${o.etaMinutes} min`, "restock");
      else push(`ORDER ▸ ${o.item} → ${o.patientName} (${vname(o.toVillageId)}) · ${o.mode === "walk" ? "from the village post" : `${o.mode} from ${vname(o.fromVillageId)} · ~${o.etaMinutes} min`}`, "move");
    });
    conn.db.deliveryOrder.onUpdate((_ctx, _old, o) => {
      refreshKpis(conn);
      if (o.status === "on_the_way" && o.mode !== "walk") push(`${o.mode === "drone" ? "DRONE" : "TRUCK"} ▸ left ${vname(o.fromVillageId)} · ${o.qty} ${o.item} → ${o.kind === "restock" ? `${vname(o.toVillageId)} post` : o.patientName}`, "move");
    });
    conn.db.agentLog.onInsert((_ctx, l) => {
      if (l.agent !== "Pod") push(`${l.agent.toUpperCase()} ▸ ${l.text}`, "agent");
    });
    conn.db.pop.onInsert((_ctx, p) => {
      const v = villages.current.get(p.villageId);
      if (!v) return;
      const id = ++feedSeq;
      const tone = p.kind === "delivered" ? "done" : p.kind === "alert" ? "alert" : p.kind === "restock" ? "restock" : "need";
      pops.current.push({ kind: "pop", id, lat: v.lat, lng: v.lng, text: p.text, tone });
      setTimeout(() => (pops.current = pops.current.filter((x) => x.kind !== "pop" || x.id !== id)), 2600);
      const g = globeRef.current;
      if (g) {
        const ring = { lat: v.lat, lng: v.lng, rgb: tone === "done" ? "52,211,153" : tone === "alert" ? "239,68,68" : tone === "restock" ? "56,189,248" : "251,191,36" };
        g.ringsData([...(g.ringsData() as object[]), ring]);
        setTimeout(() => g.ringsData((g.ringsData() as object[]).filter((r) => r !== ring)), 2200);
      }
      if (tone === "done") push(`DELIVERED ▸ ${p.text.replace(/^📦 /, "")} · ${vname(p.villageId)}`, "done");
      else if (tone === "alert") push(`ALERT ▸ ${p.text.replace(/^[🚨⚠] /, "")} · ${vname(p.villageId)}`, "alert");
      else if (tone === "need") push(`NEED ▸ ${p.text} · ${vname(p.villageId)}`, "need");
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

      <div className="pointer-events-none absolute left-5 top-14 z-10 max-w-md">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-300">Pod network · live</p>
        <h1 className="text-2xl font-bold">Eastern Province, Zambia</h1>
        <p className="mt-1 text-sm text-slate-300">
          The medicine is in Chipata. The village posts run out. Every pod visit turns a flagged need into a delivery to that patient&apos;s home. Drones fly at 100 km/h, trucks at 40: one second here is one real minute.
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
          <Link href="/government" className="rounded-lg border border-emerald-700 bg-emerald-950/70 px-3 py-1.5 text-emerald-200 hover:bg-emerald-900">
            Government view
          </Link>
          <Link href="/patients" className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 hover:bg-slate-800">
            Patients
          </Link>
          <span className={`self-center ${connected === "live" ? "text-emerald-300" : "text-amber-300"}`}>
            ● {connected === "live" ? "SpacetimeDB live" : connected === "connecting" ? "connecting…" : "SpacetimeDB offline — run `spacetime start`"}
          </span>
        </div>
      </div>

      <div className="hud absolute bottom-5 right-5 top-14 z-10 flex w-[26rem] flex-col p-4">
        <div className="mb-3 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.25em] text-sky-300/90">
          <span>
            <span className="blink mr-2 inline-block h-2 w-2 rounded-full bg-emerald-400 align-middle" />
            podnet // live feed
          </span>
          <span className="text-slate-500">{feed.length ? feed[0].at : "--:--:--"}</span>
        </div>
        <div className="flex-1 space-y-1 overflow-hidden">
          {feed.map((f) => (
            <div key={f.id} className={`feed ${TONE[f.tone]}`}>
              <span className="stamp">{f.at}</span>
              <span className="msg">{f.text}</span>
            </div>
          ))}
          {!feed.length && <p className="font-mono text-xs text-slate-500">awaiting first patient…</p>}
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
  need: "t-need",
  move: "t-move",
  done: "t-done",
  alert: "t-alert",
  live: "t-live",
  restock: "t-restock",
  agent: "t-agent",
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
    n.innerHTML = `<span class="ic">${d.icon}</span><span class="eta">${d.label}</span>`;
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
.pop.restock{background:#38bdf8;color:#082f49}
.hud{background:linear-gradient(180deg,rgba(2,6,23,.82),rgba(2,6,23,.7));border:1px solid rgba(56,189,248,.25);border-radius:14px;box-shadow:0 0 0 1px rgba(2,6,23,.6),0 0 40px rgba(56,189,248,.08) inset;backdrop-filter:blur(10px);overflow:hidden}
.hud:before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 3px)}
.hud:after{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(56,189,248,.8),transparent)}
.feed{display:grid;grid-template-columns:3.6rem 1fr;gap:.5rem;align-items:start;padding:.4rem .6rem .4rem .7rem;border-left:2px solid var(--c);background:linear-gradient(90deg,color-mix(in srgb,var(--c) 14%,transparent),transparent 70%);font:12.5px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e2e8f0;animation:feedin .35s ease-out;position:relative}
.feed .stamp{color:color-mix(in srgb,var(--c) 85%,white);font-size:10.5px;letter-spacing:.04em;padding-top:1px}
.feed .msg{text-shadow:0 0 12px color-mix(in srgb,var(--c) 45%,transparent)}
.feed:first-child{box-shadow:0 0 18px color-mix(in srgb,var(--c) 35%,transparent)}
.t-need{--c:#fbbf24}.t-move{--c:#38bdf8}.t-done{--c:#34d399}.t-alert{--c:#ef4444}.t-live{--c:#c084fc;font-weight:700}.t-restock{--c:#2dd4bf}.t-agent{--c:#f472b6}
.blink{animation:blink 1.2s steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}
@keyframes floatup{0%{opacity:0;margin-top:-10px;scale:.6}12%{opacity:1;margin-top:-34px;scale:1.1}20%{scale:1}75%{opacity:1}100%{opacity:0;margin-top:-80px}}
.mover{transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:2px}
.mover .ic{font-size:20px;filter:drop-shadow(0 0 6px rgba(56,189,248,.9))}
.far .mover .eta{display:none}
.far .village .name{font-size:9px;padding:1px 4px}
.far .village .pin{font-size:14px}
.mover .eta{font:600 10px/1 ui-monospace,Menlo,monospace;color:#e0f2fe;background:rgba(2,6,23,.8);border:1px solid rgba(56,189,248,.5);padding:2px 5px;border-radius:999px;white-space:nowrap}
@keyframes feedin{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
`;
