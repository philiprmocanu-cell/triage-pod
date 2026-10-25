// Sweat on the face, judged from one close-up when the main camera scan cannot score it.
// A clear yes is high enough for the pod to ask. A dry face stays low.

import type { Frame } from "@/lib/triage/types";

const MODEL = "grok-4-fast";
const CACHE_MS = 4000;
const g = globalThis as unknown as { __sweatCache?: { at: number; score: number } };

export async function sweatScore(frames: Frame[]): Promise<number | null> {
  const hit = g.__sweatCache;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.score;
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  const frame = [...frames].reverse().find((f) => f.face) ?? frames[frames.length - 1];
  const b64 = frame?.face || frame?.b64;
  if (!b64) return null;
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 8,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            {
              type: "text",
              text: "Is this person's hair wet right now? Yes if the hair looks damp, soaked, or stuck to the skin. No if the hair looks dry. Reply with exactly YES or NO.",
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    console.error("sweat look failed", res.status, (await res.text()).slice(0, 180));
    return null;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? "";
  const score = /\byes\b/i.test(text) ? 0.92 : /\bno\b/i.test(text) ? 0.08 : null;
  if (score == null) return null;
  g.__sweatCache = { at: Date.now(), score };
  return score;
}
