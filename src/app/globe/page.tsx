"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";

// Live 3D view of the pod network, fed straight from SpacetimeDB. Nothing on it is pre-made:
// a dot is a health post, and it only lights up when a pod there flags a need. The need becomes
// an order with the patient's name and flies (drone) or drives (truck) from wherever the
// medicine actually is to the patient's home. Click a post to see what it asked for and what
// it sent; the layer buttons show or hide the flights and the hubs.

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
  createdAt: { microsSinceUnixEpoch: bigint };
  departedAt?: { microsSinceUnixEpoch: bigint };
};
type Pod = { villageId: number; status: string; step: string; language: string; online: boolean; lastSeen: { microsSinceUnixEpoch: bigint } };
type FeedItem = { id: number; at: string; text: string; tone: "need" | "move" | "done" | "alert" | "live" | "restock" | "agent" };
type Marker =
  | { kind: "village"; v: Village; lat: number; lng: number; state: "quiet" | "active" | "picked"; online: boolean }
  | { kind: "pop"; id: number; lat: number; lng: number; text: string; tone: string }
  | { kind: "mover"; id: string; lat: number; lng: number; mode: string; label: string };
type Layers = { flights: boolean; hubs: boolean; labels: boolean };

let feedSeq = 0;
const short = (name: string) => name.replace(/ \(.*\)$/, "");
const plain = (text: string) => text.replace(/[\p{Extended_Pictographic}️]/gu, "").trim();

