// Second opinion: before the pod asks about a high-stakes sign the camera thinks it saw (a drooping
// face, a hand on the chest, struggling to breathe), Claude looks at the same pictures with a
// strict rubric. A "no" or "unclear" means no question; the disagreement is logged.

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { TRAITS } from "@/lib/triage/traits";
import type { Frame } from "@/lib/triage/types";

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export const OPINION_MODEL = "claude-opus-5-5";
// When the key is capped or the API is down, every call fails the same way for a while: remember
// it (shared across route bundles) and stop asking for ten minutes instead of paying the wait each burst.
const g = globalThis as unknown as { __triageOpinionDown?: { until: number; why: string } };
export const UNAVAILABLE_FOR_MS = 10 * 60_000;
export const opinionDown = (): string | null => (g.__triageOpinionDown && Date.now() < g.__triageOpinionDown.until ? g.__triageOpinionDown.why : null);
export const hasOpinion = () => Boolean(process.env.ANTHROPIC_API_KEY) && !opinionDown();

export type Verdict = { verdict: "yes" | "no" | "unclear"; reason: string };
export type Opinion = { verdicts: Record<string, Verdict>; ms: number; model: string; error?: string };

const RUBRIC =
  "You are the second opinion for a health-post camera. A fast picture model flagged one or more signs on a person sitting in front of the kiosk; most people who sit there are healthy, and a wrong alarm makes the pod ask a frightening question. For each sign listed, look at the pictures (whole views and face close-ups, oldest first) and answer strictly: 'yes' only if the sign is clearly and unmistakably visible in the pictures themselves; 'no' if the pictures show a normal appearance or an ordinary explanation (a hand on the chin or mouth, glasses, a mask, head tilt, uneven light, a shadow, a smirk, chewing, a relaxed resting face, a bad or blurry picture); 'unclear' if the pictures cannot settle it. Never infer from context, never assume. Reply with exactly one line per sign, in the form `<sign_id>: yes|no|unclear - <one short reason>` and nothing else.";

// The smile test: the person was asked to smile showing their teeth. Here asymmetry of MOVEMENT is
// the sign, and a resting grimace or a hand is not an excuse: the question is whether one side moved.
const SMILE_RUBRIC =
  "You are the second opinion for a health-post camera running the FAST stroke smile test: the person was asked to give a big smile showing their teeth, and the pictures (oldest first) were taken during that test. The fast picture model thinks one side of the mouth lifted less than the other. Answer 'yes' only if, in the pictures where the person is smiling or showing teeth, one side of the mouth clearly lifts less or stays flat while the other side lifts (one-sided facial weakness); 'no' if both sides lift about the same, the person did not smile, the mouth is hidden or the picture is too poor; 'unclear' if you cannot tell. Reply with exactly one line: `face_droop: yes|no|unclear - <one short reason>` and nothing else.";

// Judge the given traits on the same frames the scan used. `timeoutMs` bounds the whole call:
// the live pod waits at most ~3 s; the stress-test harness can wait longer.
export async function secondOpinion(frames: Frame[], traitIds: string[], opts: { timeoutMs?: number; wholeFrames?: number; closeups?: number; rubric?: "scan" | "smile" } = {}): Promise<Opinion> {
  const t0 = Date.now();
  const ids = traitIds.filter((id) => TRAITS.some((t) => t.id === id));
  if (!ids.length) return { verdicts: {}, ms: 0, model: OPINION_MODEL };
  const whole = spread(frames, opts.wholeFrames ?? 3);
  const faces = frames.filter((f) => f.face).slice(-(opts.closeups ?? 2));
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  whole.forEach((f, i) => {
    content.push({ type: "text", text: `Whole view ${i + 1} of ${whole.length} (${Math.round(f.secondsAgo)} s ago):` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.b64 } });
  });
  faces.forEach((f, i) => {
    content.push({ type: "text", text: `Face close-up ${i + 1} of ${faces.length} (${Math.round(f.secondsAgo)} s ago):` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.face! } });
  });
  const signs = ids.map((id) => {
    const t = TRAITS.find((x) => x.id === id)!;
    return `- ${id}: ${t.label}. ${t.look}`;
  });
  content.push({ type: "text", text: `Signs to judge:\n${signs.join("\n")}` });
  try {
    const response = await anthropic().beta.messages.create(
      {
        model: OPINION_MODEL,
        max_tokens: 60 * ids.length + 100,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: opts.rubric === "smile" ? SMILE_RUBRIC : RUBRIC,
        messages: [{ role: "user", content }],
      },
      { timeout: opts.timeoutMs ?? 3000, maxRetries: 0 },
    );
    if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const verdicts: Record<string, Verdict> = {};
    for (const id of ids) {
      const m = text.match(new RegExp(`^\\s*\`?${id}\`?\\s*:\\s*(yes|no|unclear)\\b\\s*[-–—:]?\\s*(.*)$`, "im"));
      verdicts[id] = m ? { verdict: m[1].toLowerCase() as Verdict["verdict"], reason: m[2].trim().slice(0, 160) } : { verdict: "unclear", reason: "no readable answer" };
    }
    return { verdicts, ms: Date.now() - t0, model: response.model ?? OPINION_MODEL };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A capped key, bad key or dead API: every call would fail. Stand down for a while and say why.
    if (/usage limits|invalid_request_error|authentication|permission|credit|overloaded/i.test(msg) || /\b(400|401|402|403|529)\b/.test(msg)) {
      const why = /usage limits/i.test(msg) ? "Anthropic key at its usage limit" : `Anthropic API error (${msg.slice(0, 60)})`;
      g.__triageOpinionDown = { until: Date.now() + UNAVAILABLE_FOR_MS, why };
    }
    // No answer counts as unclear and is NOT remembered: the caller decides what an unanswered check means.
    return { verdicts: Object.fromEntries(ids.map((id) => [id, { verdict: "unclear" as const, reason: `no answer: ${msg.slice(0, 80)}` }])), ms: Date.now() - t0, model: OPINION_MODEL, error: msg };
  }
}

// Every disagreement between Jev and Claude on a high-stakes sign, one line per event, for review.
export async function logOpinion(entry: Record<string, unknown>) {
  try {
    const dir = process.env.DATA_DIR ?? "data";
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "judge-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* logging never blocks the scan */
  }
}

function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return out;
}
