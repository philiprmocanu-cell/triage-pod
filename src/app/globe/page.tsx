"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";
import { SettlementIndex, catchments, earthUrl, fmtPeople, kindOf, kmBetween, mapsSatelliteUrl, nameOf, servedBy, type Catchment, type Settlement, type SettlementSources } from "@/lib/settlements/geo";

// Live 3D view of the pod network, fed straight from SpacetimeDB. Nothing on it is pre-made:
// a dot is a health post, and it only lights up when a pod there flags a need. The need becomes
// an order with the patient's name and flies (drone) or drives (truck, along the planned road)
// from wherever the medicine actually is to the patient's home. Click a post to see what it asked
// for and what it sent; the layer buttons show or hide the flights, the hubs and the villages.
//
// Under the posts, every settlement in the province (tens of thousands: GeoNames names plus
// Google Open Buildings roof clusters, see tools/settlements/fetch.py) is drawn as a tiny dot with
// the particles layer — one GPU draw, no DOM. Hover shows the name, a click opens the post that
// serves it. Everything sits at ground level (altitude 0) so dots stay on their pixel when the
// camera tilts or zooms; the HTML markers keep their element between frames and only the movers'
// positions are written per frame.

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
type Plan = { id: bigint; orderId: bigint; carrierId: number; waypoints: string; km: number; minutes: number; floodRisk: string; status: string; reason: string };
type Carrier = { id: number; name: string; kind: string; operator: string; status: string };
type FeedItem = { id: number; at: string; text: string; tone: "need" | "move" | "done" | "alert" | "live" | "restock" | "agent" };
type VillageMarker = { kind: "village"; v: Village; lat: number; lng: number; state: "quiet" | "active" | "picked"; online: boolean; el?: HTMLElement };
type MoverMarker = { kind: "mover"; id: string; lat: number; lng: number; mode: string; label: string; el?: HTMLElement };
type Marker =
  | VillageMarker
  | { kind: "pop"; id: number; lat: number; lng: number; text: string; tone: string }
  | MoverMarker
  | { kind: "pin"; lat: number; lng: number };
type Layers = { flights: boolean; hubs: boolean; labels: boolean; villages: boolean; pin: boolean };
// A planned road, ready to draw and to walk a mover along.
type RoadPath = { key: string; pts: [number, number][]; cum: number[]; total: number; mode: string; flood: string; moving: boolean; orderId: string };
type Pin = { lat: number; lng: number; hamlet: (Settlement & { km: number }) | null; post: { v: Village; km: number } | null };
type PickedSettlement = { s: Settlement; served: { post: Village; km: number } | null };

let feedSeq = 0;
const short = (name: string) => name.replace(/ \(.*\)$/, "");
const plain = (text: string) => text.replace(/[\p{Extended_Pictographic}️]/gu, "").trim();
const GLOBE_R = 100; // three-globe's sphere radius, for writing marker positions in place
const polar2Cartesian = (lat: number, lng: number, alt = 0) => {
  const phi = ((90 - lat) * Math.PI) / 180, theta = ((90 - lng) * Math.PI) / 180, r = GLOBE_R * (1 + alt);
  return { x: r * Math.sin(phi) * Math.cos(theta), y: r * Math.cos(phi), z: r * Math.sin(phi) * Math.sin(theta) };
};
// How many km one screen pixel covers at this camera altitude (fov 50°, view height in px).
const kmPerPx = (alt: number, heightPx: number) => (2 * alt * GLOBE_R * Math.tan((25 * Math.PI) / 180) * 63.71) / Math.max(1, heightPx);
const ALT_MOVER = 0.0025, ALT_POP = 0.002, ALT_PIN = 0;

