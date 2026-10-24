"use client";

import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { useEffect, useRef } from "react";

export type MapPost = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  hub?: boolean;
  status: "ok" | "low" | "out";
  flooded: boolean;
  outbreak: string | null;
};
export type MapFlight = { id: string; from: string; to: string; mode: "drone" | "road"; status: string; departAt?: number; arriveAt?: number };

const COLOR = { ok: "#34d399", low: "#fbbf24", out: "#ef4444" };

// Map of health posts (coloured by stock health) and supply flights. Proposed flights are dashed;
// approved ones animate a drone or truck along the line.
export default function SupplyMap({ posts, flights, selected, onSelect }: { posts: MapPost[]; flights: MapFlight[]; selected: string | null; onSelect: (id: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const movers = useRef<{ marker: Leaflet.Marker; from: [number, number]; to: [number, number]; dep: number; arr: number }[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    (async () => {
      const leaflet = await import("leaflet");
      if (cancelled || !el.current || map.current) return;
      L.current = leaflet;
      map.current = leaflet.map(el.current, { zoomControl: false, attributionControl: true }).fitBounds([[15.28, -90.47], [15.87, -89.78]], { padding: [30, 30] });
      // Satellite imagery underneath, place names on top.
      leaflet
        .tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
          attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
          maxZoom: 18,
        })
        .addTo(map.current);
      leaflet
        .tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, opacity: 0.8 })
        .addTo(map.current);
      layer.current = leaflet.layerGroup().addTo(map.current);
      const animate = () => {
        const now = Date.now();
        for (const m of movers.current) {
          const t = Math.min(1, Math.max(0, (now - m.dep) / (m.arr - m.dep)));
          m.marker.setLatLng([m.from[0] + (m.to[0] - m.from[0]) * t, m.from[1] + (m.to[1] - m.from[1]) * t]);
        }
        raf = requestAnimationFrame(animate);
      };
      animate();
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const leaflet = L.current;
    const group = layer.current;
    if (!leaflet || !group) return;
    group.clearLayers();
    movers.current = [];
    const at = (id: string) => {
      const p = posts.find((x) => x.id === id);
      return p ? ([p.lat, p.lng] as [number, number]) : null;
    };

    for (const f of flights) {
      const a = at(f.from), b = at(f.to);
      if (!a || !b || f.status === "delivered") continue;
      const flying = f.status === "flying";
      leaflet
        .polyline([a, b], {
          color: f.mode === "drone" ? "#38bdf8" : "#a78bfa",
          weight: flying ? 3 : 2,
          opacity: flying ? 0.9 : 0.5,
          dashArray: flying ? undefined : "6 6",
        })
        .addTo(group);
      if (flying && f.departAt && f.arriveAt) {
        const icon = leaflet.divIcon({ className: "", html: `<div style="font-size:20px;filter:drop-shadow(0 0 4px #000)">${f.mode === "drone" ? "🛩️" : "🚚"}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
        const marker = leaflet.marker(a, { icon, interactive: false }).addTo(group);
        movers.current.push({ marker, from: a, to: b, dep: f.departAt, arr: f.arriveAt });
      }
    }

    for (const p of posts) {
      const ring = p.outbreak ? "#ef4444" : selected === p.id ? "#ffffff" : "#0f172a";
      const m = leaflet
        .circleMarker([p.lat, p.lng], {
          radius: p.hub ? 13 : 9,
          color: ring,
          weight: p.outbreak || selected === p.id ? 4 : 2,
          fillColor: COLOR[p.status],
          fillOpacity: 0.95,
        })
        .addTo(group);
      m.bindTooltip(`${p.hub ? "🏥 " : ""}${p.name}${p.flooded ? " · 🌊 road flooded" : ""}${p.outbreak ? ` · ⚠️ ${p.outbreak} outbreak` : ""}`, {
        direction: "top",
        offset: [0, -8],
      });
      m.on("click", () => onSelectRef.current(p.id));
      if (p.flooded) {
        leaflet
          .marker([p.lat, p.lng], { icon: leaflet.divIcon({ className: "", html: `<div style="font-size:16px;transform:translate(10px,-18px)">🌊</div>`, iconSize: [16, 16] }), interactive: false })
          .addTo(group);
      }
    }
  }, [posts, flights, selected]);

  return <div ref={el} className="h-full min-h-[420px] w-full rounded-2xl" />;
}
