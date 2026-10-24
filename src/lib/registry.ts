// Patient registry: one record per visit, so the health team can see who needs what, where.
// Stored as a local JSON file for the demo, and mirrored into SpacetimeDB (`visit_record`) so the
// staff and patient pages see each visit the moment it is saved. A real deployment needs
// encryption, access control and the country's health-data rules; names are saved only when the
// patient agreed.

import { promises as fs } from "fs";
import path from "path";
import type { Resource, Urgency } from "./triage/types";
import { saveVisitRecord } from "./spacetime";

export type VisitRecord = {
  id: string;
  createdAt: string;
  region: string;
  village?: string | null; // the post the pod stands at (?village= on the kiosk), when known
  consent: boolean;
  name: string | null; // null when the patient did not agree to be saved
  community: string | null;
  patient: string | null; // "self" / "daughter, 3 years" ...
  ageGroup: string;
  language: string;
  locale: string;
  urgency: Urgency;
  reason: string;
  causes: { name: string; probability: number }[];
  resources: Resource[];
  orders?: { item: string; qty: number; note?: string; for: string }[];
  mentalHealth: { category: string | null; wantsPeerGroup: boolean; volunteer?: boolean };
  handover: string | null;
};

const file = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "registry.json");

export async function readRegistry(): Promise<VisitRecord[]> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8"));
  } catch {
    return [];
  }
}

export async function addVisit(record: VisitRecord) {
  const all = await readRegistry();
  all.push(record);
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(all, null, 2));
  await mirror(record);
}

export async function updateVisit(id: string, patch: Partial<VisitRecord>) {
  const all = await readRegistry();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return;
  all[i] = { ...all[i], ...patch };
  await fs.writeFile(file(), JSON.stringify(all, null, 2));
  await mirror(all[i]);
}

// The file is the record of truth for the demo; the network copy is best effort.
async function mirror(record: VisitRecord) {
  await saveVisitRecord(record).catch((e) => console.error("SpacetimeDB visit_record mirror failed (is `spacetime start` running?)", e));
}

// What each community needs: expected units = sum of each patient's probability of needing it.
export function needsByCommunity(records: VisitRecord[]) {
  const out = new Map<string, Map<string, number>>();
  for (const r of records) {
    const c = r.community ?? "Unknown";
    const m = out.get(c) ?? new Map<string, number>();
    for (const res of r.resources) m.set(res.item, (m.get(res.item) ?? 0) + res.probability);
    out.set(c, m);
  }
  return out;
}

// Peer support groups and community circles: people in the same community with a similar need
// (depression, anxiety, grief, loneliness) who asked to be introduced. Never includes anyone at
// risk of suicide (they get urgent one-to-one care).
export function peerGroups(records: VisitRecord[]) {
  const groups = new Map<string, VisitRecord[]>();
  for (const r of records) {
    if (!r.consent || !r.mentalHealth.wantsPeerGroup || !r.mentalHealth.category || r.mentalHealth.category === "Suicide risk") continue;
    const key = `${r.community ?? "Unknown"} · ${r.mentalHealth.category}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return groups;
}
