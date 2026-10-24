// Agents that coordinate the pods. Every pod reports its patients to a shared message bus; four
// network agents read the bus and act, and their decisions flow back to the pods:
//
//   Pod agents        -> report each patient (anonymous: post, what brought them in, urgency)
//   Outbreak sentinel -> spots symptom clusters, tells nearby pods what to screen for
//   Supply allocator  -> turns predicted shortages into drone/road deliveries, tells pods they're coming
//   Referral router   -> sends every red patient to the nearest facility that can treat them, warns it
//   Doctor queue      -> assigns yellow/red patients to remote doctors on call
//   Coordinator       -> (on request) Claude writes a plain-language briefing of the whole network
//
// Pods read their advisories before each triage step, so a malaria alert in a neighbouring
// village changes which questions a pod asks first.

import type { Flight, Visit } from "./network";
import { POSTS, SKUS } from "./network";

export type AgentName = "Pod" | "Outbreak sentinel" | "Supply allocator" | "Referral router" | "Doctor queue" | "Coordinator";

export type AgentMessage = {
  id: number;
  t: number;
  from: AgentName;
  fromPost?: string;
  to: string; // agent name, a post id, or "all pods"
  kind: "report" | "alert" | "advisory" | "plan" | "delivery" | "referral" | "queue" | "briefing";
  text: string;
};

export type Advisory = { post: string; kind: "malaria" | "diarrhea" | "respiratory"; text: string; until: number; source: string };
export type Referral = { visit: string; from: string; to: string; reason: string; mode: "road" | "drone-blood"; etaMin: number; t: number };
export type QueueItem = { visit: string; post: string; urgency: "red" | "yellow"; summary: string; doctor: string; t: number; status: "waiting" | "reviewing" };

type AgentState = {
  bus: AgentMessage[];
  seq: number;
  seenVisits: Set<string>;
  seenAlerts: Set<string>;
  seenFlights: Map<string, string>;
  seenProposals: Map<string, number>; // same delivery plan -> when it was last announced
  advisories: Advisory[];
  referrals: Referral[];
  queue: QueueItem[];
  doctorTurn: number;
  lastShortageNote: number;
};

const DOCTORS = ["Dra. Morales (Cobán)", "Dr. Xol (remote)", "Dra. Pérez (remote)"];
const ADVISORY_RADIUS_KM = 45;
const ADVISORY_MS = 3 * 60_000; // demo time: about 3 hours of network time at 60x

const g = globalThis as unknown as { __agents?: AgentState };
const st = (): AgentState =>
  (g.__agents ??= {
    bus: [],
    seq: 0,
    seenVisits: new Set(),
    seenAlerts: new Set(),
    seenFlights: new Map(),
    seenProposals: new Map(),
    advisories: [],
    referrals: [],
    queue: [],
    doctorTurn: 0,
    lastShortageNote: 0,
  });

const post = (id: string) => POSTS.find((p) => p.id === id);
const name = (id: string) => post(id)?.name.replace(/ \(.*\)$/, "") ?? id;

