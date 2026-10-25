// Words for the plan. The decisions are made in plan.ts; this only explains them. `explainPlan`
// is deterministic and always available; `explainWithClaude` asks Claude to word the same facts
// the way the officer's briefing does (src/lib/triage/brain.ts provincialBriefing), and falls
// back to the deterministic paragraph when the model is unavailable.

import Anthropic from "@anthropic-ai/sdk";
import type { DispatchPlan } from "./plan";

const list = (xs: string[], max = 4) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);

export function explainPlan(plan: DispatchPlan): string {
  const c = plan.counts;
  const parts: string[] = [];
  if (plan.emergency.active) parts.push(`Emergency mode is on: ${plan.emergency.reasons.join("; ")}.`);
  if (!plan.shipments.length) return `${parts.join(" ")} Nothing to send: every post holds its minimum, no roads are closing and no pod is waiting.`.trim();
  parts.push(`${c.emergency + c.urgent + c["pre-position"] + c.routine} shipments to ${c.posts} posts, ${c.items} units, ${c.kg} kg in all.`);
  const em = plan.shipments.filter((s) => s.priority === "emergency");
  if (em.length) parts.push(`${em.length} go now by the fastest carrier that can carry them: ${list(em.map((s) => `${s.toVillage} (${s.why[0].replace(/^\d+ red visits? open at [^:]+: /, "")})`), 3)}.`);
  const ur = plan.shipments.filter((s) => s.priority === "urgent");
  if (ur.length) parts.push(`${ur.length} are urgent today because a pod asked and the order has not landed: ${list(ur.map((s) => s.toVillage))}.`);
  const pre = plan.shipments.filter((s) => s.priority === "pre-position");
  if (pre.length) parts.push(`${pre.length} are pre-positioned before the roads close: ${list(pre.map((s) => `${s.toVillage} by ${s.sendBy}`))}, sized for three weeks of the expected malaria and diarrhoea cases.`);
  const seasonal = plan.shipments.filter((s) => s.priority === "pre-position-seasonal");
  if (seasonal.length) parts.push(`${seasonal.length} ${seasonal.length === 1 ? "is" : "are"} pre-positioned from the ten-year season calendar, because the roads there usually close within six weeks: ${list(seasonal.map((s) => `${s.toVillage} by ${s.sendBy}`))}, sized for the usual closure weeks and the malaria peak.`);
  else {
    const soon = plan.posts.filter((p) => p.season?.closureStart && (p.season.daysUntilClosure ?? 999) > 0).sort((a, b) => (a.season!.daysUntilClosure ?? 0) - (b.season!.daysUntilClosure ?? 0));
    if (soon.length) parts.push(`No seasonal pre-positioning is due yet: the first roads that usually close are ${list(soon.slice(0, 3).map((p) => `${p.name} (${p.season!.closureStart}, truck by ${p.season!.sendBy})`), 3)}.`);
  }
  const ro = plan.shipments.filter((s) => s.priority === "routine");
  if (ro.length) parts.push(`${ro.length} routine top-ups ride on ${plan.runs.length} batched ${plan.runs.length === 1 ? "run" : "runs"} (${list(plan.runs.map((r) => `${r.label.replace(/^Run /, "run ")} with ${r.carrierName}, ${r.posts.length} posts`), 3)}).`);
  const raised = plan.posts.filter((p) => p.malariaOutlook6w !== "low");
  if (raised.length) parts.push(`Malaria test and treatment targets are raised at ${raised.length} posts where the six-week outlook is medium or high.`);
  const closing = plan.posts.filter((p) => p.daysUntilCutOff !== null && !p.cutOffNow);
  if (closing.length) parts.push(`Roads may close within a fortnight at ${list(closing.map((p) => `${p.name} (${p.daysUntilCutOff} d)`), 4)}.`);
  if (plan.notes.length) parts.push(`Could not be fully met: ${plan.notes.length} ${plan.notes.length === 1 ? "line" : "lines"} (${list(plan.notes.slice(0, 2).map((n) => n.replace(/\.$/, "")), 2)}).`);
  parts.push(plan.carrierSource === "table" ? "Carriers are the fleet in the carrier table." : "Carriers are the planner's own list of the province's real fleet until the carrier table is published.");
  return parts.join(" ");
}

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export async function explainWithClaude(plan: DispatchPlan): Promise<{ text: string; by: "claude" | "planner" }> {
  const facts = {
    emergency: plan.emergency,
    counts: plan.counts,
    top: plan.shipments.slice(0, 8).map((s) => ({ rank: s.rank, post: s.toVillage, priority: s.priority, items: s.items.map((i) => `${i.qty} ${i.item}`), carrier: s.carrierName, send_by: s.sendBy, reasons: s.why })),
    runs: plan.runs.map((r) => `${r.label}: ${r.carrierName}, ${r.posts.join(", ")}, ${r.kg} kg, ${r.km} km`),
    roads_closing: plan.posts.filter((p) => p.daysUntilCutOff !== null).map((p) => `${p.name}: ${p.cutOffNow ? "closed now" : `${p.daysUntilCutOff} days`} (risk ${Math.round(p.cutOffRisk * 100)}%)`),
    raised_targets: plan.posts.filter((p) => p.malariaOutlook6w !== "low").map((p) => `${p.name}: ${p.malariaOutlook6w}`),
    not_met: plan.notes,
    season_calendar: plan.posts.filter((p) => p.season?.closureStart).slice(0, 6).map((p) => `${p.name}: roads usually close ${p.season!.closureStart} → ${p.season!.closureEnd}, seasonal shipment by ${p.season!.sendBy}${p.season!.inWindow ? " (due)" : ""}`),
    weather_source: plan.weatherSource,
  };
  try {
    const response = await anthropic().beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 600,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system:
        "You explain the Chipata distribution centre's dispatch plan to the Provincial Medical Officer of Eastern Province, Zambia. The plan was made by a deterministic planner from live stock, open visits, the satellite weather outlook and the real fleet; you do not change it. From FACTS write one paragraph of 4 to 6 plain sentences, no headings or bullets, no emojis: what goes out now and why, what is being sent ahead of road closures, what rides on the batched runs, and what could not be met. Use only the village names, items, numbers and dates in FACTS.",
      messages: [{ role: "user", content: JSON.stringify(facts) }],
    });
    if (response.stop_reason === "refusal") throw new Error("declined");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return text ? { text, by: "claude" } : { text: explainPlan(plan), by: "planner" };
  } catch {
    return { text: explainPlan(plan), by: "planner" };
  }
}
