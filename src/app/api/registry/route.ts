import { NextResponse } from "next/server";
import { addVisit, readRegistry, updateVisit, VisitRecord } from "@/lib/registry";
import { handover, readIntake } from "@/lib/triage/brain";
import { rememberWords } from "@/lib/triage/dialect";
import { snapshot } from "@/lib/network";
import { joinCommunity, needsFrom, reportVisit } from "@/lib/spacetime";
import type { Intake, TriageResult, Turn } from "@/lib/triage/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await readRegistry());
}

// Save a finished visit. The record is written at once; Claude fills in the clean name,
// community and the doctor's handover note a few seconds later.
export async function POST(req: Request) {
  const { intake, result, turns, region, village } = (await req.json()) as { intake: Intake; result: TriageResult; turns: Turn[]; region: string; village?: string };
  const consent = (result.consent ?? 0) >= 0.5;
  const record: VisitRecord = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    region,
    consent,
    name: null,
    community: null,
    patient: null,
    ageGroup: result.age_group,
    language: result.language,
    locale: result.locale,
    urgency: result.urgency,
    reason: result.reason,
    causes: result.causes.filter((c) => c.confident).slice(0, 3).map((c) => ({ name: c.name, probability: c.probability })),
    resources: result.resources,
    orders: result.orders ?? [],
    mentalHealth: { category: result.peer_group.category, wantsPeerGroup: result.peer_group.wants, volunteer: result.peer_group.volunteer },
    handover: null,
  };
  await addVisit(record);

  const [who, note] = await Promise.allSettled([readIntake(intake), handover(turns, result)]);
  const id = who.status === "fulfilled" ? who.value : plainIntake(intake);
  const patch = {
    name: consent ? id.name : null,
    community: id.community,
    patient: id.patient,
    handover: note.status === "fulfilled" ? note.value : plainHandover(result),
  };
  await updateVisit(record.id, patch);
  await rememberWords(patch.community ?? intake.community, result.lexicon ?? {}); // the community's words, for next time
  await snapshot().catch((e) => console.error("network refresh after visit failed", e)); // report this patient to the network agents
  // The live map: anything this patient needs is ordered to their home, under their name.
  await reportVisit({
    village: village ?? patch.community ?? "Katete",
    patientName: patch.name ?? "Patient",
    urgency: result.urgency,
    summary: result.reason,
    needs: needsFrom(result.resources, result.orders),
  }).catch((e) => console.error("SpacetimeDB report failed (is `spacetime start` running?)", e));
  // Opt-ins: company for a hard time, or volunteering to give it. First names only, consent required.
  if (consent && patch.name) {
    const v = village ?? patch.community ?? "Katete";
    if (result.peer_group.wants) await joinCommunity({ village: v, name: patch.name, role: "seeking", topic: result.peer_group.category ?? "going through a hard time" }).catch(() => {});
    if (result.peer_group.volunteer) await joinCommunity({ village: v, name: patch.name, role: "volunteer", topic: "offered at the end of a pod visit" }).catch(() => {});
  }
  return NextResponse.json({ ...record, ...patch });
}

// Without Claude: strip the usual lead-in words from the raw answers.
function plainIntake(intake: Intake) {
  const clean = (t: string | undefined, lead: RegExp) => t?.replace(lead, "").replace(/[.¡!¿?]+$/g, "").trim() || null;
  return {
    name: clean(intake.name, /^(me llamo|mi nombre es|soy|my name is|i am|i'm)\s+/i),
    community: clean(intake.community, /^(vengo de|soy de|de la|del|de|from|i'm from|i am from)\s+/i),
    patient: intake.who ?? null,
  };
}

function plainHandover(r: TriageResult) {
  const seen = Object.entries(r.seen).filter(([, v]) => (v ?? 0) >= 0.6).map(([k]) => k.replaceAll("_", " "));
  return [
    `${r.age_group.replace("_", " ")} patient, ${r.urgency.toUpperCase()}: ${r.reason}.`,
    `Findings: ${r.findings.filter((f) => f.yes >= 0.6).map((f) => f.label).join(", ") || "none confirmed"}${seen.length ? `; camera: ${seen.join(", ")}` : ""}.`,
    `Needs: ${r.resources.slice(0, 4).map((x) => x.item).join(", ") || "none"}.`,
  ].join(" ");
}