function km(a: string, b: string) {
  const p = post(a), q = post(b);
  if (!p || !q) return 999;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (q.lat - p.lat) * rad, dLng = (q.lng - p.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(q.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function send(m: Omit<AgentMessage, "id" | "t">, t = Date.now()) {
  const s = st();
  s.bus.push({ ...m, id: ++s.seq, t });
  if (s.bus.length > 400) s.bus.splice(0, s.bus.length - 400);
}

const ADVICE: Record<Advisory["kind"], string> = {
  malaria: "Malaria watch: ask every patient about fever first and test every fever with a rapid malaria test.",
  diarrhea: "Diarrhea watch: ask about diarrhea and dehydration signs first; keep oral rehydration salts at hand.",
  respiratory: "Pneumonia watch: count breathing and check chest indrawing in every child with cough.",
};

export function runAgents(ctx: {
  now: number;
  visits: Visit[];
  alerts: { post: string; text: string; level: "red" | "amber" }[];
  flights: Flight[];
  shortages: { post: string; label: string; hoursLeft: number }[];
}) {
  const s = st();
  const { now } = ctx;

  // 1. Pod agents report patients. Background traffic is summarised; real pod visits, fevers
  //    and emergencies are reported one by one.
  const fresh = ctx.visits.filter((v) => !s.seenVisits.has(v.id));
  const firstRun = s.seenVisits.size === 0;
  for (const v of fresh) s.seenVisits.add(v.id);
  if (!firstRun) {
    for (const v of fresh) {
      if (v.source === "pod" || v.red || (v.fever && Math.random() < 0.35)) {
        send({
          from: "Pod",
          fromPost: v.post,
          to: "Outbreak sentinel",
          kind: "report",
          text: v.summary ?? `New patient: ${v.kind ?? "general"}${v.fever ? ", fever" : ""}${v.red ? ", EMERGENCY" : ""}`,
        });
      }

      // 3. Referral router: every red patient goes to a facility that can treat them.
      if (v.red) {
        const needsOxygen = (v.needs.oxygen ?? 0) > 0.3 || v.kind === "respiratory";
        const dest = POSTS.filter((p) => p.id !== v.post && (p.hub || (needsOxygen && p.oxygen))).sort((a, b) => km(v.post, a.id) - km(v.post, b.id))[0] ?? POSTS[0];
        const eta = Math.round((km(v.post, dest.id) * 1.6) / 35 * 60);
        const reason = needsOxygen ? "needs oxygen" : "emergency care";
        s.referrals.unshift({ visit: v.id, from: v.post, to: dest.id, reason, mode: "road", etaMin: eta, t: now });
        s.referrals = s.referrals.slice(0, 30);
        send({ from: "Referral router", to: v.post, kind: "referral", text: `Send this patient to ${name(dest.id)} (${reason}). Transport booked, ~${eta} min by road.` });
        send({ from: "Referral router", to: dest.id, kind: "referral", text: `Incoming from ${name(v.post)}: ${v.summary ?? v.kind ?? "emergency"}. ETA ~${eta} min. ${needsOxygen ? "Prepare oxygen." : ""}` });
      }

      // 4. Doctor queue: yellow and red patients from real pods get a doctor.
      if (v.source === "pod" && (v.red || /YELLOW/.test(v.summary ?? ""))) {
        const doctor = DOCTORS[s.doctorTurn++ % DOCTORS.length];
        s.queue.unshift({ visit: v.id, post: v.post, urgency: v.red ? "red" : "yellow", summary: v.summary ?? "", doctor, t: now, status: v.red ? "reviewing" : "waiting" });
        s.queue = s.queue.slice(0, 30);
        send({ from: "Doctor queue", to: v.post, kind: "queue", text: `${doctor} ${v.red ? "is reviewing now" : "will review within the hour"}: ${v.summary ?? ""}` });
      }
    }
  }

  // 2. Outbreak sentinel: a cluster at one post puts every pod nearby on watch.
  for (const a of ctx.alerts.filter((x) => x.level === "red")) {
    const key = `${a.post}-${Math.floor(now / ADVISORY_MS)}`;
    if (s.seenAlerts.has(key)) continue;
    s.seenAlerts.add(key);
    const kind: Advisory["kind"] = guessKind(ctx.visits.filter((v) => v.post === a.post).slice(-20));
    const near = POSTS.filter((p) => km(a.post, p.id) <= ADVISORY_RADIUS_KM).map((p) => p.id);
    send({ from: "Outbreak sentinel", to: "all pods", kind: "alert", text: `${a.text}. Likely ${kind}. Putting ${near.length} nearby posts on watch.` });
    for (const p of near) {
      s.advisories = s.advisories.filter((x) => !(x.post === p && x.kind === kind));
      s.advisories.push({ post: p, kind, text: ADVICE[kind], until: now + ADVISORY_MS, source: name(a.post) });
      send({ from: "Outbreak sentinel", to: p, kind: "advisory", text: ADVICE[kind] });
    }
  }
  s.advisories = s.advisories.filter((x) => x.until > now);

  // 5. Supply allocator: new delivery plans and launches are announced to the receiving pod.
  for (const f of ctx.flights) {
    const before = s.seenFlights.get(f.id);
    if (before === f.status) continue;
    s.seenFlights.set(f.id, f.status);
    const what = f.items.map((i) => `${i.qty} ${SKUS.find((k) => k.id === i.sku)?.label.toLowerCase() ?? i.sku}`).join(", ");
    // Plans are recomputed on every refresh; announce each distinct plan only once per 5 minutes.
    const sig = `${f.to}|${f.mode}|${what}`;
    if (f.status === "proposed" && !firstRun && now - (s.seenProposals.get(sig) ?? 0) > 5 * 60_000) {
      s.seenProposals.set(sig, now);
      send({ from: "Supply allocator", to: "Coordinator", kind: "plan", text: `Proposed ${f.mode} to ${name(f.to)}: ${what}. ${f.reason}` });
    }
    if (f.status === "flying") send({ from: "Supply allocator", to: f.to, kind: "delivery", text: `${f.mode === "drone" ? "Drone" : "Truck"} on the way with ${what}, ~${f.minutes} min.` });
    if (f.status === "delivered") send({ from: "Supply allocator", to: f.to, kind: "delivery", text: `Delivered: ${what}.` });
  }
  if (!firstRun && ctx.shortages.length && now - s.lastShortageNote > 60_000) {
    s.lastShortageNote = now;
    const worst = ctx.shortages[0];
    send({ from: "Supply allocator", to: "Coordinator", kind: "plan", text: `${ctx.shortages.length} shortages predicted; worst: ${worst.label} at ${name(worst.post)} (~${Math.max(1, Math.round(worst.hoursLeft))} h left).` });
  }
}

function guessKind(vs: Visit[]): Advisory["kind"] {
  const count = (k: string) => vs.filter((v) => v.kind === k).length;
  const ranked = (["malaria", "diarrhea", "respiratory"] as const).map((k) => [k, count(k)] as const).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : "malaria";
}

export function advisoriesFor(postId: string): Advisory[] {
  return st().advisories.filter((a) => a.post === postId && a.until > Date.now());
}

export function postBriefing(text: string) {
  send({ from: "Coordinator", to: "all pods", kind: "briefing", text });
}

export function agentsSnapshot() {
  const s = st();
  const counts = (n: AgentName) => s.bus.filter((m) => m.from === n).length;
  return {
    bus: [...s.bus].reverse().slice(0, 120),
    advisories: s.advisories,
    referrals: s.referrals,
    queue: s.queue,
    doctors: DOCTORS,
    agents: (["Pod", "Outbreak sentinel", "Supply allocator", "Referral router", "Doctor queue", "Coordinator"] as AgentName[]).map((n) => ({ name: n, messages: counts(n) })),
  };
}
