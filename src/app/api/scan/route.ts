import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { jev, JevQuestion, noulOf } from "@/lib/jev";
import { TRAITS } from "@/lib/triage/traits";
import type { Frame } from "@/lib/triage/types";

export const runtime = "nodejs";

// Most people who sit at a pod are well; a scan that leans "yes" on a normal face sends the pod
// asking about problems that aren't there.
const CALIBRATE =
  "Look at the `frames` (a few seconds of camera pictures of a person at a health post, oldest first; each has the whole picture and, when present, a `face_closeup` of the same moment: use the close-up for anything about the face, eyes, lips or skin, the whole picture for posture, hands and who is there). Most people here are healthy, and a calm, neutral, tired or bored face is normal: answer no unless the sign is clearly there.";
const FACE_CLEAR = 0.6; // below this the pictures aren't judged at all

// Live physical scan: Jev checks every trait over the last few seconds of camera pictures, in one
// request. Runs every few seconds while someone is in front of the pod.
export async function POST(req: Request) {
  const { frames } = (await req.json()) as { frames: Frame[] };
  if (!frames?.length) return NextResponse.json({ error: "No pictures" }, { status: 400 });
  const t0 = Date.now();
  const images: Record<string, string> = {};
  const seq = frames.slice(-3).map((f, i) => {
    const ref = `scan-${t0}-${i}-5e8a`;
    images[ref] = f.b64;
    if (f.face) images[`${ref}-face`] = f.face;
    return { seconds_ago: Math.round(f.secondsAgo), picture: ref, ...(f.face && { face_closeup: `${ref}-face` }) };
  });
  const q: Record<string, JevQuestion> = {
    person_visible: { type: "noul", instructions: "In the `frames`, is a person clearly visible?" },
    face_clear: {
      type: "noul",
      instructions: "In the `frames`, is one person's face close to the camera and facing it: the face fills a good part of the picture (at least a fifth of its height), both eyes are visible, and it is lit well enough to judge skin colour? Someone far away, at the edge, side-on or in the background counts as no.",
    },
  };
  for (const t of TRAITS) {
    q[t.id] = { type: "noul", instructions: `${CALIBRATE} ${t.look}` };
  }
  try {
    const a = await jev({ setting: "Patient sitting in front of a health pod camera.", frames: seq }, q, images);
    const person = noulOf(a.person_visible);
    const face = noulOf(a.face_clear);
    // Testing aid: keep the newest picture Jev judged and its answers (this computer only, overwritten each time).
    if (process.env.SCAN_DEBUG !== "0") {
      const dir = process.env.DATA_DIR ?? "data";
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "last-scan.jpg"), Buffer.from(frames[frames.length - 1].b64, "base64"));
      await fs.writeFile(path.join(dir, "last-scan.json"), JSON.stringify({ at: new Date().toISOString(), person, face, answers: Object.fromEntries(TRAITS.map((t) => [t.id, noulOf(a[t.id])])) }, null, 1));
    }
    const judged = person >= 0.5 && face >= FACE_CLEAR;
    const traits = Object.fromEntries(TRAITS.map((t) => [t.id, judged ? noulOf(a[t.id]) : 0]));
    return NextResponse.json({ person, face, judged, traits, ms: Date.now() - t0 });
  } catch (err) {
    console.error("scan failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Scan failed" }, { status: 500 });
  }
}
