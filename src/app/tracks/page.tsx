"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerrainMeta, TerrainPad, TerrainPostSummary, TerrainTrack } from "@/lib/terrain";

// Proposed off-road tracks (motorbike and bicycle, never trucks) and drone landing pads, worked out
// from free satellite data by tools/terrain: Copernicus 30 m elevation, ESA WorldCover land cover,
// Sentinel-2 wetness, Google Open Buildings for where the houses are, OpenStreetMap/OSRM for the
// roads that already exist. Every line is a proposal until a rider has done it with a GPS.

type Post = { id: number; name: string; lat: number; lng: number };
type Marker =
  | { kind: "post"; id: number; lat: number; lng: number; name: string; has: boolean }
  | { kind: "village"; id: string; lat: number; lng: number; buildings: number }
  | { kind: "pad"; id: string; lat: number; lng: number; label: string };
type PathRow = { id: string; points: [number, number][]; color: string; stroke: number; dash: number };

const VEHICLE_COLOR: Record<string, string> = { motorbike: "#38bdf8", bicycle: "#34d399" };
const short = (name: string) => name.replace(/ \(.*\)$/, "");

export default function TracksPage() {
  const el = useRef<HTMLDivElement>(null);
  const globeRef = useRef<import("globe.gl").GlobeInstance | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [tracks, setTracks] = useState<TerrainTrack[]>([]);
  const [pads, setPads] = useState<TerrainPad[]>([]);
  const [summaries, setSummaries] = useState<Record<string, TerrainPostSummary>>({});
  const [sources, setSources] = useState<TerrainMeta["sources"]>([]);
  const [noData, setNoData] = useState(false);
  const [post, setPost] = useState<number>(29); // Jumbe: the Luangwa and the escarpment make it interesting
  const [vehicle, setVehicle] = useState<"both" | "motorbike" | "bicycle">("both");
  const [season, setSeason] = useState<"dry" | "wet">("dry");
  const [picked, setPicked] = useState<string | null>(null);
  const pickedRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"tracks" | "pads" | "posts">("tracks");
  const [globeReady, setGlobeReady] = useState(false); // the globe loads async; redraw once it exists

  const load = useCallback(async () => {
    const r = await fetch("/api/terrain/tracks");
    if (r.status === 404) {
      setNoData(true);
      return;
    }
    const j = await r.json();
    setNoData(false);
    setTracks(j.tracks ?? []);
    setPads(j.pads ?? []);
    setSummaries(j.posts ?? {});
    setSources(j.sources ?? []);
    if (j.generating) setBusy(j.generating.villageId);
  }, []);

  useEffect(() => {
    fetch("/api/weather/outlook")
      .then((r) => r.json())
      .then((j) => setPosts((j.posts ?? []).map((p: { villageId: number; name: string; lat: number; lng: number }) => ({ id: p.villageId, name: p.name, lat: p.lat, lng: p.lng }))))
      .catch(() => undefined);
    load();
  }, [load]);

  // ---- the globe ----
  useEffect(() => {
    let disposed = false;
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
        .htmlAltitude(0.003)
        .htmlElement((d: object) => markerEl(d as Marker))
        .pathsData([])
        .pathPoints((d: object) => (d as PathRow).points)
        .pathPointLat((p: unknown) => (p as [number, number])[0])
        .pathPointLng((p: unknown) => (p as [number, number])[1])
        .pathPointAlt(0.004)
        .pathResolution(1)
        .pathColor((d: object) => (d as PathRow).color)
        .pathStroke((d: object) => (d as PathRow).stroke)
        .pathDashLength((d: object) => (d as PathRow).dash)
        .pathDashGap((d: object) => (d as PathRow).dash)
        .pathDashAnimateTime(0)
        .pathTransitionDuration(0)
        .onPathClick((p: object) => {
          const id = (p as PathRow).id;
          pickedRef.current = id;
          setPicked(id);
        });
      g.pointOfView({ lat: -13.3, lng: 31.92, altitude: 0.035 });
      g.controls().autoRotate = false;
      g.controls().zoomSpeed = 1.2;
      g.onGlobeClick(() => {
        pickedRef.current = null;
        setPicked(null);
      });
      g.onGlobeReady(() => setGlobeReady(true));
      globeRef.current = g;
      fit();
    })();
    const ro = new ResizeObserver(fit);
    if (el.current) ro.observe(el.current);
    window.addEventListener("resize", fit);
    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener("resize", fit);
      globeRef.current?._destructor?.();
    };
  }, []);

  const shown = useMemo(
    () => tracks.filter((t) => t.fromVillageId === post && t.season === season && (vehicle === "both" || t.vehicle === vehicle)).sort((a, b) => b.confidence - a.confidence),
    [tracks, post, season, vehicle],
  );
  const shownPads = useMemo(() => pads.filter((p) => p.villageId === post), [pads, post]);
  const summary = summaries[String(post)];
  const postsWithData = useMemo(() => new Set(Object.keys(summaries).map(Number)), [summaries]);

  // Redraw paths and markers whenever the filters or data change.
  useEffect(() => {
    const g = globeRef.current;
    if (!g) return;
    const paths: PathRow[] = shown.map((t) => {
      const mine = picked === null || picked === t.id;
      const alpha = mine ? 0.35 + 0.6 * t.confidence : 0.12;
      return { id: t.id, points: t.line, color: rgba(VEHICLE_COLOR[t.vehicle], alpha), stroke: picked === t.id ? 1.8 : 1.0, dash: t.vehicle === "motorbike" ? 0.02 : 0.012 };
    });
    g.pathsData(paths);
    const markers: Marker[] = posts.map((p) => ({ kind: "post", id: p.id, lat: p.lat, lng: p.lng, name: short(p.name), has: postsWithData.has(p.id) }));
    const seen = new Set<string>();
    for (const t of tracks.filter((t) => t.fromVillageId === post)) {
      const k = `${t.toCluster.lat},${t.toCluster.lng}`;
      if (seen.has(k)) continue;
      seen.add(k);
      markers.push({ kind: "village", id: k, lat: t.toCluster.lat, lng: t.toCluster.lng, buildings: t.toCluster.buildings });
    }
    for (const p of summary?.villages ?? []) {
      const k = `${p.lat},${p.lng}`;
      if (seen.has(k)) continue;
      seen.add(k);
      markers.push({ kind: "village", id: k, lat: p.lat, lng: p.lng, buildings: p.buildings });
    }
    for (const p of shownPads) markers.push({ kind: "pad", id: `${p.lat},${p.lng}`, lat: p.lat, lng: p.lng, label: `${p.sizeM} m pad · ${p.cover} · ${p.slopeDeg}°` });
    g.htmlElementsData(markers);
  }, [shown, shownPads, posts, tracks, post, picked, postsWithData, summary, globeReady]);

  const flyTo = (p: Post) => globeRef.current?.pointOfView({ lat: p.lat, lng: p.lng, altitude: 0.035 }, 900);

  const generate = async (id: number) => {
    setBusy(id);
    setNote(`Working on ${short(posts.find((p) => p.id === id)?.name ?? `#${id}`)}: reading elevation, land cover, two Sentinel-2 seasons, the houses and the roads, then tracing the cheapest lines. Two to six minutes the first time.`);
    try {
      const r = await fetch(`/api/terrain/generate?village=${id}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      const s = j.summary as TerrainPostSummary | null;
      setNote(s ? `${short(s.name)}: ${s.tracks} track${s.tracks === 1 ? "" : "s"} and ${s.pads} pad${s.pads === 1 ? "" : "s"} from ${s.villages.length} villages in ${j.seconds}s (roads from ${s.roadsSource === "osm" ? "OpenStreetMap" : "OSRM geometries; Overpass was down"}).` : `Done in ${j.seconds}s.`);
    } catch (e) {
      setNote(`Generation failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      load();
    }
  };

  const current = posts.find((p) => p.id === post);
  const pickedTrack = shown.find((t) => t.id === picked) ?? null;
  const counts = {
    posts: postsWithData.size,
    tracks: tracks.length,
    motorbike: tracks.filter((t) => t.vehicle === "motorbike").length,
    bicycle: tracks.filter((t) => t.vehicle === "bicycle").length,
    pads: pads.length,
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-slate-100">
      <style>{CSS}</style>
      <div ref={el} className="absolute inset-0" />

      <div className="pointer-events-none absolute left-5 top-14 z-10 max-w-md">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-300">Tracks · from satellite</p>
        <h1 className="text-2xl font-bold">New ways in, mapped from the flatlands</h1>
        <p className="mt-1 text-sm text-slate-300">
          Where no road reaches a village, or the road goes the long way round, this proposes a motorbike or bicycle line across the flat ground: 30 m elevation and slope, land cover, wet and dry season water from Sentinel-2, houses from Open Buildings. Dashed lines are proposals; brighter means more confident. Squares are candidate drone pads.
        </p>
        <div className="pointer-events-auto mt-4 grid grid-cols-5 gap-2 text-center">
          <Kpi label="posts done" value={counts.posts} tone="text-slate-200" />
          <Kpi label="tracks" value={counts.tracks} />
          <Kpi label="motorbike" value={counts.motorbike} tone="text-sky-300" />
          <Kpi label="bicycle" value={counts.bicycle} tone="text-emerald-300" />
          <Kpi label="drone pads" value={counts.pads} tone="text-violet-300" />
        </div>
        <div className="pointer-events-auto mt-3 flex flex-wrap items-center gap-2 text-xs">
          <select value={post} onChange={(e) => { const id = Number(e.target.value); setPost(id); setPicked(null); const p = posts.find((x) => x.id === id); if (p) flyTo(p); }} className="rounded-lg border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-slate-100">
            {posts.map((p) => (
              <option key={p.id} value={p.id}>
                {short(p.name)}{postsWithData.has(p.id) ? " ✓" : ""}
              </option>
            ))}
          </select>
          <button disabled={busy !== null} onClick={() => generate(post)} className="rounded-lg border border-sky-700 bg-sky-950/80 px-3 py-1.5 text-sky-100 hover:bg-sky-900 disabled:opacity-50">
            {busy === post ? "Generating…" : busy !== null ? `Busy with #${busy}` : `Generate for ${current ? short(current.name) : "this post"}`}
          </button>
          <Seg value={vehicle} onChange={(v) => setVehicle(v as typeof vehicle)} options={[["both", "Both"], ["motorbike", "Motorbike"], ["bicycle", "Bicycle"]]} />
          <Seg value={season} onChange={(v) => setSeason(v as typeof season)} options={[["dry", "Dry season"], ["wet", "Wet season"]]} />
        </div>
        {note && <p className="pointer-events-auto mt-2 rounded-md border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs text-slate-200">{note}</p>}
        {noData && <p className="pointer-events-auto mt-2 rounded-md border border-amber-800 bg-amber-950/70 px-3 py-2 text-xs text-amber-100">Nothing generated yet. Run tools/terrain/setup.sh once, then press Generate.</p>}
        <div className="pointer-events-auto mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
          <span><span className="mr-1 inline-block h-0.5 w-5 border-t-2 border-dashed align-middle" style={{ borderColor: VEHICLE_COLOR.motorbike }} />Motorbike (slope limit 15°)</span>
          <span><span className="mr-1 inline-block h-0.5 w-5 border-t-2 border-dashed align-middle" style={{ borderColor: VEHICLE_COLOR.bicycle }} />Bicycle (8°)</span>
          <span><span className="mr-1 inline-block h-2.5 w-2.5 rotate-45 bg-violet-400 align-middle" />Drone pad</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-200 align-middle" />Village (houses)</span>
          <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-slate-200 align-middle" />Health post</span>
        </div>
        <p className="pointer-events-auto mt-3 max-w-md text-[11px] leading-relaxed text-slate-500">
          Honest limits: 30 m cells miss gullies and dongas; land cover does not show fences, fields someone owns, or a thorn hedge; seasonal streams are in no dataset; the wetness comes from one clear satellite day per season. A line here is a proposal until a rider has done it with a GPS.
        </p>
      </div>

      <div className="hud absolute bottom-5 right-5 top-14 z-10 flex w-[27rem] flex-col p-4">
        <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em]">
          <button onClick={() => setTab("tracks")} className={`rounded px-2 py-1 ${tab === "tracks" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-white"}`}>Tracks ({shown.length})</button>
          <button onClick={() => setTab("pads")} className={`rounded px-2 py-1 ${tab === "pads" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-white"}`}>Pads ({shownPads.length})</button>
          <button onClick={() => setTab("posts")} className={`rounded px-2 py-1 ${tab === "posts" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-white"}`}>Posts ({posts.length})</button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {tab === "tracks" && summary && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
              {short(summary.name)}: {summary.buildings.toLocaleString()} buildings in the 36 km box, {summary.villages.length} villages picked within 15 km, roads from {summary.roadsSource === "osm" ? "OpenStreetMap" : "OSRM road geometries (Overpass was down)"}.
              {summary.sentinel2 ? ` Sentinel-2 dry ${summary.sentinel2.dry.scenes.map((s) => s.date).join(", ") || "none"}, wet ${summary.sentinel2.wet.scenes.map((s) => s.date).join(", ") || "none"}.` : ""}
              {summary.dropped.length ? ` ${summary.dropped.length} candidate lines dropped (road as quick, or no passable line).` : ""}
            </div>
          )}
          {tab === "tracks" &&
            (shown.length ? (
              shown.map((t) => {
                const on = picked === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      pickedRef.current = on ? null : t.id;
                      setPicked(on ? null : t.id);
                    }}
                    className={`block w-full rounded-lg border px-3 py-2 text-left text-xs ${on ? "border-sky-500 bg-sky-950/60" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-100">
                        <span style={{ color: VEHICLE_COLOR[t.vehicle] }}>{t.vehicle === "motorbike" ? "Motorbike" : "Bicycle"}</span> → village of {t.toCluster.buildings} houses
                      </span>
                      <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-300">confidence {Math.round(t.confidence * 100)}%</span>
                    </div>
                    <div className="mt-1 text-slate-400">
                      {t.lengthKm} km · ~{Math.round(t.minutes)} min · steepest {t.maxSlopeDeg}° · climbs {t.climbM} m · {t.crossings} wet crossing{t.crossings === 1 ? "" : "s"}
                    </div>
                    <div className="mt-1 leading-relaxed text-slate-500">{t.reason}</div>
                    {on && (
                      <div className="mt-1 text-slate-500">
                        Ground: {pct(t.surface.road)} road, {pct(t.surface.open)} open, {pct(t.surface.crop)} fields, {pct(t.surface.bush)} bush, {pct(t.surface.wet)} wet.
                        {t.roadNearM !== null ? ` Nearest mapped road to the village: ${t.roadNearM >= 1000 ? `${(t.roadNearM / 1000).toFixed(1)} km` : `${t.roadNearM} m`}.` : ""}
                      </div>
                    )}
                  </button>
                );
              })
            ) : (
              <p className="font-mono text-xs leading-relaxed text-slate-500">
                {summary ? `No ${vehicle === "both" ? "" : vehicle + " "}tracks kept for ${short(summary.name)} in the ${season} season: the road was as quick, or no line passed the slope and water rules.` : `Nothing generated for ${current ? short(current.name) : "this post"} yet. Press Generate.`}
              </p>
            ))}
          {tab === "pads" &&
            (shownPads.length ? (
              shownPads.map((p) => (
                <div key={`${p.lat},${p.lng}`} className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-violet-200">{p.atPost ? "At the health post" : `Near ${p.near}`}</span>
                    <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-300">score {Math.round(p.score * 100)}</span>
                  </div>
                  <div className="mt-1 text-slate-400">
                    {p.sizeM} m across · {p.cover} · slope {p.slopeDeg}° · {p.distanceM} m from the houses · {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                  </div>
                </div>
              ))
            ) : (
              <p className="font-mono text-xs text-slate-500">No pads yet for this post.</p>
            ))}
          {tab === "posts" &&
            posts.map((p) => {
              const s = summaries[String(p.id)];
              return (
                <button key={p.id} onClick={() => { setPost(p.id); setPicked(null); setTab("tracks"); flyTo(p); }} className={`block w-full rounded-lg border px-3 py-2 text-left text-xs ${p.id === post ? "border-sky-500 bg-sky-950/60" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-100">{short(p.name)}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${s ? "bg-emerald-900/70 text-emerald-200" : "bg-slate-800 text-slate-400"}`}>{s ? `${s.tracks} tracks · ${s.pads} pads` : "not run"}</span>
                  </div>
                  {s && <div className="mt-1 text-slate-500">{s.villages.length} villages · {s.buildings.toLocaleString()} buildings · {new Date(s.generatedAt).toLocaleString()}</div>}
                </button>
              );
            })}
          {tab === "posts" && sources.length > 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
              Sources, all without a key: {sources.map((s) => s.name).join("; ")}.
            </div>
          )}
        </div>
        {pickedTrack && (
          <div className="mt-2 rounded-lg border border-sky-900 bg-sky-950/50 px-3 py-2 text-[11px] leading-relaxed text-sky-100">
            Picked: {pickedTrack.vehicle} line, {pickedTrack.lengthKm} km, {Math.round(pickedTrack.minutes)} min in the {pickedTrack.season} season. {pickedTrack.roadMinutes !== null ? `By road it would be ${pickedTrack.roadKm} km and about ${Math.round(pickedTrack.roadMinutes)} min.` : "No road route exists."} Click the globe to clear.
          </div>
        )}
      </div>
    </div>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(2)})`;
}

function markerEl(m: Marker) {
  const d = document.createElement("div");
  if (m.kind === "post") {
    d.className = `post ${m.has ? "has" : ""}`;
    d.innerHTML = `<i></i><b>${m.name}</b>`;
    return d;
  }
  if (m.kind === "village") {
    d.className = "village";
    d.innerHTML = `<i></i><b>${m.buildings} houses</b>`;
    return d;
  }
  d.className = "pad";
  d.innerHTML = `<i></i>`;
  d.title = m.label;
  return d;
}

function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <span className="inline-flex overflow-hidden rounded-lg border border-slate-700 bg-slate-900/80">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={`px-2.5 py-1.5 ${value === v ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}`}>
          {label}
        </button>
      ))}
    </span>
  );
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
.post { position: relative; transform: translate(-50%, -50%); pointer-events: none; }
.post i { display: block; width: 10px; height: 10px; border-radius: 50%; background: #e2e8f0; box-shadow: 0 0 0 2px rgba(15,23,42,.85); }
.post.has i { background: #fbbf24; }
.post b { position: absolute; left: 12px; top: -3px; font: 600 10px/1 var(--font-space-grotesk), sans-serif; color: #f8fafc; white-space: nowrap; text-shadow: 0 1px 2px #000; }
.village { position: relative; transform: translate(-50%, -50%); pointer-events: none; }
.village i { display: block; width: 7px; height: 7px; border-radius: 50%; background: #fde68a; box-shadow: 0 0 0 1.5px rgba(15,23,42,.85); }
.village b { position: absolute; left: 9px; top: -3px; font: 500 9px/1 var(--font-space-grotesk), sans-serif; color: #fef3c7; white-space: nowrap; text-shadow: 0 1px 2px #000; }
.pad { position: relative; transform: translate(-50%, -50%); pointer-events: auto; }
.pad i { display: block; width: 8px; height: 8px; transform: rotate(45deg); background: #a78bfa; box-shadow: 0 0 0 1.5px rgba(15,23,42,.85); }
`;
