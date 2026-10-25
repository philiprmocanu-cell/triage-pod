"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";
import { SettlementIndex, catchments, earthUrl, fmtPeople, kindOf, kmBetween, mapsSatelliteUrl, nameOf, servedBy, type Catchment, type Settlement, type SettlementSources } from "@/lib/settlements/geo";
import { GROUND, bandOf, kmPerPx, polar2Cartesian, restrokePaths, type Band } from "@/lib/map/pin";
import { FLOOD_COLOR, KIND_COLOR, geomKey, parseWaypoints, routeColor, routeStroke, runOf, type RouteState } from "@/lib/map/routes";
import { RouteLegend } from "@/lib/map/legend";
import { demoGroups, hamletId, particleTexture, settlementGroups, settlementStyle, type ThreeLite } from "@/lib/map/settlements";

// Live 3D view of the pod network, fed straight from SpacetimeDB. Nothing on it is pre-made:
// a dot is a health post, and it only lights up when a pod there flags a need. The need becomes
// an order with the patient's name and flies (drone) or drives (truck, along the planned road)
// from wherever the medicine actually is to the patient's home. Click a post to see what it asked
// for and what it sent; the layer buttons show or hide the flights, the hubs and the villages.
//
// Under the posts, every settlement in the province (tens of thousands: GeoNames names plus
// Google Open Buildings roof clusters, see tools/settlements/fetch.py) is drawn as a tiny dot with
// the particles layer — one GPU draw, no DOM. Hover shows the name, a click opens the post that
// serves it. EVERYTHING sits at ground level (altitude 0: posts, village dots, movers, pops, pins,
// roads) so it stays on its pixel when the view is oblique or zoomed in; anything lifted above the
// ground in globe units parallaxes away from its spot (0.004 was ~90 px at the near zoom). Depth
// cues (the mover icon above the road, the "+1" bubble floating up) are CSS transforms inside a
// zero-size anchor. The HTML markers keep their element between frames and only the movers'
// positions are written per frame.
//
// Planned routes (route_plan.waypoints) are drawn as fat lines in the carrier's colour, red where
// the flood check said high, dashed and animated while moving, dim once delivered; multi-stop runs
// get numbered stop markers; drones fly as arcs. A click on a line opens the destination's panel.

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
type VillageMarker = { kind: "village"; v: Village; lat: number; lng: number; state: "quiet" | "active" | "picked"; online: boolean; el?: HTMLElement; tint?: string; bug?: string };
type RoadDot = { kind: "onroad"; id: string; lat: number; lng: number; name: string; color: string };
type MoverMarker = { kind: "mover"; id: string; lat: number; lng: number; mode: string; label: string; el?: HTMLElement };
type StopMarker = { kind: "stop"; id: string; lat: number; lng: number; n: number; run: string; name: string };
type Marker =
  | VillageMarker
  | { kind: "pop"; id: number; lat: number; lng: number; text: string; tone: string }
  | MoverMarker
  | StopMarker
  | RoadDot
  | { kind: "flood"; id: string; lat: number; lng: number; text: string; why?: string; runId?: string }
  | { kind: "pin"; lat: number; lng: number }
  | { kind: "caption"; id: string; lat: number; lng: number; place: string; truck: string; villages: number; tag: string; color: string; runId: string }
  | { kind: "depart"; id: string; lat: number; lng: number; color: string; runId: string };
type Layers = { flights: boolean; hubs: boolean; labels: boolean; villages: boolean; pin: boolean };
// A planned road, ready to draw and to walk a mover along.
type RoadPath = {
  key: string;
  planId: string;
  pts: [number, number][];
  cum: number[];
  total: number;
  mode: string;
  carrier: string | undefined; // carrier kind: truck, pickup, motorbike, bicycle, boat, drone
  flood: string;
  state: RouteState;
  moving: boolean;
  orderId: string;
  toVillageId: number;
  run: ReturnType<typeof runOf>;
  tone?: "red" | "yellow" | "green";
  why?: string;
  reroute?: boolean;
  full?: [number, number][];
  shade?: string;
  hue?: string;
  ink?: string | string[];
};
type Arc = { a: Village; b: Village; mode: string; kind: string; flood: string; state: RouteState };
type StoredRun = {
  id: string;
  carrierId: number;
  truck: string;
  place?: string;
  color: string;
  glow: string;
  km: number;
  points: [number, number][];
  wet: [number, number][];
  reroute: boolean;
  tone: "red" | "yellow" | "green";
  why: string;
  loadKg: number;
  freeKg: number;
  capacityKg: number;
  visits?: number;
  label: { lat: number; lng: number; text: string; why?: string } | null;
  stops: { id: string; name: string; lat: number; lng: number; post?: boolean }[];
  branches?: { id: string; name: string; lat: number; lng: number; from: [number, number]; km: number }[];
  onRoad?: { id: string; name: string; lat: number; lng: number }[];
};
type Pin = { lat: number; lng: number; hamlet: (Settlement & { km: number }) | null; post: { v: Village; km: number } | null };
type PickedSettlement = { s: Settlement; served: { post: Village; km: number } | null };

let feedSeq = 0;
const short = (name: string) => name.replace(/ \(.*\)$/, "");
const plain = (text: string) => text.replace(/[\p{Extended_Pictographic}️]/gu, "").trim();
const DONE_ROADS_SHOWN = 8;
const LIFE = ["Rectal artesunate", "Ceftriaxone (pre-referral)", "Oral rehydration salts", "Antimalarial (ACT)"];
// Same shelf minimums the dispatch planner uses. A post under any of these is short.
const MIN_QTY: Record<string, number> = {
  "Malaria rapid test": 6, "Antimalarial (ACT)": 4, "Rectal artesunate": 2, Amoxicillin: 4, "Ceftriaxone (pre-referral)": 2,
  "Oral rehydration salts": 6, Zinc: 4, Paracetamol: 6, "Salbutamol inhaler": 1, Aspirin: 2, "Glucose gel": 2,
  "Wound dressing kit": 3, "Tetanus vaccine": 2, "Therapeutic food (RUTF)": 7, Splint: 2,
  "Malaria vaccine (R21)": 4, "Measles-rubella vaccine": 4, "Pentavalent vaccine": 4, "PCV vaccine": 4, "Rotavirus vaccine": 3, "Polio vaccine (OPV)": 4, "BCG vaccine": 2, "HPV vaccine": 2,
};
const TRUCK_HUES = ["#22d3ee", "#f8fafc", "#a3e635", "#fb923c", "#c084fc", "#38bdf8", "#34d399", "#e879f9", "#fde047", "#2dd4bf", "#818cf8", "#fb7185", "#67e8f9", "#f472b6", "#fdba74"];
const LUNDAZI_HUE = "#fbbf24";
const PROVINCE_ALT = 0.07;
const PROVINCE_VIEW = { lat: -13.15, lng: 32.4, altitude: 0.118 };
const CLOSE_VIEW = { lat: -13.45, lng: 32.2, altitude: 0.058 };
const FRECKLE_IN = { lat: -13.45, lng: 32.2, altitude: 0.034 };