export default function GlobePage() {
  const el = useRef<HTMLDivElement>(null);
  const globeRef = useRef<import("globe.gl").GlobeInstance | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const villages = useRef(new Map<number, Village>());
  const pops = useRef<Marker[]>([]);
  const movers = useRef(new Map<string, Marker & { kind: "mover" }>());
  const villageMarkers = useRef<Marker[]>([]);
  const activeIds = useRef(new Set<number>());
  const onlineIds = useRef(new Set<number>()); // posts with a pod switched on right now
  const pickedRef = useRef<Village | null>(null);
  const layersRef = useRef<Layers>({ flights: true, hubs: true, labels: false });
  const [connected, setConnected] = useState<"connecting" | "live" | "offline">("connecting");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [kpi, setKpi] = useState({ posts: 0, visits: 0, live: 0, orders: 0, flying: 0, delivered: 0 });
  const [simulate, setSimulate] = useState(false);
  const [layers, setLayers] = useState<Layers>(layersRef.current);
  const [picked, setPicked] = useState<Village | null>(null);
  const [stockOf, setStockOf] = useState<{ item: string; qty: number }[]>([]);
  const [asked, setAsked] = useState<Order[]>([]);
  const [sent, setSent] = useState<Order[]>([]);
  const [podHere, setPodHere] = useState<Pod | null>(null);

  const push = (text: string, tone: FeedItem["tone"]) =>
    setFeed((f) => [{ id: ++feedSeq, at: new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }), text: plain(text), tone }, ...f].slice(0, 40));
  const vname = (id: number) => short(villages.current.get(id)?.name ?? `#${id}`);

  // Rebuild the village markers (their state decides colour and label).
  const rebuildVillages = () => {
    const p = pickedRef.current;
    villageMarkers.current = [...villages.current.values()].map((v) => ({
      kind: "village" as const,
      v,
      lat: v.lat,
      lng: v.lng,
      state: p?.id === v.id ? "picked" : activeIds.current.has(v.id) ? "active" : "quiet",
      online: onlineIds.current.has(v.id),
    }));
  };

  const lastPickAt = useRef(0);
  const pick = (v: Village | null) => {
    if (v) lastPickAt.current = Date.now();
    else if (Date.now() - lastPickAt.current < 500) return; // the globe's own click lands right after the dot's
    pickedRef.current = v;
    setPicked(v);
    rebuildVillages();
    if (v) globeRef.current?.pointOfView({ lat: v.lat, lng: v.lng, altitude: 0.09 }, 900);
    redrawArcs();
  };

  const setLayer = (k: keyof Layers, on: boolean) => {
    layersRef.current = { ...layersRef.current, [k]: on };
    setLayers(layersRef.current);
    el.current?.classList.toggle("no-hubs", !layersRef.current.hubs);
    el.current?.classList.toggle("all-labels", layersRef.current.labels);
    redrawArcs();
  };

  const redrawArcs = () => {
    const conn = connRef.current, g = globeRef.current;
    if (!conn || !g) return;
    const p = pickedRef.current;
    const orders = [...conn.db.deliveryOrder.iter()] as Order[];
    const arcs = layersRef.current.flights
      ? orders
          .filter((o) => o.status !== "delivered" && o.mode !== "walk")
          .filter((o) => !p || o.toVillageId === p.id || o.fromVillageId === p.id)
          .map((o) => ({ a: villages.current.get(o.fromVillageId), b: villages.current.get(o.toVillageId), mode: o.mode, kind: o.kind }))
          .filter((x) => x.a && x.b)
      : [];
    g.arcsData(arcs);
  };

  // ---- globe ----
  useEffect(() => {
    let raf = 0;
    let disposed = false;
    // Size the canvas to its box (a window resize event alone misses zoom and pane changes).
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
        .htmlAltitude((d: object) => ((d as Marker).kind === "mover" ? 0.02 : (d as Marker).kind === "pop" ? 0.01 : 0.003))
        .htmlElement((d: object) => markerEl(d as Marker, (v) => pick(v)))
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
      setTimeout(() => g.pointOfView({ lat: -13.3, lng: 32.2, altitude: 0.22 }, 4200), 700);
      g.controls().autoRotate = false;
      g.controls().zoomSpeed = 1.2;
      g.onGlobeClick(() => pick(null));
      globeRef.current = g;
      fit();
      (window as unknown as { __globe?: unknown }).__globe = g; // for debugging from the console

      // Movers (drones/trucks) glide between posts; refresh markers a few times a second.
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
          const p = pickedRef.current;
          for (const o of conn.db.deliveryOrder.iter() as Iterable<Order>) {
            const key = String(o.id);
            const mine = !p || o.toVillageId === p.id || o.fromVillageId === p.id;
            if (!layersRef.current.flights || !mine || o.status !== "on_the_way" || o.mode === "walk" || !o.departedAt) {
              movers.current.delete(key);
              continue;
            }
            const a = villages.current.get(o.fromVillageId), b = villages.current.get(o.toVillageId);
            if (!a || !b) continue;
            const t = Math.min(1, Number(nowUs - o.departedAt.microsSinceUnixEpoch) / 1e6 / o.travelSeconds);
            const m = movers.current.get(key) ?? { kind: "mover" as const, id: key, lat: a.lat, lng: a.lng, mode: o.mode, label: "" };
            m.lat = a.lat + (b.lat - a.lat) * t;
            m.lng = a.lng + (b.lng - a.lng) * t;
            m.label = `${o.item} · ${Math.max(1, Math.round(o.etaMinutes * (1 - t)))} min`;
            movers.current.set(key, m);
          }
        }
        const alt = g.pointOfView()?.altitude ?? 1;
        el.current?.classList.toggle("far", alt > 0.16); // ETA tags and small labels only once you zoom in
        el.current?.classList.toggle("near", alt < 0.11);
        g.htmlElementsData([...villageMarkers.current, ...pops.current, ...movers.current.values()]);
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

  // ---- SpacetimeDB ----
  useEffect(() => {
    const refreshKpis = (conn: DbConnection) => {
      const visits = [...conn.db.visit.iter()];
      const orders = [...conn.db.deliveryOrder.iter()] as Order[];
      const pods = [...conn.db.pod.iter()] as Pod[];
      onlineIds.current = new Set(pods.filter((p) => p.online).map((p) => p.villageId));
      setKpi({
        posts: villages.current.size,
        visits: visits.length,
        live: onlineIds.current.size,
        orders: orders.length,
        flying: orders.filter((o) => o.status === "on_the_way").length,
        delivered: orders.filter((o) => o.status === "delivered").length,
      });
      // A post is "active" while it has an order open or asked for something recently.
      const active = new Set<number>();
      for (const o of orders) if (o.status !== "delivered") active.add(o.toVillageId);
      for (const v of visits) if (v.fromPod) active.add(v.villageId);
      activeIds.current = active;
      rebuildVillages();
      redrawArcs();
      const s = [...conn.db.settings.iter()][0];
      if (s) setSimulate(s.simulate);
    };

    const syncVillages = (conn: DbConnection) => {
      villages.current = new Map([...conn.db.village.iter()].map((v) => [v.id, v as Village]));
      rebuildVillages();
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
          .subscribe(["SELECT * FROM village", "SELECT * FROM stock", "SELECT * FROM visit", "SELECT * FROM delivery_order", "SELECT * FROM settings", "SELECT * FROM pop", "SELECT * FROM agent_log", "SELECT * FROM pod"]);
      })
      .onConnectError(() => setConnected("offline"))
      .onDisconnect(() => setConnected("offline"))
      .build();
    connRef.current = conn;

    conn.db.village.onInsert(() => syncVillages(conn));
    conn.db.settings.onUpdate(() => refreshKpis(conn));
    // A pod switching on or off: the ring on its post, the "live pods" count, a feed line.
    conn.db.pod.onInsert((_ctx, p) => {
      refreshKpis(conn);
      if (p.online) push(`POD ONLINE ▸ ${vname(p.villageId)}`, "live");
    });
    conn.db.pod.onUpdate((_ctx, old, p) => {
      if (old.online !== p.online) {
        refreshKpis(conn);
        push(p.online ? `POD ONLINE ▸ ${vname(p.villageId)}` : `POD OFF ▸ ${vname(p.villageId)}`, "live");
      }
    });
    conn.db.pod.onDelete(() => refreshKpis(conn));
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
      pops.current.push({ kind: "pop", id, lat: v.lat, lng: v.lng, text: plain(p.text), tone });
      setTimeout(() => (pops.current = pops.current.filter((x) => x.kind !== "pop" || x.id !== id)), 2600);
      const g = globeRef.current;
      if (g) {
        const ring = { lat: v.lat, lng: v.lng, rgb: tone === "done" ? "52,211,153" : tone === "alert" ? "239,68,68" : tone === "restock" ? "56,189,248" : "251,191,36" };
        g.ringsData([...(g.ringsData() as object[]), ring]);
        setTimeout(() => g.ringsData((g.ringsData() as object[]).filter((r) => r !== ring)), 2200);
      }
      if (tone === "done") push(`DELIVERED ▸ ${p.text} · ${vname(p.villageId)}`, "done");
      else if (tone === "alert") push(`ALERT ▸ ${p.text} · ${vname(p.villageId)}`, "alert");
      else if (tone === "need") push(`NEED ▸ ${p.text} · ${vname(p.villageId)}`, "need");
    });
    return () => conn.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the post you clicked holds, asked for, and sent.
  useEffect(() => {
    const conn = connRef.current;
    if (!picked || !conn) return;
    const read = () => {
      setStockOf([...conn.db.stock.iter()].filter((s) => s.villageId === picked.id).map((s) => ({ item: s.item, qty: s.qty })));
      const orders = ([...conn.db.deliveryOrder.iter()] as Order[]).sort((a, b) => Number(b.id - a.id));
      setAsked(orders.filter((o) => o.toVillageId === picked.id).slice(0, 12));
      setSent(orders.filter((o) => o.fromVillageId === picked.id && o.toVillageId !== picked.id).slice(0, 12));
      setPodHere(([...conn.db.pod.iter()] as Pod[]).find((p) => p.villageId === picked.id) ?? null);
    };
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, [picked]);

  const conn = connRef.current;
  const low = stockOf.filter((s) => s.qty < 5);
  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-slate-100">
      <style>{CSS}</style>
      <div ref={el} className="absolute inset-0 far no-labels" />

      <div className="pointer-events-none absolute left-5 top-14 z-10 max-w-md">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-300">Pod network · live</p>
        <h1 className="text-2xl font-bold">Eastern Province, Zambia</h1>
        <p className="mt-1 text-sm text-slate-300">
          Every dot is a health post. A post lights up only when a pod there flags a need; the order then flies from wherever the medicine is to that patient&apos;s home. Drones 100 km/h, trucks 40: one second here is one real minute.
        </p>
        <div className="pointer-events-auto mt-4 grid grid-cols-6 gap-2 text-center">
          <Kpi label="posts" value={kpi.posts} tone="text-slate-200" />
          <Kpi label="patients" value={kpi.visits} />
          <Kpi label="live pods" value={kpi.live} tone="text-sky-300" />
          <Kpi label="orders" value={kpi.orders} tone="text-amber-300" />
          <Kpi label="moving" value={kpi.flying} tone="text-sky-300" />
          <Kpi label="delivered" value={kpi.delivered} tone="text-emerald-300" />
        </div>
        <div className="pointer-events-auto mt-3 flex flex-wrap gap-2 text-xs">
          <span className="self-center font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">layers</span>
          <Toggle on={layers.flights} onClick={() => setLayer("flights", !layers.flights)} label="Flights & routes" />
          <Toggle on={layers.hubs} onClick={() => setLayer("hubs", !layers.hubs)} label="Hubs" />
          <Toggle on={layers.labels} onClick={() => setLayer("labels", !layers.labels)} label="All names" />
        </div>
        <div className="pointer-events-auto mt-2 flex flex-wrap gap-2 text-xs">
          <Toggle on={simulate} onClick={() => conn?.reducers.setSimulation({ on: !simulate })} label={simulate ? "Simulated visits: on" : "Simulated visits: off"} warn />
          <button onClick={() => conn?.reducers.resetDemo({})} className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 hover:bg-slate-800">
            Reset
          </button>
          <Link href="/kiosk?village=Katete" className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 hover:bg-slate-800">
            Open a pod
          </Link>
          <Link href="/government" className="rounded-lg border border-emerald-700 bg-emerald-950/70 px-3 py-1.5 text-emerald-200 hover:bg-emerald-900">
            Government view
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
          {!feed.length && (
            <p className="font-mono text-xs leading-relaxed text-slate-500">
              quiet. nothing here is pre-made: the first line appears when a pod in one of the {kpi.posts || 40} posts flags a need.
            </p>
          )}
        </div>
      </div>

      {picked && (
        <div className="absolute bottom-5 left-5 z-10 max-h-[60vh] w-[22rem] overflow-y-auto rounded-2xl border border-slate-700/70 bg-slate-950/90 p-4 backdrop-blur">
          <div className="flex items-baseline justify-between">
            <p className="font-semibold">{short(picked.name)}</p>
            <button onClick={() => pick(null)} className="text-slate-400">✕</button>
          </div>
          <p className="text-xs text-slate-400">
            {picked.hub ? "Regional hub · full shelves" : `Health post · ${picked.population.toLocaleString()} people`} · {picked.lat.toFixed(2)}, {picked.lng.toFixed(2)}
          </p>
          <div className="mt-3 flex gap-2 text-xs">
            <Link href={`/kiosk?village=${encodeURIComponent(short(picked.name))}`} className="rounded-lg border border-sky-700 bg-sky-950/70 px-3 py-1.5 text-sky-200 hover:bg-sky-900">
              Open the pod here
            </Link>
          </div>
          <PodNow pod={podHere} />

          <Section title={`Asked for · ${asked.length}`}>
            {asked.length ? asked.map((o) => <OrderRow key={String(o.id)} o={o} other={vname(o.fromVillageId)} dir="from" />) : <Empty>no requests yet — a pod visit here would be the first</Empty>}
          </Section>
          <Section title={`Sent from here · ${sent.length}`}>
            {sent.length ? sent.map((o) => <OrderRow key={String(o.id)} o={o} other={o.kind === "restock" ? `${vname(o.toVillageId)} post` : `${o.patientName}, ${vname(o.toVillageId)}`} dir="to" />) : <Empty>nothing sent from here</Empty>}
          </Section>
          <Section title={`On the shelf · ${low.length} low`}>
            <div className="grid grid-cols-2 gap-x-3">
              {stockOf.map((s) => (
                <div key={s.item} className="flex justify-between gap-2 text-[12px] leading-5">
                  <span className="truncate text-slate-300">{s.item}</span>
                  <span className={`tabular-nums ${s.qty <= 0 ? "text-red-400" : s.qty < 5 ? "text-amber-300" : "text-emerald-300"}`}>{s.qty}</span>
                </div>
              ))}
            </div>
          </Section>
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

function Toggle({ on, onClick, label, warn = false }: { on: boolean; onClick: () => void; label: string; warn?: boolean }) {
  const tone = on ? (warn ? "border-amber-500 bg-amber-950/70 text-amber-200" : "border-sky-500 bg-sky-950/70 text-sky-100") : "border-slate-600 bg-slate-900/80 text-slate-300";
  return (
    <button onClick={onClick} className={`rounded-lg border px-3 py-1.5 hover:brightness-125 ${tone}`}>
      <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${on ? (warn ? "bg-amber-400" : "bg-sky-400") : "bg-slate-600"}`} />
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">{title}</p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-slate-500">{children}</p>;
}

// What the pod at this post is doing right now, from its heartbeats.
const STEP_LABEL: Record<string, string> = { name: "asking the name", community: "asking the community", who: "asking who the patient is", complaint: "asking what brought them in" };
function PodNow({ pod }: { pod: Pod | null }) {
  if (!pod || !pod.online) return <Section title="Pod here"><Empty>{pod ? "pod switched off" : "no pod switched on here"}</Empty></Section>;
  const what = pod.status === "listening" ? "listening to the patient" : pod.status === "thinking" ? "working out the next question" : pod.status === "speaking" ? "speaking" : "waiting for a patient";
  const step = pod.step ? (STEP_LABEL[pod.step] ?? (pod.step.startsWith("test:") ? `physical test: ${pod.step.slice(5).replaceAll("_", " ")}` : `about ${pod.step.replaceAll("_", " ")}`)) : "";
  const seen = Math.max(0, Math.round((Date.now() - Number(pod.lastSeen.microsSinceUnixEpoch / BigInt(1000))) / 1000));
  return (
    <Section title="Pod here · online">
      <div className="flex items-baseline justify-between gap-2 text-[12px] leading-5">
        <span>
          <span className="online-dot mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-400 align-middle" />
          <span className="text-slate-100">{what}</span>
          {step && <span className="text-slate-400"> · {step}</span>}
          {pod.language && <span className="text-slate-500"> · {pod.language}</span>}
        </span>
        <span className="shrink-0 tabular-nums text-slate-500">{seen}s ago</span>
      </div>
    </Section>
  );
}

function OrderRow({ o, other, dir }: { o: Order; other: string; dir: "from" | "to" }) {
  const status = o.status === "delivered" ? "delivered" : o.status === "on_the_way" ? `${o.mode === "drone" ? "drone" : "truck"} · ${o.etaMinutes} min` : o.mode === "walk" ? "from the shelf" : "packing";
  const tone = o.status === "delivered" ? "text-emerald-300" : o.status === "on_the_way" ? "text-sky-300" : "text-amber-300";
  return (
    <div className="flex items-baseline justify-between gap-2 border-l-2 border-slate-700 py-0.5 pl-2 text-[12px] leading-4">
      <span className="truncate">
        <span className="text-slate-100">{o.qty > 1 ? `${o.qty} ` : ""}{o.item}</span>
        <span className="text-slate-500"> {dir === "from" ? (o.kind === "restock" ? "for the post" : `for ${o.patientName}`) : `→ ${other}`}{dir === "from" && o.mode !== "walk" ? ` · ${o.mode === "drone" ? "drone" : "truck"} from ${other}` : ""}</span>
      </span>
      <span className={`shrink-0 tabular-nums ${tone}`}>{status}</span>
    </div>
  );
}

// Markers: a dot per post (bigger ring for the hub), floating "+1" bubbles, small drones and trucks.
function markerEl(d: Marker, onPick: (v: Village) => void): HTMLElement {
  const n = document.createElement("div");
  if (d.kind === "village") {
    const big = d.v.hub || d.v.population >= 6000;
    n.className = `village ${d.v.hub ? "hub" : ""} ${big ? "big" : "small"} ${d.state} ${d.online ? "online" : ""}`;
    n.innerHTML = `<span class="dot"></span><span class="name">${short(d.v.name)}</span>`;
    n.style.pointerEvents = "auto";
    n.onclick = (e) => {
      e.stopPropagation();
      onPick(d.v);
    };
  } else if (d.kind === "pop") {
    n.className = `pop ${d.tone}`;
    n.textContent = d.text;
  } else {
    n.className = `mover ${d.mode}`;
    n.innerHTML = `<span class="ic"></span><span class="eta">${d.label}</span>`;
  }
  return n;
}

const CSS = `
.village{display:flex;align-items:center;gap:5px;transform:translate(-50%,-50%);cursor:pointer;white-space:nowrap}
.village .dot{width:7px;height:7px;border-radius:999px;background:#cbd5e1;box-shadow:0 0 0 2px rgba(2,6,23,.8),0 0 8px rgba(148,163,184,.6);transition:all .25s}
.village.big .dot{width:9px;height:9px}
.village.hub .dot{width:13px;height:13px;background:#34d399;box-shadow:0 0 0 3px rgba(2,6,23,.85),0 0 0 5px rgba(52,211,153,.55),0 0 16px rgba(52,211,153,.8)}
.village.active .dot{background:#fbbf24;box-shadow:0 0 0 2px rgba(2,6,23,.85),0 0 0 4px rgba(251,191,36,.45),0 0 14px rgba(251,191,36,.9);animation:pulse 1.4s ease-in-out infinite}
.village.picked .dot{background:#38bdf8;box-shadow:0 0 0 2px rgba(2,6,23,.85),0 0 0 5px rgba(56,189,248,.55),0 0 18px rgba(56,189,248,1)}
.village.online .dot{position:relative}
.village.online .dot:after{content:"";position:absolute;inset:-6px;border-radius:999px;border:1.5px solid #34d399;box-shadow:0 0 8px rgba(52,211,153,.9);animation:ring 1.8s ease-out infinite}
.village.online.small .name{display:inline}
@keyframes ring{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.6);opacity:0}}
.online-dot{animation:pulse 1.4s ease-in-out infinite}
.village .name{font:600 11px/1.2 system-ui;color:#e2e8f0;background:rgba(2,6,23,.72);border:1px solid rgba(148,163,184,.35);padding:2px 6px;border-radius:999px}
.village.hub .name{border-color:#34d399;color:#a7f3d0}
.village.active .name{border-color:#fbbf24;color:#fde68a}
.village.picked .name{border-color:#38bdf8;color:#e0f2fe}
.far .village.small .name{display:none}
.far .village.small.active .name,.far .village.small.picked .name{display:inline}
.far .village .name{font-size:9.5px;padding:1px 5px}
.no-hubs .village.hub .dot{background:#cbd5e1;box-shadow:0 0 0 2px rgba(2,6,23,.8);width:7px;height:7px}
.no-hubs .village.hub .name{border-color:rgba(148,163,184,.35);color:#e2e8f0}
.all-labels .village .name{display:inline!important}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.35)}}
.pop{z-index:999!important;font:800 14px/1 system-ui;padding:5px 10px;border:1.5px solid rgba(255,255,255,.85);border-radius:999px;white-space:nowrap;animation:floatup 2.6s ease-out forwards;box-shadow:0 4px 14px rgba(0,0,0,.5)}
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
.mover{transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:3px}
.mover .ic{display:block;width:12px;height:12px;background:#38bdf8;clip-path:polygon(50% 0,100% 100%,50% 75%,0 100%);filter:drop-shadow(0 0 6px rgba(56,189,248,1))}
.mover.road .ic{width:11px;height:9px;background:#c4b5fd;clip-path:none;border-radius:2px;filter:drop-shadow(0 0 6px rgba(167,139,250,1))}
.far .mover .eta{display:none}
.mover .eta{font:600 10px/1 ui-monospace,Menlo,monospace;color:#e0f2fe;background:rgba(2,6,23,.8);border:1px solid rgba(56,189,248,.5);padding:2px 5px;border-radius:999px;white-space:nowrap}
@keyframes feedin{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
`;
