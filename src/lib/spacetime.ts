import type { Resource, TriageResult, Urgency } from "@/lib/triage/types";
import type { VisitRecord } from "@/lib/registry";

// Sends a finished pod visit to the SpacetimeDB network (spacetime/spacetimedb). The globe at
// /globe subscribes to it, so the "+1" and the delivery to the patient's home show up live.
// Also keeps the pods themselves live: `podHeartbeat` (which pods are on and what each is doing),
// `saveVisitRecord` (the saved visit and its handover note, for the staff pages) and
// `rememberWordsLive` / `communityLexiconLive` (the words a community uses, shared across pods).

const URL_BASE = process.env.SPACETIME_HTTP ?? "http://127.0.0.1:3000";
const DB = process.env.SPACETIME_DB ?? "podnet";

// Reducer arguments go as a JSON array, in the order the module declares them; object fields
// are snake_case on this path (`created_at`, not `createdAt`).
async function call(reducer: string, args: unknown[]) {
  const res = await fetch(`${URL_BASE}/v1/database/${DB}/call/${reducer}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`SpacetimeDB ${reducer} ${res.status}: ${await res.text()}`);
}

// The pod's resource wording → the stock items the network actually moves.
const ITEM_FOR: [RegExp, string][] = [
  [/amoxicillin|pre-referral antibiotic/i, "Amoxicillin"],
  [/malaria rapid test/i, "Malaria rapid test"],
  [/artemisinin|artesunate|antimalarial/i, "Antimalarial (ACT)"],
  [/oral rehydration|\bors\b/i, "Oral rehydration salts"],
  [/\bzinc\b/i, "Zinc"],
  [/paracetamol/i, "Paracetamol"],
  [/^oxygen/i, "Oxygen cylinder"],
  [/rutf|therapeutic food/i, "Therapeutic food (RUTF)"],
];
const NEEDED = 0.5; // a resource has to be this likely before anything is sent

// The pod's exact order when it has one (confident conditions only); otherwise the older
// best-effort mapping from its resource list.
export function needsFrom(resources: Resource[], orders?: TriageResult["orders"]): { item: string; qty: number }[] {
  if (orders) return orders.map((o) => ({ item: o.item, qty: o.qty }));
  const items = new Set<string>();
  for (const r of resources) {
    if (r.probability < NEEDED) continue;
    const hit = ITEM_FOR.find(([re]) => re.test(r.item));
    if (hit) items.add(hit[1]);
  }
  return [...items].map((item) => ({ item, qty: 1 }));
}

export async function joinCommunity(m: { village: string; name: string; role: "seeking" | "volunteer"; topic: string }) {
  await call("join_community", [m.village, m.name, m.role, m.topic]);
}

export async function reportVisit(v: { village: string; patientName: string; urgency: Urgency; summary: string; needs: { item: string; qty: number }[] }) {
  await call("report_visit", [v.village, v.patientName, v.urgency, v.summary, v.needs]);
}

// ---- Pod presence ----

export type PodStatus = "idle" | "listening" | "thinking" | "speaking" | "offline";

// The pod screen, every few seconds and whenever its status changes. `step` is what the pod is
// asking about right now (the turn's `asks`), `language` what the patient speaks. Status
// "offline" when the screen closes; otherwise the network marks it offline 20 s after the last beat.
export async function podHeartbeat(p: { village: string; status: PodStatus; step?: string; language?: string }) {
  await call("pod_heartbeat", [p.village, p.status, p.step ?? "", p.language ?? ""]);
}

// ---- Visit records ----

// The saved visit, as the registry has it. Call again with the same id to update (the handover
// note lands a few seconds after the record). Lists travel as JSON text.
export async function saveVisitRecord(r: VisitRecord) {
  await call("save_visit_record", [
    {
      id: r.id,
      village: r.village ?? "",
      created_at: r.createdAt,
      region: r.region,
      consent: r.consent,
      name: r.name ?? "",
      community: r.community ?? "",
      patient: r.patient ?? "",
      age_group: r.ageGroup,
      language: r.language,
      locale: r.locale,
      urgency: r.urgency,
      reason: r.reason,
      causes: JSON.stringify(r.causes),
      resources: JSON.stringify(r.resources),
      orders: JSON.stringify(r.orders ?? []),
      mental_category: r.mentalHealth.category ?? "",
      wants_peer_group: r.mentalHealth.wantsPeerGroup,
      volunteer: r.mentalHealth.volunteer ?? false,
      handover: r.handover ?? "",
    },
  ]);
}

// ---- Community lexicon ----

export type LiveLexicon = Partial<Record<string, string>>; // concept -> the community's word

// The words this patient used, counted for their community in the shared table.
export async function rememberWordsLive(community: string | null | undefined, lex: LiveLexicon) {
  const words = Object.entries(lex).filter(([, w]) => w).map(([concept, word]) => ({ concept, word }));
  if (!community || !words.length) return;
  await call("remember_words", [community, words]);
}

// The words this community uses most, from every pod's visits (not only this machine's file).
export async function communityLexiconLive(community: string | null | undefined): Promise<LiveLexicon> {
  if (!community) return {};
  const key = community.trim().toLowerCase().replace(/'/g, "''");
  const res = await fetch(`${URL_BASE}/v1/database/${DB}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: `SELECT concept, word, times FROM dialect_word WHERE community = '${key}'`,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`SpacetimeDB sql ${res.status}`);
  const [result] = (await res.json()) as { rows: [string, string, number][] }[];
  const best = new Map<string, { word: string; times: number }>();
  for (const [concept, word, times] of result?.rows ?? []) {
    if ((best.get(concept)?.times ?? 0) < times) best.set(concept, { word, times });
  }
  return Object.fromEntries([...best].map(([concept, { word }]) => [concept, word]));
}
