import type { Resource, TriageResult, Urgency } from "@/lib/triage/types";

// Sends a finished pod visit to the SpacetimeDB network (spacetime/spacetimedb). The globe at
// /globe subscribes to it, so the "+1" and the delivery to the patient's home show up live.

const URL_BASE = process.env.SPACETIME_HTTP ?? "http://127.0.0.1:3000";
const DB = process.env.SPACETIME_DB ?? "podnet";

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

export async function reportVisit(v: { village: string; patientName: string; urgency: Urgency; summary: string; needs: { item: string; qty: number }[] }) {
  const res = await fetch(`${URL_BASE}/v1/database/${DB}/call/report_visit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([v.village, v.patientName, v.urgency, v.summary, v.needs]),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`SpacetimeDB report_visit ${res.status}: ${await res.text()}`);
}