export default function GlobePage() {
  const el = useRef<HTMLDivElement>(null);
  const globeRef = useRef<import("globe.gl").GlobeInstance | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const villages = useRef(new Map<number, Village>());
  const pops = useRef<Marker[]>([]);
  const movers = useRef(new Map<string, MoverMarker>());
  const villageMarkers = useRef(new Map<number, VillageMarker>()); // stable objects: the DOM node lives as long as the post
  const markersDirty = useRef(true); // set when the SET of markers changes; positions of movers are written in place
  const activeIds = useRef(new Set<number>());
  const onlineIds = useRef(new Set<number>()); // posts with a pod switched on right now
  const pickedRef = useRef<Village | null>(null);
  const layersRef = useRef<Layers>({ flights: true, hubs: true, labels: false, villages: true, pin: false });
  const roads = useRef(new Map<string, RoadPath>()); // by plan key, so globe.gl keeps the same path object between redraws
  const roadByOrder = useRef(new Map<string, RoadPath>());
  const settlements = useRef<Settlement[]>([]);
  const index = useRef<SettlementIndex | null>(null);
  const catchRef = useRef<{ assign: Int32Array; byPost: Map<number, Catchment> } | null>(null);
  const pinRef = useRef<Pin | null>(null);
  const [connected, setConnected] = useState<"connecting" | "live" | "offline">("connecting");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [kpi, setKpi] = useState({ posts: 0, visits: 0, live: 0, orders: 0, flying: 0, delivered: 0 });
  const [simulate, setSimulate] = useState(false);
  const [layers, setLayers] = useState<Layers>(layersRef.current);
  const [picked, setPicked] = useState<Village | null>(null);
  const [pickedSettlement, setPickedSettlement] = useState<PickedSettlement | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [catchment, setCatchment] = useState<Catchment | null>(null);
  const [villageCount, setVillageCount] = useState<{ n: number; sources: SettlementSources | null }>({ n: 0, sources: null });
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const [stockOf, setStockOf] = useState<{ item: string; qty: number }[]>([]);
  const [asked, setAsked] = useState<Order[]>([]);
  const [sent, setSent] = useState<Order[]>([]);
  const [podHere, setPodHere] = useState<Pod | null>(null);
  const [carriers, setCarriers] = useState<Map<number, Carrier>>(new Map());
  const [plansOf, setPlansOf] = useState<Plan[]>([]);

  const push = (text: string, tone: FeedItem["tone"]) =>
    setFeed((f) => [{ id: ++feedSeq, at: new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }), text: plain(text), tone }, ...f].slice(0, 40));
  const vname = (id: number) => short(villages.current.get(id)?.name ?? `#${id}`);
  const posts = () => [...villages.current.values()].map((v) => ({ id: v.id, name: v.name, lat: v.lat, lng: v.lng }));

  // Update each post marker's state in place (colour and label come from the class), no new objects.
  const rebuildVillages = () => {
    const p = pickedRef.current;
    for (const [id, v] of villages.current) {
      let m = villageMarkers.current.get(id);
      if (!m) {
        m = { kind: "village", v, lat: v.lat, lng: v.lng, state: "quiet", online: false };
        villageMarkers.current.set(id, m);
        markersDirty.current = true;
      }
      m.v = v;
      m.state = p?.id === v.id ? "picked" : activeIds.current.has(v.id) ? "active" : "quiet";
      m.online = onlineIds.current.has(v.id);
      if (m.el) m.el.className = villageClass(m);
    }
    for (const id of [...villageMarkers.current.keys()]) if (!villages.current.has(id)) { villageMarkers.current.delete(id); markersDirty.current = true; }
  };

  // Which post serves which settlement, and the totals per post — once both lists are in.
  const recomputeCatchments = () => {
    if (!settlements.current.length || !villages.current.size) return;
    catchRef.current = catchments(settlements.current, posts());
    const p = pickedRef.current;
    setCatchment(p ? catchRef.current.byPost.get(p.id) ?? null : null);
  };

  const lastPickAt = useRef(0);
  const pick = (v: Village | null, focus?: { lat: number; lng: number }, keepSettlement = false) => {
    if (v) lastPickAt.current = Date.now();
    else if (Date.now() - lastPickAt.current < 500) return; // the globe's own click lands right after the dot's
    pickedRef.current = v;
    setPicked(v);
    if (!keepSettlement) setPickedSettlement(null);
    setCatchment(v && catchRef.current ? catchRef.current.byPost.get(v.id) ?? null : null);
    rebuildVillages();
    // Fly to the exact dot, close enough that zooming further lands on the village itself.
    const f = focus ?? (v ? { lat: v.lat, lng: v.lng } : null);
    if (f) globeRef.current?.pointOfView({ lat: f.lat, lng: f.lng, altitude: focus ? 0.012 : 0.02 }, 900);
    redrawRoutes();
  };

  // A settlement dot was clicked: open the post that serves it, centred on the village.
  const pickSettlement = (s: Settlement) => {
    const served = servedBy(s, posts());
    const post = served ? villages.current.get(served.post.id) ?? null : null;
    setPickedSettlement({ s, served: post && served ? { post, km: served.km } : null });
    setPin(null); pinRef.current = null; markersDirty.current = true;
    pick(post, { lat: s.la, lng: s.ln }, true);
  };

  const dropPin = (lat: number, lng: number) => {
    const hamlet = index.current?.nearest(lat, lng, 15) ?? null;
    let post: Pin["post"] = null;
    for (const v of villages.current.values()) {
      const km = kmBetween(lat, lng, v.lat, v.lng);
      if (!post || km < post.km) post = { v, km };
    }
    const p: Pin = { lat, lng, hamlet: hamlet ? { ...hamlet } : null, post };
    pinRef.current = p;
    setPin(p);
    markersDirty.current = true;
    lastPickAt.current = Date.now();
    pickedRef.current = null; setPicked(null); setPickedSettlement(null); rebuildVillages(); redrawRoutes();
  };
  const clearPin = () => { pinRef.current = null; setPin(null); markersDirty.current = true; };

  const setLayer = (k: keyof Layers, on: boolean) => {
    layersRef.current = { ...layersRef.current, [k]: on };
    setLayers(layersRef.current);
    el.current?.classList.toggle("no-hubs", !layersRef.current.hubs);
    el.current?.classList.toggle("all-labels", layersRef.current.labels);
    el.current?.classList.toggle("pin-mode", layersRef.current.pin);
    if (k === "villages") drawSettlements();
    redrawRoutes();
  };

  // The settlement dots: four particle groups by size (roofs), so a bigger village is a bigger
  // dot. Sizes are in globe units with perspective, so a hamlet is under a pixel from far out and
  // a few pixels up close; the opacity follows the zoom band (23,000 dots over a province-sized
  // patch of screen would otherwise fill it white). Band changes only touch the material.
  const band = useRef<"far" | "mid" | "near">("far");
  const drawSettlements = () => {
    const g = globeRef.current;
    if (!g) return;
    if (!layersRef.current.villages || !settlements.current.length) { g.particlesData([]); return; }
    const small: Settlement[] = [], mid: Settlement[] = [], big: Settlement[] = [], town: Settlement[] = [];
    for (const s of settlements.current) {
      const h = s.h ?? (s.n ? 20 : 3);
      (h >= 1500 ? town : h >= 150 ? big : h >= 25 ? mid : small).push(s);
    }
    g.particlesData([
      { list: small, size: 0.011, tone: 0 },
      { list: mid, size: 0.017, tone: 1 },
      { list: big, size: 0.026, tone: 2 },
      { list: town, size: 0.042, tone: 3 },
    ]);
    restyleSettlements();
  };
  const restyleSettlements = () => {
    const g = globeRef.current;
    if (!g) return;
    const b = band.current;
    const scale = b === "far" ? 1 : b === "mid" ? 0.8 : 0.55;
    const alpha = b === "far" ? [0.22, 0.3, 0.45, 0.7] : b === "mid" ? [0.4, 0.5, 0.65, 0.85] : [0.6, 0.7, 0.8, 0.9];
    g.particlesSize((d: object) => (d as { size: number }).size * scale);
    g.particlesColor((d: object) => `rgba(${(d as { tone: number }).tone >= 2 ? "248,250,252" : "226,232,240"},${alpha[(d as { tone: number }).tone]})`);
  };

  // Routes: a planned road is drawn as the road (pathsData); drones, and road orders the planner
  // has not touched yet, keep the arc. Only open orders, only when the layer is on, and only the
  // picked post's when one is picked.
  const redrawRoutes = () => {
    const conn = connRef.current, g = globeRef.current;
    if (!conn || !g) return;
    const p = pickedRef.current;
    const orders = [...conn.db.deliveryOrder.iter()] as Order[];
    const orderById = new Map(orders.map((o) => [String(o.id), o]));
    const mine = (o: Order) => !p || o.toVillageId === p.id || o.fromVillageId === p.id;
    const paths: RoadPath[] = [];
    const planned = new Set<string>();
    const seen = new Set<string>();
    roadByOrder.current.clear();
    if (layersRef.current.flights) {
      for (const plan of conn.db.routePlan.iter() as Iterable<Plan>) {
        const o = orderById.get(String(plan.orderId));
        if (!o || plan.status === "done" || o.status === "delivered") continue;
        const key = `${plan.id}:${plan.status}:${plan.waypoints.length}:${o.mode}`;
        let r = roads.current.get(key);
        if (!r) {
          const pts = parseWaypoints(plan.waypoints);
          if (pts.length < 2) continue;
          const cum = [0];
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + kmBetween(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
          r = { key, pts, cum, total: cum[cum.length - 1], mode: o.mode, flood: plan.floodRisk, moving: plan.status === "moving" || o.status === "on_the_way", orderId: String(o.id) };
          roads.current.set(key, r);
        }
        seen.add(key);
        roadByOrder.current.set(r.orderId, r);
        planned.add(r.orderId);
        if (mine(o)) paths.push(r);
      }
    }
    for (const key of [...roads.current.keys()]) if (!seen.has(key)) roads.current.delete(key);
    g.pathsData(paths);
    const arcs = layersRef.current.flights
      ? orders
          .filter((o) => o.status !== "delivered" && o.mode !== "walk" && !planned.has(String(o.id)))
          .filter(mine)
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
        // Posts and pins sit ON the ground; anything above it parallaxes away from its spot when the camera tilts.
        .htmlAltitude((d: object) => ((d as Marker).kind === "mover" ? ALT_MOVER : (d as Marker).kind === "pop" ? ALT_POP : (d as Marker).kind === "pin" ? ALT_PIN : 0))
        .htmlTransitionDuration(0)
        .htmlElement((d: object) => markerEl(d as Marker, (v) => pick(v)))
        .particlesData([])
        .particlesList("list")
        .particleLat("la")
        .particleLng("ln")
        .particleAltitude(0.0012)
        .particlesSize("size")
        .particlesSizeAttenuation(true)
        .particlesColor("rgba(226,232,240,0.5)")
        .particlesTexture(dotTexture(THREE))
        .particleLabel(() => "") // the dots' names come from settlementAt(); globe.gl's own particle tooltip would read `.name` of nothing
        .pathsData([])
        .pathPoints("pts")
        .pathPointLat((p: object) => (p as [number, number])[0])
        .pathPointLng((p: object) => (p as [number, number])[1])
        .pathPointAlt(0.0015)
        .pathColor((d: object) => roadColor(d as RoadPath))
        .pathStroke(0.028)
        .pathDashLength((d: object) => ((d as RoadPath).moving ? 0.08 : 1))
        .pathDashGap((d: object) => ((d as RoadPath).moving ? 0.05 : 0))
        .pathDashAnimateTime((d: object) => ((d as RoadPath).moving ? 2600 : 0))
        .pathTransitionDuration(0)
        .pathLabel((d: object) => {
          const r = d as RoadPath;
          return `<div class="tip">${r.mode === "drone" ? "drone" : "road"} · ${r.total.toFixed(0)} km · flood risk ${r.flood}${r.moving ? " · moving" : ""}</div>`;
        })
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
      // The 23k-dot particle mesh would otherwise catch every click near a village; let clicks
      // fall through to the ground, where settlementAt() finds the dot under the cursor exactly.
      g.pointerEventsFilter((o: object) => (o as { __globeObjType?: string }).__globeObjType !== "particles");
      // A click on the ground: drop a pin (pin mode), open the village under the cursor, or close the panel.
      g.onGlobeClick(({ lat, lng }) => {
        if (layersRef.current.pin) return dropPin(lat, lng);
        const near = settlementAt(lat, lng);
        if (near) return pickSettlement(near);
        pick(null);
      });
      globeRef.current = g;
      fit();
      (window as unknown as { __globe?: unknown }).__globe = g; // for debugging from the console
      drawSettlements();

      // Movers (drones/trucks) glide between posts. Their positions are written straight into the
      // marker's three.js object every frame; the data list only changes when a mover appears or ends.
      const loop = () => {
        raf = requestAnimationFrame(loop);
        tick();
      };
      let lastScan = 0;
      const tick = () => {
        const now = performance.now();
        const conn = connRef.current;
        if (conn && now - lastScan > 100) {
          lastScan = now;
          const nowUs = BigInt(Date.now()) * BigInt(1000);
          const p = pickedRef.current;
          const live = new Set<string>();
          for (const o of conn.db.deliveryOrder.iter() as Iterable<Order>) {
            const key = String(o.id);
            const mine = !p || o.toVillageId === p.id || o.fromVillageId === p.id;
            if (!layersRef.current.flights || !mine || o.status !== "on_the_way" || o.mode === "walk" || !o.departedAt) continue;
            const a = villages.current.get(o.fromVillageId), b = villages.current.get(o.toVillageId);
            if (!a || !b) continue;
            live.add(key);
            const t = Math.min(1, Number(nowUs - o.departedAt.microsSinceUnixEpoch) / 1e6 / o.travelSeconds);
            let m = movers.current.get(key);
            if (!m) {
              m = { kind: "mover", id: key, lat: a.lat, lng: a.lng, mode: o.mode, label: "" };
              movers.current.set(key, m);
              markersDirty.current = true;
            }
            const road = roadByOrder.current.get(key);
            if (road && o.mode !== "drone") {
              const at = alongRoad(road, t);
              m.lat = at[0]; m.lng = at[1];
            } else {
              m.lat = a.lat + (b.lat - a.lat) * t;
              m.lng = a.lng + (b.lng - a.lng) * t;
            }
            m.label = `${o.item} · ${Math.max(1, Math.round(o.etaMinutes * (1 - t)))} min`;
          }
          for (const key of [...movers.current.keys()]) if (!live.has(key)) { movers.current.delete(key); markersDirty.current = true; }
        }
        // Write mover positions in place (no data re-bind, no element churn).
        for (const m of movers.current.values()) {
          const obj = (m as unknown as { __threeObjHtml?: { position: { x: number; y: number; z: number } } }).__threeObjHtml;
          if (obj) Object.assign(obj.position, polar2Cartesian(m.lat, m.lng, ALT_MOVER));
          const eta = m.el?.querySelector(".eta");
          if (eta && eta.textContent !== m.label) eta.textContent = m.label;
        }
        const alt = g.pointOfView()?.altitude ?? 1;
        el.current?.classList.toggle("far", alt > 0.16); // names of small posts only once you zoom in
        el.current?.classList.toggle("near", alt < 0.11);
        const b = alt > 0.16 ? "far" : alt < 0.11 ? "near" : "mid";
        if (b !== band.current) { band.current = b; restyleSettlements(); }
        if (markersDirty.current) {
          markersDirty.current = false;
          const pinMarker: Marker[] = pinRef.current ? [{ kind: "pin", lat: pinRef.current.lat, lng: pinRef.current.lng }] : [];
          g.htmlElementsData([...villageMarkers.current.values(), ...pops.current, ...movers.current.values(), ...pinMarker]);
        }
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

  // The settlement under a screen point, within ~9 px (a bigger place wins when two overlap).
  const settlementAt = (lat: number, lng: number) => {
    const g = globeRef.current, idx = index.current;
    if (!g || !idx || !layersRef.current.villages) return null;
    const alt = g.pointOfView()?.altitude ?? 1;
    const tol = 9 * kmPerPx(alt, el.current?.clientHeight ?? 900);
    return idx.nearest(lat, lng, Math.max(0.15, tol), true);
  };

  // ---- settlements (static file, once) ----
  useEffect(() => {
    let gone = false;
    fetch("/api/settlements")
      .then((r) => (r.ok ? r.json() : fetch("/settlements/eastern-province.json").then((f) => f.json())))
      .then((d: { count?: number; sources: SettlementSources; points: Settlement[] }) => {
        if (gone) return;
        settlements.current = d.points ?? [];
        index.current = new SettlementIndex(settlements.current);
        setVillageCount({ n: settlements.current.length, sources: d.sources ?? null });
        drawSettlements();
        recomputeCatchments();
      })
      .catch(() => setVillageCount({ n: 0, sources: null }));
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hover: name of the settlement under the cursor (the globe's own hover only works for meshes).
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let last = 0;
    const move = (e: MouseEvent) => {
      const now = performance.now();
      if (now - last < 40) return;
      last = now;
      const g = globeRef.current;
      if (!g) return;
      const r = node.getBoundingClientRect();
      const c = g.toGlobeCoords(e.clientX - r.left, e.clientY - r.top);
      const s = c ? settlementAt(c.lat, c.lng) : null;
      setHover(s ? { x: e.clientX, y: e.clientY, text: `${nameOf(s)}${s.n ? ` · ${kindOf(s)}` : ""}${s.p ? ` · ${fmtPeople(s.p)} people` : ""}` } : null);
    };
    const leave = () => setHover(null);
    node.addEventListener("mousemove", move);
    node.addEventListener("mouseleave", leave);
    return () => { node.removeEventListener("mousemove", move); node.removeEventListener("mouseleave", leave); };
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
      // A post is "active" only while it needs something: an order still open, or a pod visit in
      // the last ten minutes that was not green. Otherwise the dot stays quiet grey.
      const active = new Set<number>();
      const recent = BigInt(Date.now() - 10 * 60_000) * BigInt(1000);
      for (const o of orders) if (o.status !== "delivered") active.add(o.toVillageId);
      for (const v of visits) if (v.fromPod && v.urgency !== "green" && v.createdAt.microsSinceUnixEpoch > recent) active.add(v.villageId);
      activeIds.current = active;
      rebuildVillages();
      redrawRoutes();
      const s = [...conn.db.settings.iter()][0];
      if (s) setSimulate(s.simulate);
    };

    const syncVillages = (conn: DbConnection) => {
      villages.current = new Map([...conn.db.village.iter()].map((v) => [v.id, v as Village]));
      rebuildVillages();
      recomputeCatchments();
    };
    const syncCarriers = (conn: DbConnection) => setCarriers(new Map([...conn.db.carrier.iter()].map((c) => [c.id, c as Carrier])));

    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setConnected("live");
        c.subscriptionBuilder()
          .onApplied(() => {
            syncVillages(c);
            syncCarriers(c);
            refreshKpis(c);
          })
          .subscribe(["SELECT * FROM village", "SELECT * FROM stock", "SELECT * FROM visit", "SELECT * FROM delivery_order", "SELECT * FROM settings", "SELECT * FROM pop", "SELECT * FROM agent_log", "SELECT * FROM pod", "SELECT * FROM route_plan", "SELECT * FROM carrier"]);
      })
      .onConnectError(() => setConnected("offline"))
      .onDisconnect(() => setConnected("offline"))
      .build();
    connRef.current = conn;

    conn.db.village.onInsert(() => syncVillages(conn));
    conn.db.settings.onUpdate(() => refreshKpis(conn));
    conn.db.carrier.onInsert(() => syncCarriers(conn));
    conn.db.carrier.onUpdate(() => syncCarriers(conn));
    // A planned road appears, starts moving, or is replaced: redraw the lines.
    conn.db.routePlan.onInsert((_ctx, p) => {
      redrawRoutes();
      if (/^rerouted/i.test(p.reason) || p.status === "rerouted") push(`REROUTED ▸ order #${p.orderId} · ${p.km.toFixed(0)} km · flood risk ${p.floodRisk}`, "alert");
      else push(`ROUTE ▸ order #${p.orderId} · ${p.km.toFixed(0)} km by road · ${p.minutes} min · flood risk ${p.floodRisk}`, "move");
    });
    conn.db.routePlan.onUpdate(() => redrawRoutes());
    conn.db.routePlan.onDelete(() => redrawRoutes());
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
    conn.db.deliveryOrder.onDelete(() => refreshKpis(conn));
    conn.db.agentLog.onInsert((_ctx, l) => {
      if (l.agent !== "Pod") push(`${l.agent.toUpperCase()} ▸ ${l.text}`, "agent");
    });
    conn.db.pop.onInsert((_ctx, p) => {
      const v = villages.current.get(p.villageId);
      if (!v) return;
      const id = ++feedSeq;
      const tone = p.kind === "delivered" ? "done" : p.kind === "alert" ? "alert" : p.kind === "restock" ? "restock" : "need";
      pops.current.push({ kind: "pop", id, lat: v.lat, lng: v.lng, text: plain(p.text), tone });
      markersDirty.current = true;
      setTimeout(() => { pops.current = pops.current.filter((x) => x.kind !== "pop" || x.id !== id); markersDirty.current = true; }, 2600);
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

  // What the post you clicked holds, asked for, sent, and the roads planned for it.
  useEffect(() => {
    const conn = connRef.current;
    if (!picked || !conn) return;
    const read = () => {
      setStockOf([...conn.db.stock.iter()].filter((s) => s.villageId === picked.id).map((s) => ({ item: s.item, qty: s.qty })));
      const orders = ([...conn.db.deliveryOrder.iter()] as Order[]).sort((a, b) => Number(b.id - a.id));
      setAsked(orders.filter((o) => o.toVillageId === picked.id).slice(0, 12));
      setSent(orders.filter((o) => o.fromVillageId === picked.id && o.toVillageId !== picked.id).slice(0, 12));
      setPodHere(([...conn.db.pod.iter()] as Pod[]).find((p) => p.villageId === picked.id) ?? null);
      const mineIds = new Set(orders.filter((o) => o.toVillageId === picked.id || o.fromVillageId === picked.id).map((o) => String(o.id)));
      setPlansOf(([...conn.db.routePlan.iter()] as Plan[]).filter((p) => mineIds.has(String(p.orderId)) && p.status !== "done").slice(0, 8));
    };
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, [picked]);

  const conn = connRef.current;
  const low = stockOf.filter((s) => s.qty < 5);
  const ob = villageCount.sources?.openBuildings;
  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-slate-100">
      <style>{CSS}</style>
      <div ref={el} className="absolute inset-0 far" />

      {hover && (
        <div className="tip pointer-events-none fixed z-30" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          {hover.text}
        </div>
      )}

      <div className="pointer-events-none absolute left-5 top-14 z-10 max-w-md rounded-2xl border border-slate-800/80 bg-slate-950/85 p-4 backdrop-blur">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-300">Pod network · live</p>
        <h1 className="text-2xl font-bold">Eastern Province, Zambia</h1>
        <p className="mt-1 text-sm text-slate-300">
          Every grey dot is a village{villageCount.n ? ` (${villageCount.n.toLocaleString()} of them, down to hamlets of three roofs)` : ""}; the larger dots are the health posts. A post lights up only when a pod there flags a need; the order then flies or drives from wherever the medicine is to that patient&apos;s home. Drones 100 km/h, trucks 40: one second here is one real minute.
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
          <Toggle on={layers.villages} onClick={() => setLayer("villages", !layers.villages)} label="Villages" />
          <Toggle on={layers.labels} onClick={() => setLayer("labels", !layers.labels)} label="All names" />
          <Toggle on={layers.pin} onClick={() => setLayer("pin", !layers.pin)} label={layers.pin ? "Drop a pin: click the map" : "Drop a pin"} warn />
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
        {ob && (
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-500">
            villages: {villageCount.sources?.geonames.toLocaleString()} named (GeoNames{villageCount.sources?.osm ? ` + ${villageCount.sources.osm} OSM` : ""}) · {ob.clusters.toLocaleString()} hamlets from {ob.roofs.toLocaleString()} roofs (Google Open Buildings) · people ≈ {villageCount.sources?.peoplePerHouse ?? 2} per roof
          </p>
        )}
      </div>

      {(picked || pickedSettlement || pin) && (
        <div className="panel absolute bottom-5 left-5 z-10 w-[22rem] overflow-y-auto rounded-2xl border border-slate-700/70 bg-slate-950/90 p-4 backdrop-blur">
          {pin && !picked && (
            <>
              <div className="flex items-baseline justify-between">
                <p className="font-semibold">Pin · {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</p>
                <button onClick={clearPin} className="text-slate-400">✕</button>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {pin.hamlet ? <>nearest place: <span className="text-slate-200">{nameOf(pin.hamlet)}</span>{pin.hamlet.p ? ` · ${fmtPeople(pin.hamlet.p)} people` : ""} · {pin.hamlet.km < 1 ? `${Math.round(pin.hamlet.km * 1000)} m` : `${pin.hamlet.km.toFixed(1)} km`}</> : "no settlement within 15 km"}
              </p>
              {pin.post && (
                <p className="text-xs text-slate-400">
                  nearest post: <button onClick={() => pick(pin.post!.v)} className="text-sky-200 underline decoration-sky-700 underline-offset-2">{short(pin.post.v.name)}</button> · {pin.post.km.toFixed(1)} km
                </p>
              )}
              <GoogleLinks lat={pin.lat} lng={pin.lng} />
              <p className="mt-2 text-[11px] text-slate-500">Pin mode is on: click anywhere else to move the pin, or switch &ldquo;Drop a pin&rdquo; off to go back to clicking villages.</p>
            </>
          )}

          {pickedSettlement && (
            <div className={picked ? "mb-3 border-b border-slate-800 pb-3" : ""}>
              <div className="flex items-baseline justify-between">
                <p className="font-semibold">{nameOf(pickedSettlement.s)}</p>
                {!picked && <button onClick={() => setPickedSettlement(null)} className="text-slate-400">✕</button>}
              </div>
              <p className="text-xs text-slate-400">
                {pickedSettlement.s.n ? `${kindOf(pickedSettlement.s)} · ` : ""}
                {pickedSettlement.s.p ? `${pickedSettlement.s.p.toLocaleString()} people${pickedSettlement.s.h ? ` (≈, ${pickedSettlement.s.h.toLocaleString()} roofs)` : ""}` : "population unknown"}
                {pickedSettlement.served ? ` · served by ${short(pickedSettlement.served.post.name)} post, ${pickedSettlement.served.km < 1 ? `${Math.round(pickedSettlement.served.km * 1000)} m` : `${pickedSettlement.served.km.toFixed(pickedSettlement.served.km < 10 ? 1 : 0)} km`}` : ""}
                {" · "}{pickedSettlement.s.la.toFixed(4)}, {pickedSettlement.s.ln.toFixed(4)}
              </p>
              <GoogleLinks lat={pickedSettlement.s.la} lng={pickedSettlement.s.ln} />
            </div>
          )}

          {picked && (
            <>
              <div className="flex items-baseline justify-between">
                <p className="font-semibold">{short(picked.name)}{pickedSettlement ? <span className="ml-1 text-xs font-normal text-slate-400">· the post that serves it</span> : null}</p>
                <button onClick={() => pick(null)} className="text-slate-400">✕</button>
              </div>
              <p className="text-xs text-slate-400">
                {picked.hub ? "Regional hub · full shelves" : `Health post · ${picked.population.toLocaleString()} people`} · {picked.lat.toFixed(4)}, {picked.lng.toFixed(4)}
              </p>
              {catchment && (
                <p className="text-xs text-slate-400">
                  serves <span className="text-slate-200">{catchment.count.toLocaleString()} villages</span> ({catchment.named.toLocaleString()} named), <span className="text-slate-200">~{fmtPeople(catchment.people)} people</span>
                  {catchment.houses ? ` · ${catchment.houses.toLocaleString()} roofs` : ""} — nearest-post rule
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Link href={`/kiosk?village=${encodeURIComponent(short(picked.name))}`} className="rounded-lg border border-sky-700 bg-sky-950/70 px-3 py-1.5 text-sky-200 hover:bg-sky-900">
                  Open the pod here
                </Link>
              </div>
              <GoogleLinks lat={picked.lat} lng={picked.lng} />
              <PodNow pod={podHere} />

              <Section title={`Asked for · ${asked.length}`}>
                {asked.length ? asked.map((o) => <OrderRow key={String(o.id)} o={o} other={vname(o.fromVillageId)} dir="from" />) : <Empty>no requests yet — a pod visit here would be the first</Empty>}
              </Section>
              <Section title={`Sent from here · ${sent.length}`}>
                {sent.length ? sent.map((o) => <OrderRow key={String(o.id)} o={o} other={o.kind === "restock" ? `${vname(o.toVillageId)} post` : `${o.patientName}, ${vname(o.toVillageId)}`} dir="to" />) : <Empty>nothing sent from here</Empty>}
              </Section>
              {plansOf.length > 0 && (
                <Section title={`Roads planned · ${plansOf.length}`}>
                  {plansOf.map((p) => {
                    const c = carriers.get(p.carrierId);
                    return (
                      <div key={String(p.id)} className="flex items-baseline justify-between gap-2 border-l-2 border-slate-700 py-0.5 pl-2 text-[12px] leading-4">
                        <span className="truncate">
                          <span className="text-slate-100">order #{String(p.orderId)}</span>
                          <span className="text-slate-500"> · {c ? `${c.kind} · ${c.operator}` : `carrier ${p.carrierId}`} · {p.km.toFixed(0)} km · {p.minutes} min</span>
                        </span>
                        <span className={`shrink-0 ${p.floodRisk === "high" ? "text-red-400" : p.floodRisk === "medium" ? "text-amber-300" : "text-emerald-300"}`}>{p.status === "moving" ? "moving" : p.status} · flood {p.floodRisk}</span>
                      </div>
                    );
                  })}
                </Section>
              )}
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
            </>
          )}
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

function parseWaypoints(json: string): [number, number][] {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]);
  } catch {
    return [];
  }
}

// Where along the road a mover is at fraction t of its journey (by distance, not by waypoint count).
function alongRoad(r: RoadPath, t: number): [number, number] {
  const d = Math.max(0, Math.min(1, t)) * r.total;
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < d) i++;
  const a = r.pts[i - 1], b = r.pts[i];
  const seg = r.cum[i] - r.cum[i - 1];
  const f = seg > 0 ? (d - r.cum[i - 1]) / seg : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

const roadColor = (r: RoadPath) => (r.flood === "high" ? "rgba(248,113,113,0.95)" : r.flood === "medium" ? "rgba(251,191,36,0.9)" : r.mode === "drone" ? "rgba(56,189,248,0.9)" : "rgba(167,139,250,0.9)");

type ThreeLite = { CanvasTexture: new (c: HTMLCanvasElement) => { needsUpdate: boolean } };

// A soft round sprite for the settlement dots (points are square without one).
function dotTexture(THREE: ThreeLite) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  const grd = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.55, "rgba(255,255,255,1)");
  grd.addColorStop(0.75, "rgba(255,255,255,0.6)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function GoogleLinks({ lat, lng }: { lat: number; lng: number }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <a href={earthUrl(lat, lng)} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-emerald-700 bg-emerald-950/70 px-3 py-1.5 text-emerald-200 hover:bg-emerald-900">
        See it in Google Earth ↗
      </a>
      <a href={mapsSatelliteUrl(lat, lng)} target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-slate-200">
        Google Maps satellite ↗
      </a>
    </div>
  );
}

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

// "big" posts (the hub and the twelve district towns) keep their name at every zoom; the small
// rural posts show theirs only when picked, lit, or zoomed in.
const villageClass = (d: VillageMarker) => `village ${d.v.hub ? "hub" : ""} ${d.v.hub || d.v.population >= 6000 ? "big" : "small"} ${d.state} ${d.online ? "online" : ""}`;

// Markers: a dot per post (bigger ring for the hub), floating "+1" bubbles, small drones and
// trucks, the pin. globe.gl centres the element it gets on the coordinate, so each marker is a
// zero-size anchor with the visible part positioned inside it: the DOT sits on the coordinate
// and the name hangs off to the right (otherwise dot + label are centred together and the dot
// slides sideways by half the label's width whenever a name shows).
function markerEl(d: Marker, onPick: (v: Village) => void): HTMLElement {
  const anchor = document.createElement("div");
  anchor.className = "anchor";
  const n = document.createElement("div");
  anchor.appendChild(n);
  if (d.kind === "village") {
    n.className = villageClass(d);
    n.innerHTML = `<span class="dot"></span><span class="name">${short(d.v.name)}</span>`;
    n.style.pointerEvents = "auto";
    n.onclick = (e) => {
      e.stopPropagation();
      onPick(d.v);
    };
    d.el = n;
  } else if (d.kind === "pop") {
    n.className = `pop ${d.tone}`;
    n.textContent = d.text;
  } else if (d.kind === "pin") {
    n.className = "pin";
    n.innerHTML = `<span class="needle"></span><span class="head"></span>`;
  } else {
    n.className = `mover ${d.mode}`;
    n.innerHTML = `<span class="ic"></span><span class="eta">${d.label}</span>`;
    d.el = n;
  }
  return anchor;
}

const CSS = `
.anchor{position:relative;width:0;height:0}
.village{--d:7px;position:absolute;left:0;top:0;display:flex;align-items:center;gap:5px;transform:translate(calc(var(--d) / -2),-50%);cursor:pointer;white-space:nowrap}
.village .dot{width:var(--d);height:var(--d);border-radius:999px;background:#cbd5e1;box-shadow:0 0 0 2px rgba(2,6,23,.8),0 0 8px rgba(148,163,184,.6);transition:background .25s,box-shadow .25s}
.village.big{--d:9px}
.village.hub{--d:13px}
.village.hub .dot{background:#34d399;box-shadow:0 0 0 3px rgba(2,6,23,.85),0 0 0 5px rgba(52,211,153,.55),0 0 16px rgba(52,211,153,.8)}
.village.active .dot{background:#fbbf24;box-shadow:0 0 0 2px rgba(2,6,23,.85),0 0 0 4px rgba(251,191,36,.45),0 0 14px rgba(251,191,36,.9);animation:pulse 1.4s ease-in-out infinite}
.village.picked .dot{background:#38bdf8;box-shadow:0 0 0 2px rgba(2,6,23,.85),0 0 0 5px rgba(56,189,248,.55),0 0 18px rgba(56,189,248,1)}
.village.online .dot{position:relative}
.village.online .dot:after{content:"";position:absolute;inset:-6px;border-radius:999px;border:1.5px solid #34d399;box-shadow:0 0 8px rgba(52,211,153,.9);animation:ring 1.8s ease-out infinite}
@keyframes ring{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.6);opacity:0}}
.online-dot{animation:pulse 1.4s ease-in-out infinite}
.village .name{font:600 11px/1.2 system-ui;color:#e2e8f0;background:rgba(2,6,23,.72);border:1px solid rgba(148,163,184,.35);padding:2px 6px;border-radius:999px}
.village.hub .name{border-color:#34d399;color:#a7f3d0}
.village.active .name{border-color:#fbbf24;color:#fde68a}
.village.picked .name{border-color:#38bdf8;color:#e0f2fe}
/* Label rule. Far (whole province): hub + district towns only, plus the picked post. Mid: also posts
   that are lit or have a pod on. Near: every post. "All names" overrides. */
.village.small .name{display:none}
.village.small.picked .name{display:inline}
.village.small.active .name,.village.small.online .name{display:inline}
.far .village.small.active .name,.far .village.small.online .name{display:none}
.far .village .name{font-size:9.5px;padding:1px 5px}
.near .village.small .name{display:inline}
.no-hubs .village.hub{--d:7px}
.no-hubs .village.hub .dot{background:#cbd5e1;box-shadow:0 0 0 2px rgba(2,6,23,.8)}
.no-hubs .village.hub .name{border-color:rgba(148,163,184,.35);color:#e2e8f0}
.all-labels .village .name{display:inline!important}
.pin-mode{cursor:crosshair}
.pin-mode .village{pointer-events:none!important}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.35)}}
.pop{position:absolute;left:0;top:0;transform:translate(-50%,-50%);z-index:999!important;font:800 14px/1 system-ui;padding:5px 10px;border:1.5px solid rgba(255,255,255,.85);border-radius:999px;white-space:nowrap;animation:floatup 2.6s ease-out forwards;box-shadow:0 4px 14px rgba(0,0,0,.5)}
.pop.need{background:#fbbf24;color:#1c1917}
.pop.done{background:#34d399;color:#052e16}
.pop.alert{background:#ef4444;color:white}
.pop.restock{background:#38bdf8;color:#082f49}
.pin{position:relative;width:0;height:0}
.pin .head{position:absolute;left:-7px;top:-24px;width:14px;height:14px;border-radius:999px 999px 999px 0;transform:rotate(-45deg);background:#f472b6;box-shadow:0 0 0 2px rgba(2,6,23,.85),0 0 14px rgba(244,114,182,.9)}
.pin .needle{position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:999px;background:#fff;box-shadow:0 0 0 2px rgba(2,6,23,.85)}
.tip{font:600 11px/1.2 system-ui;color:#e2e8f0;background:rgba(2,6,23,.85);border:1px solid rgba(148,163,184,.4);padding:3px 7px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.5)}
.panel{max-height:calc(100vh - 29rem)}
.hud{background:linear-gradient(180deg,rgba(2,6,23,.92),rgba(2,6,23,.86));border:1px solid rgba(56,189,248,.25);border-radius:14px;box-shadow:0 0 0 1px rgba(2,6,23,.6),0 0 40px rgba(56,189,248,.08) inset;backdrop-filter:blur(10px);overflow:hidden}
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
.mover{position:absolute;left:0;top:0;transform:translate(-50%,-6px);display:flex;flex-direction:column;align-items:center;gap:3px}
.mover .ic{display:block;width:12px;height:12px;background:#38bdf8;clip-path:polygon(50% 0,100% 100%,50% 75%,0 100%);filter:drop-shadow(0 0 6px rgba(56,189,248,1))}
.mover.road .ic,.mover.truck .ic{width:11px;height:9px;background:#c4b5fd;clip-path:none;border-radius:2px;filter:drop-shadow(0 0 6px rgba(167,139,250,1))}
.far .mover .eta{display:none}
.mover .eta{font:600 10px/1 ui-monospace,Menlo,monospace;color:#e0f2fe;background:rgba(2,6,23,.8);border:1px solid rgba(56,189,248,.5);padding:2px 5px;border-radius:999px;white-space:nowrap}
@keyframes feedin{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
`;
