import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { lastEvidence } from "@/lib/judge/evidence";
import { scanBurst } from "@/lib/judge/pipeline";
import { sweatScore } from "@/lib/judge/sweat";
import type { Frame } from "@/lib/triage/types";

export const runtime = "nodejs";

const billing = globalThis as unknown as { __jevBillingUntil?: number };
const jevBillingDown = () => (billing.__jevBillingUntil ?? 0) > Date.now();

// Live physical scan: Jev checks every trait over the last few seconds of camera pictures, in one
// request. Runs every few seconds while someone is in front of the pod. The high-stakes signs
// (stroke, heart, breathing) only come back once they persisted over three bursts with a clear,
// evenly lit face and Claude agreed on the same pictures (src/lib/judge, docs/CAMERA.md).
export async function POST(req: Request) {
  const { frames, session } = (await req.json()) as { frames: Frame[]; session?: string };
  if (!frames?.length) return NextResponse.json({ error: "No pictures" }, { status: 400 });
  const t0 = Date.now();
  try {
    const r = jevBillingDown() ? null : await scanBurst(frames, session ?? "pod");
    let traits = r?.traits ?? {};
    let judged = r?.judged ?? false;
    if ((traits.sweaty ?? 0) < 0.4) {
      const sweaty = await sweatScore(frames);
      if (sweaty != null && sweaty > (traits.sweaty ?? 0)) {
        traits = { ...traits, sweaty };
        if (sweaty >= 0.4) judged = true;
      }
    }
    if (process.env.SCAN_DEBUG !== "0") {
      const dir = process.env.DATA_DIR ?? "data";
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "last-scan.jpg"), Buffer.from((frames[frames.length - 1].face || frames[frames.length - 1].b64), "base64"));
      await fs.writeFile(
        path.join(dir, "last-scan.json"),
        JSON.stringify({ at: new Date().toISOString(), person: r?.raw.person ?? null, face: r?.raw.face ?? null, body: r?.raw.body ?? null, lighting: r?.lighting ?? null, answers: { ...(r?.raw.answers ?? {}), sweaty: traits.sweaty ?? 0 }, evidence: r?.evidence.map((e) => e.line) ?? [] }, null, 1),
      );
    }
    if (!r && traits.sweaty == null) throw new Error("The camera brain (Jev) is not answering, and the sweat look did not return a score.");
    return NextResponse.json({
      person: r?.raw.person ?? (judged ? 0.9 : 0),
      face: r?.raw.face ?? (judged ? 0.9 : 0),
      body: r?.raw.body ?? 0,
      judged,
      bodyJudged: r?.bodyJudged ?? false,
      traits,
      lighting: r?.lighting ?? null,
      evidence: r?.evidence.map((e) => e.line) ?? [],
      ms: Date.now() - t0,
      jevMs: r?.raw.ms ?? 0,
      opinionMs: r?.opinion?.ms ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scan failed";
    if (/402|billing|credits/i.test(msg)) billing.__jevBillingUntil = Date.now() + 60_000;
    const sweaty = await sweatScore(frames).catch(() => null);
    if (sweaty != null) {
      const seen = sweaty >= 0.4;
      return NextResponse.json({
        person: seen ? 0.9 : 0,
        face: seen ? 0.9 : 0,
        body: 0,
        judged: seen,
        bodyJudged: false,
        traits: { sweaty },
        lighting: null,
        evidence: [],
        ms: Date.now() - t0,
        jevMs: 0,
        opinionMs: 0,
      });
    }
    console.error("scan failed", msg.slice(0, 220));
    return NextResponse.json({ error: /jev|typesafe|sweat look/i.test(msg) ? `The camera brain (Jev) is not answering, so nothing was judged from the pictures. (${msg})` : msg }, { status: 500 });
  }
}

// The operator's evidence line: what the camera thinks it sees right now and why the pod did or
// did not act on it ("face droop 0.52 × 1 burst — not asked (needs 3)").
export async function GET(req: Request) {
  const session = new URL(req.url).searchParams.get("session") ?? "pod";
  const e = lastEvidence(session);
  return NextResponse.json({ at: e.at, face: e.face, lighting: e.lighting, evidence: [...e.evidence.map((x) => x.line), ...e.notes] });
}
