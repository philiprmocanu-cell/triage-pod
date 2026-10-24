import { NextResponse } from "next/server";
import { classifierInstalled, classifyWav, warmClassifier, type Classification } from "@/lib/mosquito/classifier";
import { vectorVerdict, type VectorVerdict } from "@/lib/mosquito/vectors";
import { reportVisit } from "@/lib/spacetime";

export const runtime = "nodejs";
export const maxDuration = 120;

export type MosquitoResult = Classification & { verdict: VectorVerdict; village: string };

// GET: is the classifier installed? Also warms the Python worker so the first clip is quick.
export async function GET() {
  const installed = classifierInstalled();
  if (installed) warmClassifier();
  return NextResponse.json({
    installed,
    models: "HumBug MozzBNN (Oxford, MIT): neurips_2021_humbugdb_keras_bnn_best (mosquito / not) + Win_30_Stride_5 8-species BNN",
    species: ["Anopheles arabiensis", "Culex pipiens complex", "Aedes aegypti", "Anopheles funestus s.s.", "Anopheles squamosus", "Anopheles coustani", "Mansonia uniformis", "Mansonia africanus"],
  });
}

// POST multipart: `audio` (WAV blob) + `village` -> classification + vector verdict + suggested order.
// POST JSON { audioBase64, village } does the same.
// POST JSON { action: "order", village, species, summary, orders } -> sends the order to the
// village's live network (SpacetimeDB `reportVisit`), the same path a triaged patient uses.
export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = await req.json();
      if (body.action === "order") return order(body);
      if (!body.audioBase64) return NextResponse.json({ error: "audioBase64 or multipart `audio` required" }, { status: 400 });
      return NextResponse.json(await classify(Buffer.from(body.audioBase64, "base64"), body.village));
    }
    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof Blob)) return NextResponse.json({ error: "multipart field `audio` (WAV) required" }, { status: 400 });
    const village = typeof form.get("village") === "string" ? (form.get("village") as string) : undefined;
    return NextResponse.json(await classify(Buffer.from(await audio.arrayBuffer()), village));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[mosquito]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function classify(wav: Buffer, village?: string): Promise<MosquitoResult> {
  const c = await classifyWav(wav);
  return { ...c, verdict: vectorVerdict(c.species, c.mosquito), village: village || "Katete" };
}

async function order(body: { village?: string; species?: string; summary?: string; orders?: { item: string; qty: number }[]; urgency?: string }) {
  const village = body.village || "Katete";
  const needs = (body.orders ?? []).map((o) => ({ item: o.item, qty: Math.max(1, Math.round(o.qty)) }));
  const urgency = (body.urgency === "red" || body.urgency === "yellow" || body.urgency === "green" ? body.urgency : "yellow") as "red" | "yellow" | "green";
  const summary = body.summary ?? `Mosquito listener: ${body.species ?? "mosquito"} wingbeat heard near the pod`;
  try {
    await reportVisit({ village, patientName: "Mosquito listener", urgency, summary, needs });
    return NextResponse.json({ sent: true, village, needs, summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ sent: false, village, needs, summary, reason: `Live network not reachable (${message}). Is \`spacetime start\` running?` });
  }
}