function hexAlpha(hex: string, alpha: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function mixHex(a: string, b: string, t: number) {
  const parse = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const A = parse(a);
  const B = parse(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function coreInk(hex: string) {
  return [mixHex(hex, "#ffffff", 0.72), mixHex(hex, "#67e8f9", 0.5), mixHex(hex, "#f0abfc", 0.55), mixHex(hex, "#e0f2fe", 0.64)];
}

function bloomTint(hex: string) {
  return hexAlpha(mixHex(hex, "#7ef9ff", 0.55), 0.26);
}

function stitchInk(hex: string, i: number) {
  const edge = i % 2 === 0 ? "#67e8f9" : "#f0abfc";
  return [mixHex(hex, "#ffffff", 0.68), mixHex(hex, edge, 0.58)];
}

// Pixel widths. Close zoom is a fine wire; the province view is thinner, still thick enough to
// follow. The bloom stays just wider than the core so parallel roads do not smear together.
let wireAlt = 0.12;

function wireAt(alt: number, close: number, province: number, far: number) {
  if (alt <= 0.058) return close;
  if (alt >= 0.2) return far;
  if (alt <= 0.118) return close + ((province - close) * (alt - 0.058)) / (0.118 - 0.058);
  return province + ((far - province) * (alt - 0.118)) / (0.2 - 0.118);
}

function strokeOf(r: { key: string }) {
  const alt = wireAlt;
  if (r.key.includes("-glow")) return r.key.includes("-branch") ? wireAt(alt, 2.6, 2.05, 1.75) : wireAt(alt, 3.8, 2.7, 2.25);
  if (r.key.includes("-branch")) return wireAt(alt, 1.7, 1.35, 1.15);
  if (r.key.endsWith("-wet")) return wireAt(alt, 1.15, 0.95, 0.85);
  return wireAt(alt, 2.5, 1.85, 1.55);
}

function dressRoad(leg: RoadPath): RoadPath[] {
  const pts = leg.pts.slice();
  if (leg.key.endsWith("-wet") || leg.key.includes("-glow") || leg.key.includes("-branch")) return [{ ...leg, pts }];
  const hue = leg.hue || "#e2e8f0";
  const core: RoadPath = { ...leg, pts, ink: coreInk(hue), shade: undefined };
  const glow: RoadPath = { ...core, key: `${leg.key}-glow`, ink: bloomTint(hue), pts: pts.slice() };
  return [glow, core];
}

function bloomHop(h: RoadPath): RoadPath[] {
  if (h.key.includes("-glow")) return [h];
  const hue = h.hue || "#e2e8f0";
  const core: RoadPath = { ...h, ink: h.ink ?? stitchInk(hue, 0), shade: undefined };
  const glow: RoadPath = { ...core, key: `${h.key}-glow`, ink: bloomTint(hue) };
  return [glow, core];
}

function placeOfRun(run: { truck: string; place?: string }) {
  if (run.place && !/^ZAMMSA/i.test(run.place)) return run.place;
  const m = run.truck.match(/pickup\s+(.+)$/i);
  if (m) return m[1].replace(/ \(.*\)$/, "");
  if (/cold/i.test(run.truck)) return "Cold chain";
  return run.truck.replace(/^ZAMMSA\s+/i, "");
}

function coveredVillages(run: { stops: unknown[]; branches?: unknown[]; onRoad?: unknown[] }) {
  return run.stops.length + (run.branches?.length ?? 0) + (run.onRoad?.length ?? 0);
}

const TRUCK_KMH = 50;
// Rural health-post norm in the Ministry of Health facility standards, as stated in the
// IHME ABCE Zambia report (2015): about 3,500 people, 500 households.
const POST_CATCHMENT = 3500;
// Ministry of Health HMIS, National Health Strategic Plan 2017–2021 mid-term review.
// National outpatient visits were 1.3 per person per year. Eastern Province was 1.8.
// The lower national figure is the one used.
const OPD_PER_YEAR = 1.3;
// HMIS 2018, same review: malaria 23% of new outpatient visits, non-bloody diarrhoea
// about 7%, pneumonia about 2%. 30% keeps ordinary coughs out. Rectal artesunate
// sits inside the malaria share and is not added again.
const COVERED_SHARE = 0.3;
// Zambia National Supply Chain Assessment 2024 (Ministry of Health and USAID GHSC-PSM):
// 26% of health posts were stocked out on the day of the visit. That is below the
// 47.9% pediatric ACT stockout in control districts in Vledder et al., Health Systems
// & Reform, 2019, so the later, lower rate is the one used.
const STOCKOUT_SHARE = 0.26;

type WaveSavings = {
  lives: number;
  posts: number;
  perPost: number;
  sharedKm: number;
  separateKm: number;
  hours: number;
  sentence: string;
};

function roadCum(pts: [number, number][]) {
  const cum = new Array<number>(pts.length);
  cum[0] = 0;
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + kmBetween(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return cum;
}

function kmAlong(pts: [number, number][], cum: number[], lat: number, lng: number) {
  let best = Infinity;
  let idx = 0;
  const step = pts.length > 900 ? 4 : 1;
  for (let i = 0; i < pts.length; i += step) {
    const d = kmBetween(lat, lng, pts[i][0], pts[i][1]);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  for (let i = Math.max(0, idx - step); i <= Math.min(pts.length - 1, idx + step); i++) {
    const d = kmBetween(lat, lng, pts[i][0], pts[i][1]);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return cum[idx] ?? 0;
}

function hoursLabel(hours: number) {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function clinicStop(stop: { id: string; post?: boolean }) {
  return stop.post === true || stop.id.startsWith("post-");
}

// One-way kilometres from this truck's own store along its OpenStreetMap line.
// A loop that comes back to the store uses the shorter way, not the long way round.
function oneWayFromStore(pts: [number, number][], cum: number[], lat: number, lng: number) {
  const along = kmAlong(pts, cum, lat, lng);
  const total = cum[cum.length - 1] ?? 0;
  const last = pts[pts.length - 1];
  const closed = !!last && kmBetween(pts[0][0], pts[0][1], last[0], last[1]) <= 8;
  if (closed && total > 0) return Math.min(along, Math.max(0, total - along));
  return along;
}

// Monthly patients at the short posts this wave stops at, plus driving time for the
// roads already drawn. Hamlets and dashed hops do not add a caseload. Hours are not lives.
function waveSavings(runs: StoredRun[], villages: Map<number, Village>): WaveSavings | null {
  if (!runs.length) return null;
  const hub = [...villages.values()].find((v) => v.hub);
  const seenPosts = new Set<string>();
  let posts = 0;
  let shared = 0;
  let separate = 0;
  for (const run of runs) {
    shared += run.km;
    if (run.points.length < 2) continue;
    const cum = roadCum(run.points);
    const seenStops = new Set<string>();
    for (const stop of run.stops) {
      if (!stop.id || seenStops.has(stop.id)) continue;
      seenStops.add(stop.id);
      const out = 2 * oneWayFromStore(run.points, cum, stop.lat, stop.lng);
      if (out >= 2) separate += out;
      if (!clinicStop(stop) || seenPosts.has(stop.id)) continue;
      if (hub && stop.id === `post-${hub.id}`) continue;
      const village = stop.id.startsWith("post-") ? villages.get(Number(stop.id.slice(5))) : undefined;
      if (village?.hub) continue;
      seenPosts.add(stop.id);
      posts += 1;
    }
  }
  const visits = Math.round((POST_CATCHMENT * OPD_PER_YEAR) / 12);
  const perPost = Math.round(visits * COVERED_SHARE * STOCKOUT_SHARE);
  const lives = perPost * posts;
  const sharedKm = Math.round(shared);
  const separateKm = Math.round(separate);
  const hours = Math.max(0, Math.round(((separateKm - sharedKm) / TRUCK_KMH) * 10) / 10);
  const kmText = (n: number) => n.toLocaleString();
  const hourText = hoursLabel(hours);
  const timeClause = separateKm > sharedKm
    ? `The shared OpenStreetMap tours are ${kmText(sharedKm)} km. Separate out-and-back trips from each truck’s own store to the posts and stops that truck serves are ${kmText(separateKm)} km. At ${TRUCK_KMH} km/h that difference is ${hourText} hours of driving.`
    : `The shared OpenStreetMap tours are ${kmText(sharedKm)} km. Separate out-and-back trips from each truck’s own store to the posts and stops that truck serves are ${kmText(separateKm)} km. At ${TRUCK_KMH} km/h the shared tours do not save driving time (${hourText} hours), because the shared roads are not shorter than those separate trips.`;
  const method = `This is a monthly estimate for the short health posts this wave stops at, not a census of the villages. A rural health post serves about ${POST_CATCHMENT.toLocaleString()} people (Zambia Ministry of Health norm, IHME ABCE Zambia, 2015). Ministry of Health HMIS recorded ${OPD_PER_YEAR} outpatient visits per person per year nationally, against 1.8 in Eastern Province (National Health Strategic Plan 2017–2021 mid-term review), so the lower figure is used: about ${visits.toLocaleString()} visits a month. In the 2018 HMIS, malaria was 23% of new outpatient visits, non-bloody diarrhoea about 7%, and pneumonia about 2%. Counted at ${Math.round(COVERED_SHARE * 100)}% so ordinary coughs are left out, and rectal artesunate is already inside the malaria share. The Zambia National Supply Chain Assessment 2024 (Ministry of Health and USAID GHSC-PSM) found ${Math.round(STOCKOUT_SHARE * 100)}% of health posts out of stock on the day of the visit, below the older 48% pediatric ACT stockout in control districts (Vledder and others, 2019). ${visits.toLocaleString()} × ${Math.round(COVERED_SHARE * 100)}% × ${Math.round(STOCKOUT_SHARE * 100)}% is ${perPost} people a post who would miss an antimalarial, oral rehydration salts, or an antibiotic that month.`;
  const reached = posts === 0
    ? "This wave does not stop at a short health post, so the monthly estimate is 0 people."
    : `This wave stops at ${posts} short ${posts === 1 ? "post" : "posts"}, and ${perPost} × ${posts} = ${lives.toLocaleString()} people.`;
  const sentence = `${method} ${reached} A hamlet with no clinic, including a dashed hop, does not add patients. ${timeClause} Those hours are not a count of lives.`;
  return { lives, posts, perPost, sharedKm, separateKm, hours, sentence };
}

function assignHues<T extends { truck: string; place?: string; color: string }>(runs: T[]): T[] {
  let i = 0;
  return runs.map((run) => {
    const place = placeOfRun(run);
    const lundaziPickup = /lundazi/i.test(place) && /pickup/i.test(run.truck);
    const color = lundaziPickup ? LUNDAZI_HUE : TRUCK_HUES[i++ % TRUCK_HUES.length];
    return { ...run, place, color };
  });
}

// Shared kilometres out of Chipata would otherwise paint three strokes on one line.
// Nudge only the vertices that sit on another truck, so the split is visible and a lone road stays on the pavement.
function separateShared(lines: [number, number][][], gapKm = 0.55): [number, number][][] {
  const cell = 0.025;
  const key = (lat: number, lng: number) => `${Math.round(lat / cell)}:${Math.round(lng / cell)}`;
  const owners = new Map<string, number[]>();
  lines.forEach((line, li) => {
    const seen = new Set<string>();
    for (let i = 0; i < line.length; i += 2) {
      const k = key(line[i][0], line[i][1]);
      if (seen.has(k)) continue;
      seen.add(k);
      const list = owners.get(k) ?? [];
      if (!list.includes(li)) list.push(li);
      owners.set(k, list);
    }
  });
  return lines.map((line, li) => line.map((p, i) => {
    const who = owners.get(key(p[0], p[1]));
    if (!who || who.length < 2) return p;
    const lane = who.indexOf(li);
    const shift = (lane - (who.length - 1) / 2) * gapKm;
    if (Math.abs(shift) < 0.02) return p;
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const cos = Math.cos((p[0] * Math.PI) / 180);
    const north = b[0] - a[0];
    const east = (b[1] - a[1]) * cos;
    const len = Math.hypot(north, east) || 1;
    const nx = -east / len;
    const ny = north / len;
    return [p[0] + (shift / 111) * nx, p[1] + (shift / 111) * ny / cos] as [number, number];
  }));
}

function degApart(a: [number, number], b: [number, number]) {
  return Math.hypot(a[0] - b[0], (a[1] - b[1]) * 0.974);
}

function roadSamples(line: [number, number][], n = 32): [number, number][] {
  if (line.length < 2) return line.slice();
  const seg = [0];
  for (let i = 1; i < line.length; i++) seg.push(seg[i - 1] + degApart(line[i - 1], line[i]));
  const total = seg[seg.length - 1];
  if (total < 1e-6) return [line[Math.floor(line.length / 2)]];
  const out: [number, number][] = [];
  for (let s = 0; s < n; s++) {
    const target = (total * (s + 0.5)) / n;
    let i = 1;
    while (i < seg.length - 1 && seg[i] < target) i++;
    const span = seg[i] - seg[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (target - seg[i - 1]) / span));
    out.push([
      line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
      line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
    ]);
  }
  return out;
}

// A label box at province altitude is about 0.7° wide and 0.3° tall. Clearance ≥ 1 means the boxes do not touch.
function labelClearance(a: [number, number], b: [number, number]) {
  const dx = Math.abs(a[1] - b[1]) * 0.974;
  const dy = Math.abs(a[0] - b[0]);
  return Math.max(dx / 0.7, dy / 0.3);
}

// Sit each name on the stretch of road no other truck uses, then slide it along that road until the boxes clear.
function labelSeats(lines: [number, number][][]): [number, number][] {
  const samples = lines.map((line) => roadSamples(line));
  const apart = samples.map((pts, i) => pts.map((p) => {
    let near = Infinity;
    for (let j = 0; j < samples.length; j++) {
      if (j === i) continue;
      for (const q of samples[j]) near = Math.min(near, degApart(p, q));
    }
    return near;
  }));
  const seats: [number, number][] = new Array(lines.length);
  const taken: [number, number][] = [];
  const order = lines.map((_, i) => {
    let span = 0;
    for (const p of samples[i]) for (const q of samples[i]) span = Math.max(span, degApart(p, q));
    return { i, span };
  }).sort((a, b) => a.span - b.span);
  for (const { i } of order) {
    const pts = samples[i];
    const ex = apart[i];
    const peak = Math.max(...ex, 0);
    let best = pts[Math.floor(pts.length / 2)];
    let bestScore = -1;
    for (let k = 0; k < pts.length; k++) {
      let sep = taken.length ? Infinity : 2;
      for (const q of taken) sep = Math.min(sep, labelClearance(pts[k], q));
      const mid = 1 - Math.abs(k / (pts.length - 1) - 0.5);
      const own = peak > 0 ? ex[k] / peak : 1;
      const score = sep + mid * 0.12 + own * 0.08;
      if (score > bestScore) {
        bestScore = score;
        best = pts[k];
      }
    }
    seats[i] = best;
    taken.push(best);
  }
  return seats;
}

function shelfTone(hub: boolean, rows: { item: string; qty: number }[]): "red" | "yellow" | null {
  if (hub || !rows.length) return null;
  const qty = (item: string) => rows.find((s) => s.item === item)?.qty ?? 0;
  const short = Object.entries(MIN_QTY).some(([item, need]) => qty(item) < need);
  if (!short) return null;
  return LIFE.some((item) => qty(item) <= 0) ? "red" : "yellow";
}

function needTone(id: number, stock: { villageId: number; item: string; qty: number }[], visits: { villageId: number; urgency: string }[]): "red" | "yellow" | "green" {
  if (visits.some((v) => v.villageId === id && v.urgency === "red")) return "red";
  const mine = stock.filter((s) => s.villageId === id);
  if (mine.some((s) => LIFE.includes(s.item) && s.qty <= 0)) return "red";
  if (mine.some((s) => s.qty < 5)) return "yellow";
  return "green";
}

function placeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")[0] ?? "";
}

function paintDot(dot: HTMLElement, tint?: string) {
  if (!tint) {
    dot.style.background = "";
    dot.style.boxShadow = "";
    dot.style.border = "";
    return;
  }
  const solid = tint.startsWith("#") ? tint : tint.replace(/[\d.]+\)$/, "1)");
  dot.style.background = tint.startsWith("#") ? `${tint}73` : tint.replace(/[\d.]+\)$/, "0.45)");
  dot.style.border = `1px solid ${solid}`;
  dot.style.boxShadow = `0 0 12px ${solid}`;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleSettlements(points: Settlement[], frac: number, avoid: Set<string>, rnd: () => number) {
  const target = Math.max(8, Math.round(points.length * frac));
  let pool = points.filter((s) => !avoid.has(hamletId(s)));
  if (pool.length < target) pool = points;
  const idx = pool.map((_, i) => i);
  const n = Math.min(target, idx.length);
  const out: Settlement[] = [];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    const swap = idx[i];
    idx[i] = idx[j];
    idx[j] = swap;
    out.push(pool[idx[i]]);
  }
  return out;
}

const URGENCY_COLOR = { red: "rgba(255,70,70,0.92)", yellow: "rgba(251,191,36,0.92)" };

function callHamlets(
  points: Settlement[],
  assign: Int32Array | null,
  posts: { id: number; lat: number; lng: number; hub: boolean; tone: "red" | "yellow" | "green"; orders: number }[],
  avoid: Set<string>,
  rnd: () => number,
) {
  const target = Math.max(8, Math.round(points.length * 0.15));
  const byId = new Map(posts.map((p) => [p.id, p]));
  const skipAvoid = avoid.size > points.length * 0.4;
  const pool: { s: Settlement; tone: "red" | "yellow"; weight: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const s = points[i];
    if (!skipAvoid && avoid.has(hamletId(s))) continue;
    let post = assign ? byId.get(assign[i]) : undefined;
    if (!post) {
      let best = Infinity;
      for (const p of posts) {
        if (p.hub) continue;
        const d = kmBetween(s.la, s.ln, p.lat, p.lng);
        if (d < best) {
          best = d;
          post = p;
        }
      }
    }
    if (!post || post.hub || post.tone === "green") continue;
    pool.push({ s, tone: post.tone, weight: (post.tone === "red" ? 3 : 1) + Math.min(3, post.orders) });
  }
  if (pool.length < 8) return [];
  return pool
    .map((p) => ({ ...p, k: Math.pow(rnd(), 1 / p.weight) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, Math.min(target, pool.length));
}

const CALL_N = 2300;

function sampleCall(points: Settlement[], avoid: Set<string>, rnd: () => number) {
  const fresh = points.filter((s) => !avoid.has(hamletId(s)));
  const pool = (fresh.length >= CALL_N ? fresh : points).slice();
  const n = Math.min(CALL_N, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}

function outlookMarks(sources: unknown) {
  const src = Array.isArray(sources) ? sources.join("\n") : "";
  return {
    meteo: /Open-Meteo forecast/i.test(src),
    glofas: /GloFAS/i.test(src),
    nasa: /NASA/i.test(src),
  };
}

function liveFloodFrom(body: { posts?: { name?: string; floodRiskToday?: string | boolean; floodRisk14d?: string | boolean }[]; sources?: string[] } | null) {
  const posts = body?.posts ?? [];
  const wet = posts.filter((p) => p.floodRiskToday === "high" || p.floodRiskToday === "medium" || p.floodRiskToday === true || p.floodRisk14d === "high");
  const blocked = wet.map((p) => short(p.name ?? "")).filter(Boolean);
  if (!posts.length) return { dry: true, blocked: [] as string[], note: "The live flood outlook did not answer." };
  if (!wet.length) return { dry: true, blocked: [] as string[], note: "The live flood outlook is dry." };
  const names = blocked.slice(0, 3).join(", ");
  return { dry: false, blocked, note: names ? `The live outlook shows flood risk at ${names}.` : "The live outlook shows flood risk." };
}

function snapHamlets(
  hamlets: { id: string; lat: number; lng: number }[],
  runs: { color: string; points: [number, number][]; stops?: { id: string; lat: number; lng: number }[] }[],
) {
  const served = new Map<string, { la: number; ln: number; color: string }>();
  const place = (id: string, lat: number, lng: number, pts: [number, number][], color: string, limit: number) => {
    let best = limit;
    let at: [number, number] | null = null;
    for (let i = 0; i < pts.length; i += 2) {
      const d = kmBetween(lat, lng, pts[i][0], pts[i][1]);
      if (d < best) {
        best = d;
        at = pts[i];
      }
    }
    if (at) served.set(id, { la: at[0], ln: at[1], color });
  };
  for (const h of hamlets) {
    let best = 2.4;
    let at: [number, number] | null = null;
    let color = "";
    for (const run of runs) {
      const pts = run.points;
      for (let i = 0; i < pts.length; i += 2) {
        const d = kmBetween(h.lat, h.lng, pts[i][0], pts[i][1]);
        if (d < best) {
          best = d;
          at = pts[i];
          color = run.color;
        }
      }
    }
    if (at) served.set(h.id, { la: at[0], ln: at[1], color });
  }
  for (const run of runs) {
    for (const stop of run.stops ?? []) place(stop.id, stop.lat, stop.lng, run.points, run.color, 12);
  }
  return served;
}

function nearestRoad(pts: [number, number][], lat: number, lng: number): [number, number] {
  let best = pts[0];
  let bestKm = Infinity;
  for (const p of pts) {
    const d = kmBetween(lat, lng, p[0], p[1]);
    if (d < bestKm) { bestKm = d; best = p; }
  }
  return best;
}

function lineCum(pts: [number, number][]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + kmBetween(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return cum;
}

function smoothstep(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// Paint along kilometres, not along vertex count, so a dense cluster of points cannot finish the road in one frame.
function growByDistance(pts: [number, number][], cum: number[], t: number): [number, number][] {
  if (pts.length < 2) return pts;
  const total = cum[cum.length - 1] || 0;
  if (t >= 1 || total <= 0) return pts;
  const target = Math.max(total * t, 0.2);
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const span = cum[i] - cum[i - 1] || 1;
  const u = Math.min(1, Math.max(0, (target - cum[i - 1]) / span));
  const a = pts[i - 1];
  const b = pts[i];
  return [...pts.slice(0, i), [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]];
}

function orientFromStore(line: [number, number][], lat: number, lng: number) {
  if (line.length < 2) return line.slice();
  const d0 = kmBetween(lat, lng, line[0][0], line[0][1]);
  const d1 = kmBetween(lat, lng, line[line.length - 1][0], line[line.length - 1][1]);
  return d1 < d0 ? line.slice().reverse() : line.slice();
}

function truckWord(name: string) {
  if (/cold/i.test(name)) return "cold-chain van";
  const hub = name.match(/hub truck\s*\d*/i);
  if (hub) return hub[0].toLowerCase();
  if (/pickup/i.test(name)) return "pickup";
  return name.replace(/^ZAMMSA\s+/i, "");
}

function districtOf(place: string) {
  return place.replace(/\s+(cold|hub)$/i, "");
}

function revealGroups(
  all: Settlement[],
  reached: Set<string>,
  fade: number,
  flash: boolean,
  live?: { retired: Set<string>; shrink: Set<string>; shrinkT: number },
) {
  const reds: Settlement[] = [];
  const fading: Settlement[] = [];
  const whites: Settlement[] = [];
  for (const s of all) {
    const id = hamletId(s);
    if (!reached.has(id)) {
      whites.push(s);
      continue;
    }
    if (live?.retired.has(id)) continue;
    if (live?.shrink.has(id)) fading.push(s);
    else reds.push(s);
  }
  const groups: { list: Settlement[]; size: number; color: string }[] = [];
  if (fade >= 0.25 && whites.length) groups.push({ list: whites, size: 0.016, color: `rgba(248,250,252,${fade.toFixed(2)})` });
  if (reds.length) groups.push({ list: reds, size: flash ? 0.05 : 0.032, color: flash ? "#ff1f1f" : "#ff3b3b" });
  const shrinkSize = 0.032 * (1 - (live?.shrinkT ?? 0));
  if (fading.length && shrinkSize > 0.006) groups.push({ list: fading, size: shrinkSize, color: "#ff3b3b" });
  return groups;
}

const SOURCE_CARDS = [
  { id: "nasa", name: "NASA flood map", check: "MODIS and VIIRS flood water", needs: "nasa" as const, src: "/logos/nasa.svg" },
  { id: "osm", name: "OpenStreetMap", check: "Roads the trucks drive", needs: "osm" as const, src: "/logos/osm.svg" },
  { id: "meteo", name: "Open-Meteo", check: "Rain over the next days", needs: "meteo" as const, src: "/logos/open-meteo.png" },
  { id: "glofas", name: "GloFAS", check: "Copernicus river forecast", needs: "glofas" as const, src: "/logos/copernicus.png" },
  { id: "esri", name: "Esri", check: "Satellite imagery", needs: "esri" as const, src: "/logos/esri.jpg" },
];

function ring(lat: number, lng: number, km: number): [number, number][] {
  const out: [number, number][] = [];
  const R = 6371;
  for (let i = 0; i <= 40; i++) {
    const br = (i / 40) * Math.PI * 2;
    const d = km / R;
    const φ1 = (lat * Math.PI) / 180;
    const λ1 = (lng * Math.PI) / 180;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br));
    const λ2 = λ1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
    out.push([(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI]);
  }
  return out;
}

function ribbon(pts: [number, number][], halfKm: number): { type: "Polygon"; coordinates: [number, number][][] } | null {
  if (pts.length < 2) return null;
  const step = Math.max(1, Math.floor(pts.length / 70));
  const sampled = pts.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < sampled.length; i++) {
    const a = sampled[Math.max(0, i - 1)];
    const b = sampled[Math.min(sampled.length - 1, i + 1)];
    const dlat = b[0] - a[0];
    const dlng = b[1] - a[1];
    const len = Math.hypot(dlat, dlng) || 1;
    const k = halfKm / 111;
    const olat = (-dlng / len) * k;
    const olng = ((dlat / len) * k) / Math.max(0.2, Math.cos((sampled[i][0] * Math.PI) / 180));
    left.push([sampled[i][1] + olng, sampled[i][0] + olat]);
    right.push([sampled[i][1] - olng, sampled[i][0] - olat]);
  }
  right.reverse();
  return { type: "Polygon", coordinates: [[...left, ...right, left[0]]] };
}

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
  const heardRef = useRef(new Map<string, string>()); // village first word -> a species the listener was sure about
  const rebuildRef = useRef<() => void>(() => {});
  const pickedRef = useRef<Village | null>(null);
  const layersRef = useRef<Layers>({ flights: true, hubs: true, labels: false, villages: true, pin: false });
  const roads = useRef(new Map<string, RoadPath>()); // by plan key, so globe.gl keeps the same path object between redraws
  const roadByOrder = useRef(new Map<string, RoadPath>());
  const stops = useRef(new Map<string, StopMarker>()); // numbered stops of multi-stop runs, stable objects
  const pickedPlanRef = useRef<string | null>(null); // a route the user clicked: drawn bright and thick
  const [pickedPlan, setPickedPlan] = useState<string | null>(null);
  const settlements = useRef<Settlement[]>([]);
  const index = useRef<SettlementIndex | null>(null);
  const catchRef = useRef<{ assign: Int32Array; byPost: Map<number, Catchment> } | null>(null);
  const pinRef = useRef<Pin | null>(null);
  const [connected, setConnected] = useState<"connecting" | "live" | "offline">("connecting");
  const [embed, setEmbed] = useState(false);
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
  const [netOpen, setNetOpen] = useState(true);
  const [feedOpen, setFeedOpen] = useState(true);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [view, setView] = useState<"routes" | "floods" | "live">("routes");
  const [reasons, setReasons] = useState<{ id: string; tone: "red" | "yellow" | "green"; name: string; why: string }[]>([]);
  const [savings, setSavings] = useState<WaveSavings | null>(null);
  const [savingsOpen, setSavingsOpen] = useState(false);
  const [floodBanner, setFloodBanner] = useState<string | null>(null);
  const floodTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [planNote, setPlanNote] = useState("");
  const [roster, setRoster] = useState<{ id: string; place: string; truck: string; villages: number; color: string; tag: string }[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [liveLine, setLiveLine] = useState(false);
  const [namesHidden, setNamesHidden] = useState(false);
  const [notice, setNotice] = useState<{ id: string; name: string; check: string; src: string } | null>(null);
  const demoRef = useRef<RoadPath[]>([]);
  const runColor = useRef(new Map<number, string>());
  const postToneRef = useRef(new Map<number, "red" | "yellow">());
  const roadSnap = useRef(new Map<number, { lat: number; lng: number }>());
  const servedRef = useRef<number[]>([]);
  const demoPaint = useRef<{ chosen: Set<string>; served: Map<string, { la: number; ln: number; color: string }>; urgency: Map<string, string> } | null>(null);
  const urgencyRef = useRef(new Map<string, string>());
  const floodMarks = useRef<{ kind: "flood"; id: string; lat: number; lng: number; text: string; why?: string; runId?: string }[]>([]);
  const focusFloodRef = useRef<(d: { lat: number; lng: number; text: string; why?: string; runId?: string }) => void>(() => {});
  const planRef = useRef<{ hamlets: { id: string; name: string; lat: number; lng: number }[]; runs: StoredRun[] } | null>(null);
  const calcSeq = useRef(0);
  const lastAvoid = useRef(new Set<string>());
  const roadDots = useRef(new Map<string, RoadDot>());
  const floodRef = useRef<{ color: string; stroke: string; geo: { type: "Polygon"; coordinates: [number, number][][] } }[]>([]);
  const drawTimer = useRef<number | null>(null);
  const holdRoads = useRef(false);
  const noticeRef = useRef<string | null>(null);
  const listeningRef = useRef(false);
  const revealRef = useRef<null | "pulse" | "roads">(null);
  const fadeRef = useRef(0.7);
  const flashRef = useRef(false);
  const marksRef = useRef({ osm: true, esri: true, meteo: false, glofas: false, nasa: false });
  const focusRef = useRef<string | null>(null);
  const focusTruckRef = useRef<(id: string) => void>(() => {});
  const roadsOnly = useRef<RoadPath[]>([]);
  const hopsByRun = useRef(new Map<string, RoadPath[]>());
  const dotsByRun = useRef(new Map<string, Set<string>>());
  const dotsGoneRef = useRef(false);
  const retiredRef = useRef(new Set<string>());
  const shrinkIdsRef = useRef(new Set<string>());
  const shrinkTRef = useRef(0);
  type Cap = { kind: "caption"; id: string; lat: number; lng: number; place: string; truck: string; villages: number; tag: string; color: string; runId: string };
  type Depart = { kind: "depart"; id: string; lat: number; lng: number; color: string; runId: string };
  const captionAll = useRef<Cap[]>([]);
  const captionShown = useRef<Cap[]>([]);
  const departAll = useRef<Depart[]>([]);
  const departShown = useRef<Depart[]>([]);
  const pictureKey = useRef("");
  const applyPictureRef = useRef<() => void>(() => {});
  const viewRef = useRef(view);
  viewRef.current = view;

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
      const snap = roadSnap.current.get(id);
      const lat = snap?.lat ?? v.lat;
      const lng = snap?.lng ?? v.lng;
      if (m.lat !== lat || m.lng !== lng) {
        m.lat = lat;
        m.lng = lng;
        const obj = (m as unknown as { __threeObjHtml?: { position: { x: number; y: number; z: number } } }).__threeObjHtml;
        if (obj) Object.assign(obj.position, polar2Cartesian(lat, lng, GROUND));
      }
      m.state = p?.id === v.id ? "picked" : activeIds.current.has(v.id) ? "active" : "quiet";
      m.online = onlineIds.current.has(v.id);
      const shelf = postToneRef.current.get(id);
      // The pod that is on is blue: it marks where this visit is, not how urgent the post is.
      m.tint = m.online ? "#38bdf8" : shelf === "red" ? "#ff5a5a" : shelf === "yellow" ? "#f5c446" : runColor.current.get(id);
      m.bug = heardRef.current.get(placeKey(v.name)) ?? "";
      if (m.el) {
        m.el.className = `${villageClass(m)}${m.tint ? " onrun" : ""}`;
        const dot = m.el.querySelector(".dot") as HTMLElement | null;
        if (dot) paintDot(dot, m.tint);
        const bug = m.el.querySelector(".bug");
        if (bug) bug.textContent = m.bug;
      }
    }
    for (const id of [...villageMarkers.current.keys()]) if (!villages.current.has(id)) { villageMarkers.current.delete(id); markersDirty.current = true; }
  };
  rebuildRef.current = rebuildVillages;

  // Which post serves which settlement, and the totals per post — once both lists are in.
  const recomputeCatchments = () => {
    if (!settlements.current.length || !villages.current.size) return;
    catchRef.current = catchments(settlements.current, posts());
    const p = pickedRef.current;
    setCatchment(p ? catchRef.current.byPost.get(p.id) ?? null : null);
  };

  const lastPickAt = useRef(0);
  const pick = (v: Village | null, focus?: { lat: number; lng: number }, keepSettlement = false, opts: { fly?: boolean; keepRoute?: boolean } = {}) => {
    if (v) lastPickAt.current = Date.now();
    else if (Date.now() - lastPickAt.current < 500) return; // the globe's own click lands right after the dot's
    pickedRef.current = v;
    setPicked(v);
    if (!keepSettlement) setPickedSettlement(null);
    if (!opts.keepRoute) { pickedPlanRef.current = null; setPickedPlan(null); }
    setCatchment(v && catchRef.current ? catchRef.current.byPost.get(v.id) ?? null : null);
    rebuildVillages();
    // Fly to the exact dot, close enough that zooming further lands on the village itself.
    const f = focus ?? (v ? { lat: v.lat, lng: v.lng } : null);
    if (f && opts.fly !== false) globeRef.current?.pointOfView({ lat: f.lat, lng: f.lng, altitude: focus ? 0.012 : 0.02 }, 900);
    redrawRoutes();
  };

  // A route line (or its row in the panel) was clicked: light it up and open the destination's panel
  // where it is, without flying off.
  const pickRoute = (planId: string, toVillageId: number) => {
    const v = villages.current.get(toVillageId) ?? null;
    pickedPlanRef.current = planId;
    setPickedPlan(planId);
    lastPickAt.current = Date.now();
    if (v && pickedRef.current?.id !== v.id) pick(v, undefined, false, { fly: false, keepRoute: true });
    else redrawRoutes();
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
  const band = useRef<Band>("far");
  const drawSettlements = () => {
    const g = globeRef.current;
    if (!g) return;
    if (!layersRef.current.villages || !settlements.current.length) { g.particlesData([]); return; }
    const demo = demoPaint.current;
    const alt = g.pointOfView()?.altitude ?? 1;
    const focus = focusRef.current;
    if (dotsGoneRef.current) {
      g.particlesData([]);
      return;
    }
    if ((revealRef.current === "pulse" || revealRef.current === "roads") && demo) {
      g.particlesData(revealGroups(settlements.current, demo.chosen, revealRef.current === "pulse" ? fadeRef.current : 0, flashRef.current, {
        retired: retiredRef.current,
        shrink: shrinkIdsRef.current,
        shrinkT: shrinkTRef.current,
      }));
      const wobble = flashRef.current || revealRef.current !== "pulse" ? 1 : 0.97 + 0.03 * Math.sin(performance.now() / 1400);
      g.particlesSize((d: object) => {
        const size = (d as { size: number }).size;
        return size * (size >= 0.02 ? wobble : 1);
      });
      return;
    }
    const close = !!demo && !!focus && alt <= PROVINCE_ALT;
    if (!demo) {
      g.particlesData(settlementGroups(settlements.current));
      restyleSettlements();
      return;
    }
    else if (!close) {
      g.particlesData([]);
      return;
    }
    else {
      const run = planRef.current?.runs.find((r) => r.id === focus);
      const served = new Map<string, { la: number; ln: number; color: string }>();
      if (run) {
        const road = roadsOnly.current.find((r) => r.planId === run.id && !r.key.endsWith("-wet"));
        const line = road?.full ?? road?.pts ?? run.points;
        for (const stop of run.stops) {
          const at = nearestRoad(line, stop.lat, stop.lng);
          served.set(stop.id, { la: at[0], ln: at[1], color: run.color });
        }
        for (const p of run.onRoad ?? []) {
          const at = nearestRoad(line, p.lat, p.lng);
          served.set(p.id, { la: at[0], ln: at[1], color: run.color });
        }
        for (const b of run.branches ?? []) served.set(b.id, { la: b.lat, ln: b.lng, color: run.color });
      }
      g.particlesData(demoGroups(settlements.current, new Set(served.keys()), served));
    }
    restyleSettlements();
  };
  const restyleSettlements = () => {
    const g = globeRef.current;
    if (!g || revealRef.current === "pulse") return;
    if (demoPaint.current) {
      const scale = band.current === "far" ? 0.8 : band.current === "mid" ? 1 : 1.25;
      g.particlesSize((d: object) => (d as { size: number }).size * scale);
      g.particlesColor((d: object) => (d as { color: string }).color);
      return;
    }
    const st = settlementStyle(band.current);
    g.particlesSize(st.size);
    g.particlesColor(st.color);
  };

  // Routes: every plan in route_plan is drawn on its road (pathsData) in the carrier's colour, red
  // where the flood risk is high; drones, and orders the planner has not touched yet, fly as arcs.
  // Moving routes are bright and dashed, planned ones plain, delivered ones dim; a multi-stop run
  // is drawn once with numbered stops. Only when the layer is on, and only the picked post's when
  // one is picked.
  const redrawRoutes = () => {
    const conn = connRef.current, g = globeRef.current;
    if (!conn || !g) return;
    const p = pickedRef.current;
    const orders = [...conn.db.deliveryOrder.iter()] as Order[];
    const orderById = new Map(orders.map((o) => [String(o.id), o]));
    const carrierKind = new Map([...conn.db.carrier.iter()].map((c) => [c.id, (c as Carrier).kind]));
    const mine = (o: Order) => !p || o.toVillageId === p.id || o.fromVillageId === p.id;
    const paths: RoadPath[] = [];
    const droneArcs: Arc[] = [];
    const planned = new Set<string>();
    const seen = new Set<string>();
    const stopIds = new Set<string>();
    const corridors = new Set<string>();
    let doneShown = 0;
    roadByOrder.current.clear();
    if (layersRef.current.flights) {
      // Newest plans first, so the dim delivered ones that are kept are the recent ones.
      const plans = ([...conn.db.routePlan.iter()] as Plan[]).sort((a, b) => Number(b.id - a.id));
      for (const plan of plans) {
        const o = orderById.get(String(plan.orderId));
        if (!o) continue;
        const done = plan.status === "done" || o.status === "delivered";
        const carrier = carrierKind.get(plan.carrierId);
        const pickedRoute = pickedPlanRef.current === String(plan.id);
        const state: RouteState = pickedRoute ? "picked" : done ? "done" : plan.status === "moving" || o.status === "on_the_way" ? "moving" : "planned";
        const key = `${plan.id}:${plan.waypoints.length}:${state}:${plan.floodRisk}:${carrier}`;
        let r = roads.current.get(key);
        if (!r) {
          const pts = parseWaypoints(plan.waypoints);
          if (pts.length < 2) continue;
          const cum = [0];
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + kmBetween(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
          r = { key, planId: String(plan.id), pts, cum, total: cum[cum.length - 1], mode: o.mode, carrier, flood: plan.floodRisk, state, moving: state === "moving", orderId: String(o.id), toVillageId: o.toVillageId, run: runOf(plan.reason) };
          roads.current.set(key, r);
        }
        seen.add(key);
        if (!done) { roadByOrder.current.set(r.orderId, r); planned.add(r.orderId); }
        if (!mine(o)) continue;
        if (done && !pickedRoute && ++doneShown > DONE_ROADS_SHOWN) continue;
        if (r.run && !done) {
          // Numbered stop at this order's destination; the run's shared road is drawn once.
          const v = villages.current.get(o.toVillageId);
          if (v) {
            const id = `${r.run.key}#${r.run.stop}`;
            stopIds.add(id);
            if (!stops.current.has(id)) { stops.current.set(id, { kind: "stop", id, lat: v.lat, lng: v.lng, n: r.run.stop, run: r.run.id, name: short(v.name) }); markersDirty.current = true; }
          }
        }
        const corridor = r.run?.key ?? geomKey(r.pts);
        if (!pickedRoute && corridors.has(corridor)) continue;
        corridors.add(corridor);
        if (carrier === "drone" || o.mode === "drone") {
          if (done) continue; // a finished flight leaves no arc in the sky
          const a = villages.current.get(o.fromVillageId), b = villages.current.get(o.toVillageId);
          if (a && b) droneArcs.push({ a, b, mode: "drone", kind: o.kind, flood: plan.floodRisk, state });
          continue;
        }
        paths.push(r);
      }
    }
    for (const key of [...roads.current.keys()]) if (!seen.has(key)) roads.current.delete(key);
    for (const id of [...stops.current.keys()]) if (!stopIds.has(id)) { stops.current.delete(id); markersDirty.current = true; }
    const demoOn = viewRef.current !== "live" && (demoRef.current.length > 0 || holdRoads.current);
    const demo = viewRef.current === "live" ? [] : demoRef.current;
    g.pathsData(demoOn ? demo : [...paths, ...demo]);
    g.polygonsData(viewRef.current === "floods" ? floodRef.current : []);
    // Open orders the planner has not touched yet keep the straight arc, by mode.
    const arcs: Arc[] = layersRef.current.flights && !demoOn
      ? orders
          .filter((o) => o.status !== "delivered" && o.mode !== "walk" && !planned.has(String(o.id)))
          .filter(mine)
          .map((o) => ({ a: villages.current.get(o.fromVillageId)!, b: villages.current.get(o.toVillageId)!, mode: o.mode, kind: o.kind, flood: "low", state: (o.status === "on_the_way" ? "moving" : "planned") as RouteState }))
          .filter((x) => x.a && x.b)
      : [];
    g.arcsData([...arcs, ...droneArcs]);
  };

  const applyPicture = () => {
    const g = globeRef.current;
    const alt = g?.pointOfView()?.altitude ?? 1;
    const focus = focusRef.current;
    const province = !focus || alt > PROVINCE_ALT;
    const roads = roadsOnly.current.map((r) => {
      const runId = r.planId.replace(/-wet$/, "");
      const dimmed = !province && focus && runId !== focus;
      if (r.key.endsWith("-wet")) return { ...r, pts: r.full ?? r.pts, shade: dimmed ? "rgba(125,211,252,0.35)" : "rgba(186,230,253,0.95)", ink: undefined };
      return { ...r, pts: r.full ?? r.pts, shade: dimmed ? hexAlpha(r.hue ?? "#f8fafc", 0.28) : undefined };
    });
    const hops = (province
      ? [...hopsByRun.current.values()].flat()
      : focus ? hopsByRun.current.get(focus) ?? [] : []
    ).map((h) => (province || !focus ? h : { ...h, shade: undefined }));
    demoRef.current = [...roads.flatMap(dressRoad), ...hops.flatMap(bloomHop)];
    captionShown.current = province ? captionAll.current : captionAll.current.filter((c) => c.runId === focus);
    departShown.current = province ? departAll.current : departAll.current.filter((d) => d.runId === focus);
    pictureKey.current = province ? "province" : focus;
    markersDirty.current = true;
    (window as unknown as { __mapPicture?: unknown }).__mapPicture = {
      province,
      focus,
      roads: roads.filter((r) => !r.key.endsWith("-wet") && !r.key.includes("-glow")).length,
      hops: hops.length,
      labels: captionShown.current.map((c) => `${c.place} · ${c.truck} · ${c.villages} villages · ${c.tag}`),
    };
    redrawRoutes();
    drawSettlements();
  };
  applyPictureRef.current = applyPicture;

  const focusTruck = (id: string) => {
    const g = globeRef.current;
    if (focusRef.current === id) {
      focusRef.current = null;
      setFocusId(null);
      pictureKey.current = "";
      g?.pointOfView(PROVINCE_VIEW, 900);
      return;
    }
    focusRef.current = id;
    setFocusId(id);
    pictureKey.current = "";
    const run = planRef.current?.runs.find((r) => r.id === id);
    const pts = run?.points;
    if (pts && pts.length > 1 && g) {
      const mid = pts[Math.floor(pts.length / 2)];
      g.pointOfView({ lat: mid[0], lng: mid[1], altitude: 0.05 }, 1000);
    }
  };
  focusTruckRef.current = focusTruck;

  focusFloodRef.current = (d) => {
    setView("floods");
    viewRef.current = "floods";
    setPlanNote(d.why || d.text);
    setReasonOpen(false);
    if (d.runId) {
      focusRef.current = d.runId;
      setFocusId(d.runId);
      pictureKey.current = "";
    }
    globeRef.current?.pointOfView({ lat: d.lat, lng: d.lng, altitude: 0.045 }, 1200);
  };

  const noteReveal = (extra?: Record<string, unknown>) => {
    const paths = demoRef.current;
    (window as unknown as { __reveal?: unknown }).__reveal = {
      phase: revealRef.current,
      notice: noticeRef.current,
      listening: listeningRef.current,
      roads: paths.filter((p) => !p.key.includes("-branch") && !p.key.endsWith("-wet") && !p.key.includes("-glow")).length,
      hops: paths.filter((p) => p.key.includes("-branch") && !p.key.includes("-glow")).length,
      ...extra,
    };
  };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const playSources = async (seq: number) => {
    if (seq !== calcSeq.current) return false;
    listeningRef.current = true;
    setListening(true);
    setLiveLine(true);
    noticeRef.current = null;
    setNotice(null);
    noteReveal();
    const cards = SOURCE_CARDS.filter((c) => marksRef.current[c.needs]);
    for (const card of cards) {
      if (seq !== calcSeq.current) return false;
      noticeRef.current = card.id;
      setNotice(card);
      noteReveal();
      await wait(2000);
      if (seq !== calcSeq.current) return false;
      noticeRef.current = null;
      setNotice(null);
      noteReveal();
      await wait(280);
    }
    if (seq !== calcSeq.current) return false;
    listeningRef.current = false;
    setListening(false);
    setNotice(null);
    noteReveal();
    return true;
  };

  const playDraw = (groups: RoadPath[][], rows: { id: string; place: string; truck: string; villages: number; color: string; tag: string }[], caps: typeof captionAll.current, departs: typeof departAll.current, doneNote: string) => {
    if (drawTimer.current) cancelAnimationFrame(drawTimer.current);
    holdRoads.current = true;
    const mains = groups.map((group) => group.find((leg) => !leg.key.endsWith("-wet"))).filter((leg): leg is RoadPath => !!leg);
    const wets = groups.map((group) => group.find((leg) => leg.key.endsWith("-wet")) ?? null);
    const cum = new Map(mains.map((leg) => [leg.key, lineCum(leg.full ?? leg.pts)]));
    const live = mains.map((leg) => ({ ...leg, pts: (leg.full ?? leg.pts).slice(0, 2) }));
    roadsOnly.current = groups.flat().map((leg) => ({ ...leg, pts: leg.full ?? leg.pts }));
    demoRef.current = [];
    captionShown.current = [];
    departShown.current = [];
    setRoster([]);
    setDrawing(true);
    revealRef.current = "roads";
    drawSettlements();
    let gi = 0;
    let shown = 0;
    let last = performance.now();
    let marked = -1;
    let phase: "road" | "dash" = "road";
    const hopFull = new Map(mains.map((leg) => {
      const hops = (hopsByRun.current.get(leg.planId) ?? []).map((h) => ({ ...h, pts: (h.full ?? h.pts).slice() }));
      return [leg.planId, hops.map((h) => ({ hop: h, cum: lineCum(h.full ?? h.pts) }))] as const;
    }));
    const doneHops: RoadPath[] = [];
    const roadsUpTo = (n: number) => live.slice(0, n).flatMap((leg) => dressRoad({ ...leg, pts: leg.pts.slice() }));
    const wetsUpTo = (n: number) => wets.slice(0, n).filter((w): w is RoadPath => !!w).map((w) => ({ ...w, pts: (w.full ?? w.pts).slice() }));
    const finish = () => {
      drawTimer.current = null;
      dotsGoneRef.current = true;
      shrinkIdsRef.current = new Set();
      holdRoads.current = false;
      revealRef.current = null;
      for (const leg of live) leg.pts = leg.full ?? leg.pts;
      const everyHop = mains.flatMap((leg) => (hopFull.get(leg.planId) ?? []).map((h) => h.hop));
      demoRef.current = [...live.flatMap((leg) => dressRoad({ ...leg, pts: (leg.full ?? leg.pts).slice() })), ...wetsUpTo(wets.length), ...everyHop.flatMap(bloomHop)];
      captionShown.current = caps;
      departShown.current = departs;
      setRoster(rows);
      markersDirty.current = true;
      setDrawing(false);
      setPlanNote(doneNote);
      pictureKey.current = "province";
      noteReveal({ frac: 1, truck: mains.length, hops: everyHop.length });
      redrawRoutes();
      drawSettlements();
      globeRef.current?.pointOfView(PROVINCE_VIEW, 1500);
    };
    const step = (now: number) => {
      if (gi >= mains.length) {
        finish();
        return;
      }
      const dt = Math.min(34, Math.max(0, now - last));
      last = now;
      const full = mains[gi].full ?? mains[gi].pts;
      if (phase === "road") {
        shown = Math.min(1, shown + dt / 1000);
        const t = smoothstep(shown);
        if (marked < gi) {
          marked = gi;
          departShown.current = departs.slice(0, gi + 1);
          markersDirty.current = true;
        }
        live[gi].pts = growByDistance(full, cum.get(mains[gi].key) ?? lineCum(full), Math.max(t, 0.015));
        demoRef.current = roadsUpTo(gi + 1).concat(wetsUpTo(gi), doneHops);
        redrawRoutes();
        noteReveal({ frac: Number(t.toFixed(2)), truck: gi, pts: live[gi].pts.length, full: full.length, hops: doneHops.length });
        if (shown >= 1) {
          live[gi].pts = full;
          captionShown.current = caps.slice(0, gi + 1);
          setRoster(rows.slice(0, gi + 1));
          markersDirty.current = true;
          const hops = hopFull.get(mains[gi].planId) ?? [];
          if (hops.length) {
            phase = "dash";
            shown = 0;
          } else {
            demoRef.current = roadsUpTo(gi + 1).concat(wetsUpTo(gi + 1), doneHops);
            redrawRoutes();
            gi += 1;
            shown = 0;
          }
        }
      } else {
        shown = Math.min(1, shown + 0.16);
        const t = smoothstep(shown);
        const hops = hopFull.get(mains[gi].planId) ?? [];
        shrinkIdsRef.current = dotsByRun.current.get(mains[gi].planId) ?? new Set();
        shrinkTRef.current = t;
        const grown = hops.map(({ hop, cum: hopCum }) => {
          const line = hop.full ?? hop.pts;
          return { ...hop, pts: growByDistance(line, hopCum, Math.max(t, 0.04)) };
        });
        demoRef.current = roadsUpTo(gi + 1).concat(wetsUpTo(gi + 1), doneHops, grown);
        redrawRoutes();
        drawSettlements();
        noteReveal({ frac: 1, dash: Number(t.toFixed(2)), truck: gi, hops: doneHops.length + grown.length });
        if (shown >= 1) {
          const landed = dotsByRun.current.get(mains[gi].planId);
          if (landed) for (const id of landed) retiredRef.current.add(id);
          shrinkIdsRef.current = new Set();
          shrinkTRef.current = 0;
          doneHops.push(...hops.map((h) => h.hop));
          drawSettlements();
          gi += 1;
          shown = 0;
          phase = "road";
        }
      }
      drawTimer.current = requestAnimationFrame(step);
    };
    drawTimer.current = requestAnimationFrame(step);
  };

  const paintFreckles = () => {
    const g = globeRef.current;
    if (!g || dotsGoneRef.current || demoPaint.current || !settlements.current.length) return;
    const extra = g as unknown as {
      camera?: () => { fov?: number };
      renderer?: () => { getSize?: (t: { x: number; y: number; set: (x: number, y: number) => unknown }) => void };
      controls?: () => { update?: () => void; dispatchEvent?: (e: { type: string }) => void };
    };
    const box = { x: 0, y: 900, set(x: number, y: number) { this.x = x; this.y = y; return this; } };
    extra.renderer?.()?.getSize?.(box);
    const alt = g.pointOfView()?.altitude ?? CLOSE_VIEW.altitude;
    const fov = ((extra.camera?.()?.fov ?? 50) * Math.PI) / 180;
    const dist = Math.max(1, alt * 100);
    const world = (2.2 * (2 * Math.tan(fov / 2) * dist)) / Math.max(1, box.y);
    const scales = [1, 1.4, 2, 2.8];
    g.particlesData(settlementGroups(settlements.current).map((gr) => ({ ...gr, size: world * scales[gr.tone] })));
    g.particlesSize((d: object) => (d as { size: number }).size);
    const controls = extra.controls?.();
    controls?.update?.();
    controls?.dispatchEvent?.({ type: "change" });
  };

  const showFreckles = async (seq: number) => {
    const g = globeRef.current;
    if (!g) return;
    g.pointOfView(FRECKLE_IN, 1100);
    await wait(1250);
    if (seq !== calcSeq.current) return;
    paintFreckles();
    g.pointOfView(CLOSE_VIEW, 700);
    await wait(820);
    if (seq !== calcSeq.current) return;
    paintFreckles();
  };

  const showFloodBanner = (text: string) => {
    setFloodBanner(text);
    if (floodTimer.current) clearTimeout(floodTimer.current);
    floodTimer.current = setTimeout(() => setFloodBanner(null), 6000);
  };

  const rerouteFloods = async (seq: number) => {
    const plan = planRef.current;
    const all = [...villages.current.values()];
    const hub = all.find((v) => v.hub) ?? all[0];
    if (!plan || !hub) return;
    setDrawing(true);
    const leave = (why: string) => {
      showFloodBanner("Nothing needs to be redrawn.");
      setReasons((rows) => rows.map((r) => (r.id === "flood" ? { ...r, why } : r)));
      setPlanNote("");
      setDrawing(false);
    };
    let live: ReturnType<typeof liveFloodFrom>;
    try {
      const outlook = await Promise.race([
        fetch("/api/weather/outlook").then((r) => (r.ok ? r.json() : null)),
        new Promise<null>((r) => setTimeout(() => r(null), 12000)),
      ]);
      live = liveFloodFrom(outlook);
    } catch {
      live = liveFloodFrom(null);
    }
    if (seq !== calcSeq.current) return;
    if (live.dry || !live.blocked.length) {
      leave(`${live.note} Nothing needs to be redrawn. No road is blocked, so every truck stays on the road already drawn.`);
      return;
    }
    const conn = connRef.current;
    type LiveCarrier = { id: number; name: string; kind: string; status: string; baseVillageId: number; capacityKg: number };
    const shelf = conn ? ([...conn.db.stock.iter()] as { villageId: number; item: string; qty: number }[]) : [];
    const openVisits = conn ? ([...conn.db.visit.iter()] as { villageId: number; urgency: string }[]) : [];
    const carriers = (conn ? ([...conn.db.carrier.iter()] as LiveCarrier[]) : [])
      .filter((c) => (c.kind === "truck" || c.kind === "pickup") && c.status !== "down" && c.status !== "out" && c.status !== "proposed")
      .flatMap((c) => {
        const base = villages.current.get(c.baseVillageId) ?? hub;
        const tone = base.hub ? "green" : needTone(base.id, shelf, openVisits);
        return [{ id: c.id, name: c.name, kind: c.kind, capacityKg: c.capacityKg, lat: base.lat, lng: base.lng, tone }];
      });
    let data: { held: string; unchanged?: boolean; runs: StoredRun[] };
    try {
      const res = await fetch("/api/routes/network", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hub: { name: short(hub.name), lat: hub.lat, lng: hub.lng },
          hamlets: plan.hamlets,
          carriers,
          flood: true,
          liveFlood: live,
          previous: plan.runs,
        }),
      });
      data = (await res.json()) as typeof data;
      if (!res.ok || !data.runs?.length) throw new Error("route service");
    } catch {
      if (seq !== calcSeq.current) return;
      leave("The road service did not answer. Nothing needs to be redrawn.");
      return;
    }
    if (seq !== calcSeq.current) return;
    const moved = data.runs.filter((r) => r.reroute);
    if (data.unchanged || !moved.length) {
      leave(`${live.note} Nothing needs to be redrawn. No drawn road is blocked.`);
      return;
    }
    const byId = new Map(data.runs.map((r) => [r.id, r]));
    planRef.current = { ...plan, runs: plan.runs.map((r) => byId.get(r.id) ?? r) };
    const byCarrier = new Map(carriers.map((c) => [c.id, c]));
    for (const run of moved) {
      const home = byCarrier.get(run.carrierId);
      const from = home && /pickup/i.test(run.truck) ? { lat: home.lat, lng: home.lng } : { lat: hub.lat, lng: hub.lng };
      const line = orientFromStore(run.points, from.lat, from.lng);
      for (const road of roadsOnly.current) {
        if (road.planId !== run.id || road.key.endsWith("-wet")) continue;
        road.full = line;
        road.pts = line.slice();
        road.total = run.km;
      }
      roadsOnly.current = roadsOnly.current.filter((r) => r.key !== `${run.id}-wet`);
      demoRef.current = demoRef.current.filter((p) => p.key !== `${run.id}-wet`);
      for (const path of demoRef.current) {
        if (path.planId !== run.id || path.key.includes("-branch") || path.key.endsWith("-wet")) continue;
        path.full = line.slice();
        path.pts = line.slice();
        path.total = run.km;
      }
      const hops = hopsByRun.current.get(run.id) ?? [];
      for (const hop of hops) {
        const id = hop.key.replace(/-glow$/, "").slice(`${run.id}-branch-`.length);
        const branch = run.branches?.find((b) => b.id === id);
        if (!branch) continue;
        const at = nearestRoad(line, branch.lat, branch.lng);
        const full: [number, number][] = [at, [branch.lat, branch.lng]];
        hop.full = full;
        hop.pts = full.slice();
        hop.total = branch.km;
      }
      for (const path of demoRef.current) {
        if (!path.key.includes(`${run.id}-branch-`)) continue;
        const id = path.key.replace(/-glow$/, "").slice(`${run.id}-branch-`.length);
        const branch = run.branches?.find((b) => b.id === id);
        if (!branch) continue;
        const at = nearestRoad(line, branch.lat, branch.lng);
        const full: [number, number][] = [at, [branch.lat, branch.lng]];
        path.full = full;
        path.pts = full.slice();
        path.total = branch.km;
      }
      if (run.wet.length > 3) {
        const sample = roadsOnly.current.find((r) => r.planId === run.id && !r.key.endsWith("-wet"));
        if (sample) {
          const wet = {
            ...sample,
            key: `${run.id}-wet`,
            planId: `${run.id}-wet`,
            pts: run.wet.slice(),
            full: run.wet.slice(),
            flood: "high",
            reroute: true,
            shade: "rgba(186,230,253,0.95)",
            hue: "#7dd3fc",
            ink: undefined,
          };
          roadsOnly.current.push(wet);
          demoRef.current.push(wet);
        }
      }
      floodMarks.current = floodMarks.current.filter((m) => m.runId !== run.id);
      if (run.label) floodMarks.current.push({ kind: "flood", id: `${run.id}-flood`, lat: run.label.lat, lng: run.label.lng, text: run.label.text, why: run.why, runId: run.id });
    }
    const saved = waveSavings(planRef.current.runs, villages.current);
    setSavings(saved);
    (window as unknown as { __wave?: WaveSavings | null }).__wave = saved;
    setReasons((rows) => {
      const flood = { id: "flood", tone: "yellow" as const, name: "Flood outlook", why: data.held };
      const compare = saved ? [{ id: "compare", tone: "green" as const, name: "Lives and time", why: saved.sentence }] : [];
      const rest = rows.filter((r) => r.id !== "flood" && r.id !== "compare");
      const src = rest.find((r) => r.id === "src");
      const trucks = rest.filter((r) => r.id !== "src");
      return [...(src ? [src] : []), flood, ...compare, ...trucks];
    });
    markersDirty.current = true;
    redrawRoutes();
    setPlanNote("");
    setDrawing(false);
  };

  const runCalculate = async (floodPass: boolean) => {
    const seq = ++calcSeq.current;
    if (floodPass) {
      await rerouteFloods(seq);
      return;
    }
    const all = [...villages.current.values()];
    const hub = all.find((v) => v.hub) ?? all[0];
    if (!hub) return;
    if (!settlements.current.length) {
      setPlanNote("Settlements are still loading.");
      return;
    }
    focusRef.current = null;
    setFocusId(null);
    pictureKey.current = "";
    setDrawing(true);
    setRoster([]);
    setNotice(null);
    setListening(false);
    noticeRef.current = null;
    listeningRef.current = false;
    holdRoads.current = true;
    revealRef.current = null;
    roadsOnly.current = [];
    demoRef.current = [];
    captionShown.current = [];
    departShown.current = [];
    floodMarks.current = [];
    if (drawTimer.current) cancelAnimationFrame(drawTimer.current);
    drawTimer.current = null;
    demoPaint.current = null;
    redrawRoutes();
    drawSettlements();
    markersDirty.current = true;
    dotsGoneRef.current = false;
    retiredRef.current = new Set();
    shrinkIdsRef.current = new Set();
    shrinkTRef.current = 0;
    dotsByRun.current = new Map();
    if (!floodPass) await showFreckles(seq);
    const weatherP = fetch("/api/weather/outlook")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { posts?: { name?: string; floodRiskToday?: string | boolean; floodRisk14d?: string | boolean }[]; sources?: string[] } | null) => {
        const marks = outlookMarks(j?.sources);
        marksRef.current = { osm: true, esri: true, ...marks };
        return j;
      })
      .catch(() => {
        marksRef.current = { osm: true, esri: true, meteo: false, glofas: false, nasa: false };
        return null;
      });
    const conn = connRef.current;
    type LiveCarrier = { id: number; name: string; kind: string; status: string; baseVillageId: number; capacityKg: number };
    const shelf = conn ? ([...conn.db.stock.iter()] as { villageId: number; item: string; qty: number }[]) : [];
    const openVisits = conn ? ([...conn.db.visit.iter()] as { villageId: number; urgency: string }[]) : [];
    const carriers = (conn ? ([...conn.db.carrier.iter()] as LiveCarrier[]) : [])
      .filter((c) => (c.kind === "truck" || c.kind === "pickup") && c.status !== "down" && c.status !== "out" && c.status !== "proposed")
      .flatMap((c) => {
        const base = villages.current.get(c.baseVillageId) ?? hub;
        const tone = base.hub ? "green" : needTone(base.id, shelf, openVisits);
        return [{ id: c.id, name: c.name, kind: c.kind, capacityKg: c.capacityKg, lat: base.lat, lng: base.lng, tone }];
      });
    let hamlets = planRef.current?.hamlets ?? [];
    let liveFlood: { dry: boolean; note: string } | undefined;
    if (!floodPass) {
      const rnd = mulberry32((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
      const ranked = sampleCall(settlements.current, lastAvoid.current, rnd);
      const tones = new Map<number, "red" | "yellow">();
      const postHamlets: { id: string; name: string; lat: number; lng: number; tone: "red" | "yellow"; post: true }[] = [];
      for (const v of villages.current.values()) {
        const rows = shelf.filter((s) => s.villageId === v.id);
        const tone = shelfTone(v.hub, rows);
        if (!tone) continue;
        tones.set(v.id, tone);
        postHamlets.push({ id: `post-${v.id}`, name: short(v.name), lat: v.lat, lng: v.lng, tone, post: true });
      }
      postToneRef.current = tones;
      hamlets = [
        ...ranked.map((s) => ({
          id: hamletId(s),
          name: s.n?.trim() ? s.n.slice(0, 28) : `${s.la.toFixed(2)}, ${s.ln.toFixed(2)}`,
          lat: s.la,
          lng: s.ln,
        })),
        ...postHamlets,
      ];
      lastAvoid.current = new Set(hamlets.map((h) => h.id));
      urgencyRef.current = new Map();
      demoPaint.current = null;
      demoRef.current = [];
      roadDots.current.clear();
      floodMarks.current = [];
      runColor.current.clear();
      roadSnap.current.clear();
      redrawRoutes();
      rebuildVillages();
      drawSettlements();
      setPlanNote("Reading the roads.");
    } else {
      demoRef.current = [];
      floodMarks.current = [];
      roadDots.current.clear();
      redrawRoutes();
      drawSettlements();
      markersDirty.current = true;
      const outlook = await Promise.race([weatherP, new Promise<null>((r) => setTimeout(() => r(null), 12000))]);
      liveFlood = liveFloodFrom(outlook);
      setPlanNote(`${liveFlood.note} Checking OpenStreetMap for a second road.`);
    }
    const seed = (Date.now() ^ hamlets.length) >>> 0;
    let data: { router: string; held: string; compare?: string; fleet: number; rolled: number; runs: StoredRun[] };
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const res = await fetch("/api/routes/network", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hub: { name: short(hub.name), lat: hub.lat, lng: hub.lng },
          hamlets,
          carriers,
          flood: floodPass,
          seed,
          liveFlood,
          previous: floodPass ? planRef.current?.runs : undefined,
        }),
      });
      data = (await res.json()) as typeof data;
      if (!res.ok || !data.runs?.length) throw new Error("route service");
    } catch {
      if (seq !== calcSeq.current) return;
      holdRoads.current = false;
      revealRef.current = null;
      setDrawing(false);
      setListening(false);
      setPlanNote("");
      setReasons([{ id: "err", tone: "red", name: "Roads", why: "The road service did not answer, so nothing was drawn. A straight line would be a guess." }]);
      setReasonOpen(true);
      return;
    }
    if (seq !== calcSeq.current) return;
    data.runs = assignHues(data.runs);
    const urgency = urgencyRef.current;
    const keep = new Set<string>();
    const served = new Map<string, { la: number; ln: number; color: string }>();
    for (const run of data.runs) {
      if (run.points.length < 2) continue;
      for (const stop of run.stops) {
        keep.add(stop.id);
        const at = nearestRoad(run.points, stop.lat, stop.lng);
        served.set(stop.id, { la: at[0], ln: at[1], color: run.color });
      }
      for (const p of run.onRoad ?? []) {
        keep.add(p.id);
        const at = nearestRoad(run.points, p.lat, p.lng);
        served.set(p.id, { la: at[0], ln: at[1], color: run.color });
      }
      for (const b of run.branches ?? []) {
        keep.add(b.id);
        served.set(b.id, { la: b.lat, ln: b.lng, color: run.color });
      }
    }
    demoPaint.current = { chosen: keep, served, urgency };
    roadDots.current.clear();
    runColor.current.clear();
    roadSnap.current.clear();
    const drawn = data.runs.filter((run) => run.points.length > 1);
    const byCarrier = new Map(carriers.map((c) => [c.id, c]));
    const departAt = (run: StoredRun) => {
      const home = byCarrier.get(run.carrierId);
      if (home && /pickup/i.test(run.truck)) return { lat: home.lat, lng: home.lng };
      return { lat: hub.lat, lng: hub.lng };
    };
    const oriented = drawn.map((run) => {
      const from = departAt(run);
      return orientFromStore(run.points, from.lat, from.lng);
    });
    const separated = separateShared(oriented);
    const seats = labelSeats(separated);
    const groups: RoadPath[][] = [];
    const caps: typeof captionAll.current = [];
    const rows: { id: string; place: string; truck: string; villages: number; color: string; tag: string }[] = [];
    const departs: typeof departAll.current = [];
    const pendingFlood: typeof floodMarks.current = [];
    hopsByRun.current = new Map();
    floodMarks.current = [];
    drawn.forEach((run, i) => {
      const line = separated[i];
      const place = placeOfRun(run);
      const villages = coveredVillages(run);
      const tag = run.tone === "yellow" ? "running low" : "emergency";
      const mid = seats[i] ?? line[Math.floor(line.length / 2)];
      const base = {
        cum: [0],
        mode: "road",
        carrier: "truck",
        state: "planned" as const,
        moving: false,
        run: null,
        tone: run.tone,
        why: "",
        hue: run.color,
      };
      const group: RoadPath[] = [{
        ...base,
        key: run.id,
        planId: run.id,
        pts: line.slice(0, 2),
        full: line,
        total: run.km,
        flood: run.wet.length ? "high" : "low",
        orderId: run.id,
        toVillageId: hub.id,
        reroute: run.reroute,
        shade: run.color,
      }];
      if (run.wet.length > 3) {
        const wet = separateShared([line, run.wet])[1];
        group.push({
          ...base,
          key: `${run.id}-wet`,
          planId: `${run.id}-wet`,
          pts: wet.slice(0, 2),
          full: wet,
          total: run.km,
          flood: "high",
          orderId: `${run.id}-wet`,
          toVillageId: hub.id,
          reroute: true,
          shade: "rgba(186,230,253,0.95)",
          hue: "#7dd3fc",
        });
      }
      const reachedIds = new Set<string>();
      for (const stop of run.stops) reachedIds.add(stop.id);
      for (const p of run.onRoad ?? []) reachedIds.add(p.id);
      const hops: RoadPath[] = [];
      for (const [bi, b] of (run.branches ?? []).entries()) {
        reachedIds.add(b.id);
        const from = nearestRoad(line, b.lat, b.lng);
        const full: [number, number][] = [from, [b.lat, b.lng]];
        hops.push({
          ...base,
          key: `${run.id}-branch-${b.id}`,
          planId: run.id,
          pts: full,
          full,
          total: b.km,
          flood: "low",
          orderId: `${run.id}-branch-${b.id}`,
          toVillageId: hub.id,
          reroute: false,
          ink: stitchInk(run.color, bi),
          shade: undefined,
          why: "",
        });
      }
      dotsByRun.current.set(run.id, reachedIds);
      hopsByRun.current.set(run.id, hops);
      groups.push(group);
      const placeName = districtOf(place);
      const truck = truckWord(run.truck);
      const from = departAt(run);
      caps.push({ kind: "caption", id: `${run.id}-cap`, lat: mid[0], lng: mid[1], place: placeName, truck, villages, tag, color: run.color, runId: run.id });
      rows.push({ id: run.id, place: placeName, truck, villages, color: run.color, tag });
      departs.push({ kind: "depart", id: `${run.id}-from`, lat: from.lat, lng: from.lng, color: run.color, runId: run.id });
      if (run.label) pendingFlood.push({ kind: "flood", id: `${run.id}-flood`, lat: run.label.lat, lng: run.label.lng, text: run.label.text, why: run.why, runId: run.id });
    });
    const shared = new Map<string, number>();
    for (const mark of departs) {
      const key = `${mark.lat.toFixed(2)},${mark.lng.toFixed(2)}`;
      const n = shared.get(key) ?? 0;
      shared.set(key, n + 1);
      mark.lng += n * 0.012;
    }
    captionAll.current = caps;
    departAll.current = departs;
    planRef.current = { hamlets, runs: data.runs };
    floodRef.current = [];
    const roadName = data.router === "google" ? "Google" : "OpenStreetMap";
    const kms = data.runs.map((r) => r.km);
    const lo = Math.min(...kms);
    const hi = Math.max(...kms);
    const hops = data.runs.reduce((n, r) => n + (r.branches?.length ?? 0), 0);
    const outlookBody = await Promise.race([weatherP, wait(600).then(() => null)]);
    const floodNote = liveFlood?.note ?? liveFloodFrom(outlookBody).note;
    const moved = data.runs.filter((r) => r.label);
    const calledN = hamlets.filter((h) => !h.id.startsWith("post-")).length;
    const summary = `${calledN.toLocaleString()} settlements were called. ${data.rolled} trucks rolled, ${lo.toFixed(0)}–${hi.toFixed(0)} km on ${roadName}. ${keep.size.toLocaleString()} settlements sit on a truck. The dashed stitches are the villages within 40 km of a road (${hops.toLocaleString()} of them). ${data.held}`;
    const saved = waveSavings(data.runs, villages.current);
    setSavings(saved);
    (window as unknown as { __wave?: WaveSavings | null }).__wave = saved;
    push(summary, floodPass ? "alert" : "agent");
    setReasons([
      { id: "src", tone: "green", name: "This wave", why: summary },
      {
        id: "flood",
        tone: "yellow",
        name: "Flood outlook",
        why: moved.length
          ? `${floodNote} ${moved.map((r) => r.why).join(" ")}`
          : `${floodNote} No truck left its road on this wave.`,
      },
      ...(saved ? [{ id: "compare", tone: "green" as const, name: "Lives and time", why: saved.sentence }] : []),
      ...data.runs.map((r) => {
        const from = /pickup/i.test(r.truck) ? `${districtOf(placeOfRun(r))} town` : "the Chipata store";
        return {
          id: r.id,
          tone: r.tone,
          name: `${districtOf(placeOfRun(r))} · ${truckWord(r.truck)} · ${coveredVillages(r).toLocaleString()} villages`,
          why: `Leaves from ${from}. ${r.km} km. ${r.why}`,
        };
      }),
    ]);
    setReasonOpen(false);
    setFeedOpen(true);
    setView(floodPass ? "floods" : "routes");
    viewRef.current = floodPass ? "floods" : "routes";
    setLayer("flights", true);
    setLayer("villages", true);
    setPlanNote("");
    markersDirty.current = true;
    rebuildVillages();
    if (!floodPass) {
      revealRef.current = "pulse";
      fadeRef.current = 1;
      flashRef.current = true;
      drawSettlements();
      noteReveal({ flash: true });
      await wait(520);
      if (seq !== calcSeq.current) return;
      flashRef.current = false;
      fadeRef.current = 0;
      drawSettlements();
      noteReveal({ flash: false });
      const ready = await playSources(seq);
      if (!ready || seq !== calcSeq.current) return;
    }
    floodMarks.current = pendingFlood;
    markersDirty.current = true;
    playDraw(groups, rows, caps, departs, `${rows.length} trucks · ${lo.toFixed(0)}–${hi.toFixed(0)} km · ${keep.size.toLocaleString()} villages on a line`);
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
        // Every marker sits ON the ground (altitude 0); anything above it parallaxes away from its
        // spot when the view is oblique. Depth cues are CSS inside the zero-size anchor.
        .htmlAltitude(GROUND)
        .htmlTransitionDuration(0)
        .htmlElement((d: object) => markerEl(d as Marker, (v) => pick(v), (f) => focusFloodRef.current(f), (id) => focusTruckRef.current(id)))
        .particlesData([])
        .particlesList("list")
        .particleLat("la")
        .particleLng("ln")
        .particleAltitude(GROUND)
        .particlesSize("size")
        .particlesSizeAttenuation(true)
        .particlesColor("rgba(226,232,240,0.5)")
        .particlesTexture((d: object) => particleTexture(THREE, d))
        .particleLabel(() => "") // the dots' names come from settlementAt(); globe.gl's own particle tooltip would read `.name` of nothing
        .pathsData([])
        .pathPoints("pts")
        .pathPointLat((p: object) => (p as [number, number])[0])
        .pathPointLng((p: object) => (p as [number, number])[1])
        .pathPointAlt(GROUND)
        .pathResolution(1)
        .pathColor((d: object) => {
          const r = d as RoadPath;
          if (r.ink) return r.ink;
          if (r.shade) return r.shade;
          return routeColor(r.carrier, r.flood, r.state);
        })
        .pathStroke((d: object) => strokeOf(d as RoadPath))
        .pathDashLength((d: object) => ((d as RoadPath).key.includes("-branch") ? 0.22 : (d as RoadPath).moving ? 0.08 : 1))
        .pathDashGap((d: object) => ((d as RoadPath).key.includes("-branch") ? 0.34 : (d as RoadPath).moving ? 0.05 : 0))
        .pathDashAnimateTime((d: object) => ((d as RoadPath).key.includes("-branch") ? 0 : (d as RoadPath).moving ? 2600 : 0))
        .pathTransitionDuration(0)
        .pathLabel((d: object) => {
          const r = d as RoadPath;
          if (r.key.includes("-branch") || r.key.endsWith("-glow") || r.planId.startsWith("run-")) return "";
          if (r.why) return `<div class="tip">${r.why}</div>`;
          const who = r.carrier ? r.carrier : r.mode === "drone" ? "drone" : "road";
          return `<div class="tip">${r.run ? `run ${r.run.id} · ` : ""}${who} · ${r.total.toFixed(0)} km · flood risk ${r.flood} · ${r.state === "done" ? "delivered" : r.state === "picked" ? "selected" : r.state}</div>`;
        })
        .onPathClick((d: object) => {
          const r = d as RoadPath;
          if (r.planId.startsWith("run-")) {
            focusTruckRef.current(r.planId.replace(/-wet$/, ""));
            return;
          }
          pickRoute(r.planId, r.toVillageId);
        })
        .arcsData([])
        .arcStartLat((d: object) => (d as Arc).a.lat)
        .arcStartLng((d: object) => (d as Arc).a.lng)
        .arcEndLat((d: object) => (d as Arc).b.lat)
        .arcEndLng((d: object) => (d as Arc).b.lng)
        .arcColor((d: object) => {
          const o = d as Arc;
          if (o.flood === "high") return [FLOOD_COLOR, "#fecaca"];
          return o.mode === "drone" ? [KIND_COLOR.drone, "#ede9fe"] : o.kind === "restock" ? ["#34d399", "#d1fae5"] : [KIND_COLOR.truck, "#fef3c7"];
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
        .ringRepeatPeriod(700)
        .polygonsData([])
        .polygonCapColor((d: object) => (d as { color: string }).color)
        .polygonSideColor(() => "rgba(0,0,0,0)")
        .polygonStrokeColor((d: object) => (d as { stroke: string }).stroke)
        .polygonAltitude(0)
        .polygonGeoJsonGeometry((d: object) => (d as { geo: { type: string; coordinates: number[] } }).geo);
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
      // The tables may have arrived before the globe did: draw what is already there.
      rebuildVillages();
      redrawRoutes();

      // Movers (drones/trucks) glide between posts. Their positions are written straight into the
      // marker's three.js object every frame; the data list only changes when a mover appears or ends.
      const loop = () => {
        raf = requestAnimationFrame(loop);
        tick();
      };
      let lastScan = 0;
      let lastPulse = 0;
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
            if (live.size >= 8) continue;
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
          if (obj) Object.assign(obj.position, polar2Cartesian(m.lat, m.lng, GROUND));
          const eta = m.el?.querySelector(".eta");
          if (eta && eta.textContent !== m.label) eta.textContent = m.label;
        }
        const alt = g.pointOfView()?.altitude ?? 1;
        if (revealRef.current === "pulse" && !flashRef.current && now - lastPulse > 140) {
          lastPulse = now;
          const wobble = 0.97 + 0.03 * Math.sin(now / 1400);
          g.particlesSize((d: object) => {
            const size = (d as { size: number }).size;
            return size * (size >= 0.02 ? wobble : 1);
          });
        }
        if (!drawTimer.current && !holdRoads.current && roadsOnly.current.length) {
          const focus = focusRef.current;
          const province = !focus || alt > PROVINCE_ALT;
          const key = province ? "province" : focus;
          if (key !== pictureKey.current) applyPictureRef.current();
        }
        el.current?.classList.toggle("far", alt > 0.16); // names of small posts only once you zoom in
        el.current?.classList.toggle("near", alt < 0.11);
        const b = bandOf(alt);
        if (b !== band.current) {
          band.current = b;
          restyleSettlements();
        }
        if (Math.abs(alt - wireAlt) > 0.006) {
          wireAlt = alt;
          restrokePaths(g.pathsData() as RoadPath[], (d) => strokeOf(d));
        }
        if (markersDirty.current) {
          markersDirty.current = false;
          const pinMarker: Marker[] = pinRef.current ? [{ kind: "pin", lat: pinRef.current.lat, lng: pinRef.current.lng }] : [];
          g.htmlElementsData([...villageMarkers.current.values(), ...roadDots.current.values(), ...floodMarks.current, ...departShown.current, ...captionShown.current, ...stops.current.values(), ...pops.current, ...movers.current.values(), ...pinMarker]);
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
    let stop = false;
    let timer = 0;
    setEmbed(new URLSearchParams(window.location.search).get("embed") === "1");
    const pull = async () => {
      try {
        const data = (await fetch("/api/mosquito/sightings?days=7").then((r) => r.json())) as { villages?: { village: string; mapped: string | null }[] };
        const next = new Map<string, string>();
        for (const row of data.villages ?? []) if (row.mapped) next.set(placeKey(row.village), row.mapped);
        heardRef.current = next;
        rebuildRef.current();
      } catch {
        /* the map still runs if the listener has not heard anything */
      }
      if (!stop) timer = window.setTimeout(pull, 4000);
    };
    void pull();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
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
    <div className={`fixed bottom-0 left-0 right-0 overflow-hidden bg-black text-slate-100 ${embed ? "top-0" : "top-11"}`}>
      <style>{CSS}</style>
      <div ref={el} className={`absolute inset-0 far${namesHidden ? " labels-off" : ""}`} />

      {hover && (
        <div className="tip pointer-events-none fixed z-30" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          {hover.text}
        </div>
      )}

      {netOpen ? (
        <div className="absolute left-4 top-4 z-10 w-64 border border-white/15 bg-black/70 p-4 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.32em] text-white/40">Pod network</p>
              <h1 className="mt-1 text-xl font-light tracking-tight">Eastern Province</h1>
            </div>
            <button onClick={() => setNetOpen(false)} className="text-[10px] uppercase tracking-[0.18em] text-white/40 hover:text-white">Close</button>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-px bg-white/10 text-center">
            <Kpi label="Posts" value={kpi.posts} />
            <Kpi label="Moving" value={kpi.flying} />
            <Kpi label="Orders" value={kpi.orders} />
          </div>
          <p className={`mt-3 text-[10px] uppercase tracking-[0.22em] ${connected === "live" ? "text-white" : "text-white/40"}`}>{connected === "live" ? "Live" : connected === "connecting" ? "Connecting" : "Offline"}</p>
        </div>
      ) : (
        <button onClick={() => setNetOpen(true)} className="absolute left-4 top-4 z-10 border border-white/20 bg-black/75 px-3 py-2 text-[10px] uppercase tracking-[0.22em] text-white/80 hover:text-white">
          Eastern Province
        </button>
      )}

      {floodBanner && (
        <div className="absolute left-1/2 top-4 z-40 max-w-xl -translate-x-1/2 border border-white/40 bg-black px-6 py-4 text-center" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
          <p className="text-[22px] leading-snug text-white">{floodBanner}</p>
        </div>
      )}

      {(listening || notice) && (
        <div className="absolute right-4 top-4 z-20 w-72" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
          {listening && <p className="text-[16px] tracking-tight text-white/85">Listening · tracking pods and requests.</p>}
          {notice && (
            <div className="mt-3 flex items-center gap-4 border border-white/20 bg-black/80 px-4 py-3 text-white">
              <img src={notice.src} alt={notice.name} className="h-[72px] w-auto min-w-[72px] max-w-[200px] shrink-0 bg-white object-contain p-1.5" />
              <span className="min-w-0">
                <span className="block text-[18px] leading-tight">{notice.name}</span>
                <span className="mt-1 block text-[14px] leading-snug text-white/60">{notice.check}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {roster.length > 0 && !listening && (
        <button type="button" onClick={() => setNamesHidden((v) => !v)} className="absolute right-[19.5rem] top-4 z-10 border border-white/30 bg-black/80 px-3 py-2 text-[13px] text-white/85 hover:text-white" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
          {namesHidden ? "Show names" : "Hide names"}
        </button>
      )}

      {roster.length > 0 && !listening && (
        <div className="absolute right-4 top-4 z-10 max-h-[72vh] w-72 overflow-y-auto border border-white/15 bg-black/75 p-3 backdrop-blur-sm" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
          <p className="text-[10px] uppercase tracking-[0.28em] text-white/45">Trucks</p>
          {roster.map((r) => (
            <button key={r.id} onClick={() => focusTruck(r.id)} className="mt-3 flex w-full items-start gap-2 text-left" style={{ opacity: focusId && focusId !== r.id ? 0.35 : 1 }}>
              <span className="mt-1 inline-block h-3 w-3 shrink-0" style={{ background: r.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium leading-tight" style={{ color: r.color }}>{r.place}</span>
                <span className="block text-[13px] leading-tight text-white/75">{r.truck}</span>
                <span className="block text-[14px] leading-tight text-white">{r.villages.toLocaleString()} villages</span>
                <span className="block text-[10px] uppercase tracking-[0.14em] text-white/55">{r.tag}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {savingsOpen && savings && (
        <div className={`absolute bottom-24 z-30 max-h-[58vh] w-[28rem] overflow-y-auto border border-white/20 bg-black/88 p-4 backdrop-blur-sm ${reasonOpen ? "left-[31rem]" : "left-4"}`} style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
          <div className="flex items-center justify-between">
            <p className="text-[13px] uppercase tracking-[0.22em] text-white/70">Lives and time</p>
            <button onClick={() => setSavingsOpen(false)} className="text-[11px] uppercase tracking-[0.18em] text-white/40 hover:text-white">Close</button>
          </div>
          <p className="mt-3 text-[11px] uppercase tracking-[0.16em] text-white/45">Monthly estimate</p>
          <p className="mt-2 text-[28px] leading-none text-white">{savings.lives.toLocaleString()} people</p>
          <p className="mt-2 text-[22px] leading-none text-white/85">{hoursLabel(savings.hours)} hours</p>
          <p className="mt-3 text-[13px] leading-snug text-white/80">{savings.sentence}</p>
        </div>
      )}

      {reasonOpen && (
        <div className="absolute bottom-24 left-4 z-30 max-h-[58vh] w-[28rem] overflow-y-auto border border-white/20 bg-black/88 p-4 backdrop-blur-sm" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
          <div className="flex items-center justify-between">
            <p className="text-[13px] uppercase tracking-[0.22em] text-white/70">Route reasoning</p>
            <button onClick={() => setReasonOpen(false)} className="text-[11px] uppercase tracking-[0.18em] text-white/40 hover:text-white">Close</button>
          </div>
          <div className="mt-3 space-y-3">
            {reasons.map((r) => (
              <div key={r.id} className="border-l border-white/20 pl-3">
                <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: r.tone === "red" ? "#ff6b6b" : r.tone === "yellow" ? "#f5c446" : "#6ee7b7" }}>{r.id === "src" || r.id === "flood" || r.id === "compare" ? r.name : `${r.tone === "red" ? "Emergency" : r.tone === "yellow" ? "Running low" : "Routine"} · ${r.name}`}</p>
                <p className="mt-1 text-[13px] leading-snug text-white/80">{r.why}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-20">
        {liveLine && (
          <p className="mb-2 text-[14px] tracking-wide text-white/70" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>Live · saved through the routing</p>
        )}
        <div className="pointer-events-auto mb-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] uppercase tracking-[0.22em]">
          <ViewBtn on={view === "routes"} label="Routes" onClick={() => { setView("routes"); viewRef.current = "routes"; redrawRoutes(); }} />
          <ViewBtn on={view === "floods"} label="Floods" onClick={() => { setView("floods"); viewRef.current = "floods"; redrawRoutes(); }} />
          <ViewBtn on={view === "live"} label="Live" onClick={() => { setView("live"); viewRef.current = "live"; setFeedOpen(true); redrawRoutes(); }} />
          <ViewBtn on={layers.villages} label="Villages" onClick={() => setLayer("villages", !layers.villages)} />
          <ViewBtn on={layers.labels} label="Names" onClick={() => setLayer("labels", !layers.labels)} />
          <button type="button" onClick={() => setReasonOpen((v) => !v)} disabled={!reasons.length} className="border border-white/60 bg-white/10 px-3 py-1.5 text-white hover:bg-white/20 disabled:opacity-30">Route reasoning</button>
          <button type="button" onClick={() => setSavingsOpen((v) => !v)} disabled={!savings} className="border border-white/60 bg-white/10 px-3 py-1.5 text-white hover:bg-white/20 disabled:opacity-30">Lives and time</button>
          <button onClick={() => runCalculate(false)} disabled={drawing} className="border-b border-white pb-0.5 text-white disabled:opacity-40">Calculate</button>
          <button onClick={() => runCalculate(true)} disabled={drawing || !reasons.length} className="text-white/70 hover:text-white disabled:opacity-30">Recalculate floods</button>
          <button onClick={() => setFeedOpen((v) => !v)} className="text-white/50 hover:text-white">{feedOpen ? "Hide feed" : "Live feed"}</button>
          {planNote && <span className="normal-case tracking-normal text-white/70">{planNote}</span>}
        </div>
        {feedOpen && (
          <div className="pointer-events-auto flex h-[4.5rem] items-stretch gap-3 overflow-x-auto border border-white/10 bg-black/75 px-3 py-2 backdrop-blur-sm">
            <div className="flex shrink-0 items-center pr-2 text-[10px] uppercase tracking-[0.22em] text-white/40">Live</div>
            {feed.slice(0, 10).map((f) => (
              <div key={f.id} className="w-64 shrink-0 border-l border-white/15 pl-3 text-[11px] leading-snug text-white/75">
                <span className="mr-2 text-white/35">{f.at}</span>
                {f.text}
              </div>
            ))}
            {!feed.length && <p className="self-center text-[11px] text-white/35">Quiet until a pod flags a need.</p>}
            {ob && <p className="ml-auto shrink-0 self-end text-[10px] text-white/30">{villageCount.n.toLocaleString("en-US")} settlements</p>}
          </div>
        )}
      </div>

      {(picked || pickedSettlement || pin) && (
        <div className="panel absolute bottom-28 left-4 z-10 w-[22rem] overflow-y-auto border border-white/15 bg-black/80 p-4 backdrop-blur-sm">
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
                    const on = pickedPlan === String(p.id);
                    const o = asked.concat(sent).find((x) => x.id === p.orderId);
                    const run = runOf(p.reason);
                    return (
                      <button
                        key={String(p.id)}
                        onClick={() => pickRoute(String(p.id), o?.toVillageId ?? picked.id)}
                        className={`flex w-full items-baseline justify-between gap-2 border-l-2 py-0.5 pl-2 text-left text-[12px] leading-4 ${on ? "border-sky-400 bg-sky-950/50" : "border-slate-700 hover:bg-slate-900/60"}`}
                        style={{ borderLeftColor: p.floodRisk === "high" ? FLOOD_COLOR : c ? KIND_COLOR[c.kind] : undefined }}
                        title="show this route on the map"
                      >
                        <span className="truncate">
                          <span className="text-slate-100">{run ? `run ${run.id} · stop ${run.stop}/${run.of}` : `order #${String(p.orderId)}`}</span>
                          <span className="text-slate-500"> · {c ? `${c.kind} · ${c.operator}` : `carrier ${p.carrierId}`} · {p.km.toFixed(0)} km · {p.minutes} min</span>
                        </span>
                        <span className={`shrink-0 ${p.floodRisk === "high" ? "text-red-400" : p.floodRisk === "medium" ? "text-amber-300" : "text-emerald-300"}`}>{p.status === "moving" ? "moving" : p.status} · flood {p.floodRisk}</span>
                      </button>
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

function ViewBtn({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className={on ? "text-white" : "text-white/35 hover:text-white/80"} style={on ? { boxShadow: "inset 0 -1px 0 #fff" } : undefined}>
      {label}
    </button>
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
function markerEl(d: Marker, onPick: (v: Village) => void, onFlood?: (d: { lat: number; lng: number; text: string; why?: string; runId?: string }) => void, onTruck?: (id: string) => void): HTMLElement {
  const anchor = document.createElement("div");
  anchor.className = "anchor";
  const n = document.createElement("div");
  anchor.appendChild(n);
  if (d.kind === "village") {
    n.innerHTML = `<span class="dot"></span><span class="name">${d.v.hub ? "Chipata store" : short(d.v.name)}</span><span class="bug">${d.bug ?? ""}</span>`;
    n.className = `${villageClass(d)}${d.tint ? " onrun" : ""}`;
    const dot = n.querySelector(".dot") as HTMLElement | null;
    if (dot) paintDot(dot, d.tint);
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
  } else if (d.kind === "onroad") {
    n.className = "onroad";
    n.innerHTML = `<span class="dot"></span><span class="name">${d.name}</span>`;
    const dot = n.querySelector(".dot") as HTMLElement | null;
    if (dot) paintDot(dot, d.color);
  } else if (d.kind === "flood") {
    n.className = "floodtag";
    n.innerHTML = `<span class="dot"></span><span class="cap">${d.text}</span>`;
    n.onclick = (e) => {
      e.stopPropagation();
      onFlood?.(d);
    };
  } else if (d.kind === "depart") {
    n.className = "depart";
    n.innerHTML = `<i style="background:${d.color};color:${d.color}"></i>`;
  } else if (d.kind === "caption") {
    n.className = "roadcap";
    n.innerHTML = `<b style="color:${d.color}">${d.place}</b><em style="color:${d.color}">${d.truck} · ${d.villages.toLocaleString()} villages</em><i style="color:${d.color}">${d.tag}</i>`;
    n.onclick = (e) => {
      e.stopPropagation();
      onTruck?.(d.runId);
    };
  } else if (d.kind === "stop") {
    n.className = "stop";
    n.innerHTML = `<i>${d.n}</i>`;
    n.title = `run ${d.run}, stop ${d.n}: ${d.name}`;
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
.onroad{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.onroad .dot{position:absolute;left:0;top:0;width:7px;height:7px;border-radius:999px;transform:translate(-50%,-50%)}
.onroad .name{position:absolute;left:8px;top:0;transform:translateY(-50%);display:none;font-size:10px;color:#fff;text-shadow:0 0 8px #000;white-space:nowrap}
.all-labels .onroad .name{display:inline}
.labels-off .roadcap,.labels-off .floodtag,.labels-off .depart,.labels-off .village .name,.labels-off .onroad .name{visibility:hidden!important}
.floodtag{position:absolute;left:0;top:0;width:0;height:0;pointer-events:auto;cursor:pointer}
.depart{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.depart i{position:absolute;left:0;top:0;width:11px;height:11px;border:2px solid #fff;transform:translate(-50%,-50%) rotate(45deg);box-shadow:0 0 10px currentColor}
.roadcap{position:absolute;left:0;top:0;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;text-align:center;font-family:var(--font-space-grotesk),sans-serif}
.roadcap b{display:block;font:600 20px/1.05 var(--font-space-grotesk),sans-serif;letter-spacing:-0.03em;white-space:nowrap;text-shadow:0 0 14px #000,0 2px 2px #000,0 0 2px #000}
.roadcap em{display:block;margin-top:1px;font:600 14px/1.1 var(--font-space-grotesk),sans-serif;font-style:normal;letter-spacing:-0.02em;white-space:nowrap;text-shadow:0 0 14px #000,0 2px 2px #000,0 0 2px #000}
.roadcap i{display:inline-block;margin-top:4px;font:600 11px/1 var(--font-space-grotesk),sans-serif;font-style:normal;letter-spacing:0.16em;text-transform:uppercase;padding:3px 7px;border:1px solid currentColor;background:rgba(0,0,0,.62)}
.floodtag .dot{position:absolute;left:0;top:0;width:8px;height:8px;border-radius:999px;transform:translate(-50%,-50%);background:rgba(125,211,252,0.85);border:1px solid #e0f2fe;box-shadow:0 0 10px rgba(125,211,252,0.9)}
.floodtag .cap{position:absolute;left:8px;top:0;transform:translateY(-50%);font:600 10px/1.2 system-ui;color:#e0f2fe;background:rgba(2,6,23,.82);border:1px solid rgba(125,211,252,.85);padding:2px 6px;border-radius:999px;white-space:nowrap;box-shadow:0 0 12px rgba(125,211,252,.45)}
.village.big{--d:9px}
.village.hub{--d:13px}
.village.hub .dot{background:#34d399;box-shadow:0 0 0 3px rgba(2,6,23,.85),0 0 0 5px rgba(52,211,153,.55),0 0 16px rgba(52,211,153,.8)}
.village.active .dot{background:#fbbf24;box-shadow:0 0 0 2px rgba(2,6,23,.85),0 0 0 4px rgba(251,191,36,.45),0 0 14px rgba(251,191,36,.9);animation:pulse 1.4s ease-in-out infinite}
.village.picked .dot{background:#38bdf8;box-shadow:0 0 0 2px rgba(2,6,23,.85),0 0 0 5px rgba(56,189,248,.55),0 0 18px rgba(56,189,248,1)}
.village.online .dot{position:relative}
.village.online .dot:after{content:"";position:absolute;inset:-6px;border-radius:999px;border:1.5px solid #38bdf8;box-shadow:0 0 8px rgba(56,189,248,.9);animation:ring 1.8s ease-out infinite}
@keyframes ring{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.6);opacity:0}}
.online-dot{animation:pulse 1.4s ease-in-out infinite}
.village .bug:not(:empty){font:600 9px/1.2 system-ui;color:#bbf7d0;background:rgba(2,6,23,.82);border:1px solid rgba(74,222,128,.7);padding:1px 5px;border-radius:999px}
.village.hub .name{border-color:#34d399;color:#a7f3d0}
.village.active .name{border-color:#fbbf24;color:#fde68a}
.village.picked .name{border-color:#38bdf8;color:#e0f2fe}
/* Label rule. Far (whole province): hub + district towns only, plus the picked post. Mid: also posts
   that are lit or have a pod on. Near: every post. "All names" overrides. */
.village .name{display:none}
.village.onrun .dot:after{display:none}
.far .village .name{font-size:9.5px;padding:1px 5px}
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
.stop{position:absolute;left:0;top:0;transform:translate(-50%,-50%);pointer-events:none}
.stop i{display:grid;place-items:center;width:16px;height:16px;border-radius:50%;background:#0f766e;color:#ecfeff;font:700 10px/1 ui-monospace,Menlo,monospace;font-style:normal;box-shadow:0 0 0 2px #99f6e4,0 0 0 3.5px rgba(2,6,23,.9)}
.pin{position:relative;width:0;height:0}
.pin .head{position:absolute;left:-6px;top:-6px;width:12px;height:12px;border-radius:999px;background:rgba(244,114,182,.45);border:1px solid #f472b6;box-shadow:0 0 12px #f472b6}
.pin .needle{position:absolute;left:-2px;top:-2px;width:4px;height:4px;border-radius:999px;background:#fff}
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
