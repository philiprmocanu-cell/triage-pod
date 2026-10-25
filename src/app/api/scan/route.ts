import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { lastEvidence } from "@/lib/judge/evidence";
import { scanBurst } from "@/lib/judge/pipeline";
import type { Frame } from "@/lib/triage/types";

export const runtime = "nodejs";

// Live physical scan: Jev checks every trait over the last few seconds of camera pictures, in one
// request. Runs every few seconds while someone is in front of the pod. The high-stakes signs
// (stroke, heart, breathing) only come back once they persisted over three bursts with a clear,
// evenly lit face and Claude agreed on the same pictures (src/lib/judge, docs/CAMERA.md).
export async function POST(req: Request) {
  const { frames, session } = (await req.json()) as { frames: Frame[]; session?: string };
  if (!frames?.length) return NextResponse.json({ error: "No pictures" }, { status: 400 });
  const t0 = Date.now();
  try {
    const r = await scanBurst(frames, session ?? "pod");
    // Testing aid: keep the newest picture Jev judged and its answers (this computer only, overwritten each time).
    if (process.env.SCAN_DEBUG !== "0") {
      const dir = process.env.DATA_DIR ?? "data";
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "last-scan.jpg"), Buffer.from(frames[frames.length - 1].b64, "base64"));
      await fs.writeFile(
        path.join(dir, "last-scan.json"),
        JSON.stringify({ at: new Date().toISOString(), person: r.raw.person, face: r.raw.face, body: r.raw.body, lighting: r.lighting, answers: r.raw.answers, evidence: r.evidence.map((e) => e.line) }, null, 1),
      );
    }
    return NextResponse.json({
      person: r.raw.person,
      face: r.raw.face,
      body: r.raw.body,
      judged: r.judged,
      bodyJudged: r.bodyJudged,
      traits: r.traits,
      lighting: r.lighting,
      evidence: r.evidence.map((e) => e.line),
      ms: Date.now() - t0,
      jevMs: r.raw.ms,
      opinionMs: r.opinion?.ms ?? 0,
    });
  } catch (err) {
    console.error("scan failed", err);
    const msg = err instanceof Error ? err.message : "Scan failed";
    // No guessing from a failed look: the scan reports nothing seen, and says why.
    return NextResponse.json({ error: /jev|typesafe/i.test(msg) ? `The camera brain (Jev) is not answering, so nothing was judged from the pictures. (${msg})` : msg }, { status: 500 });
  }
}

// The operator's evidence line: what the camera thinks it sees right now and why the pod did or
// did not act on it ("face droop 0.52 × 1 burst — not asked (needs 3)").
export async function GET(req: Request) {
  const session = new URL(req.url).searchParams.get("session") ?? "pod";
  const e = lastEvidence(session);
  return NextResponse.json({ at: e.at, face: e.face, lighting: e.lighting, evidence: [...e.evidence.map((x) => x.line), ...e.notes] });
}
