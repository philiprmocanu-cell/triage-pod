import { NextResponse } from "next/server";
import { forcedFloods, setForcedFlood } from "@/lib/routes/flood";
import { planAllOpen, loadWorld } from "@/lib/routes/planner";
import { logAgent } from "@/lib/spacetime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The test switch on the Routes page. GET lists the roads under water; POST { village, on }
// floods or dries one village's road and plans every open order again so the re-routes show.
export async function GET() {
  return NextResponse.json({ floods: await forcedFloods() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { village?: string; on?: boolean };
  const key = (body.village ?? "Katete").trim().toLowerCase();
  const { villages } = await loadWorld();
  const v = villages.find((x) => x.name.toLowerCase().includes(key));
  if (!v) return NextResponse.json({ error: `no village matches "${body.village}"` }, { status: 400 });
  const on = body.on !== false;
  const floods = await setForcedFlood({ name: v.name.replace(/ \(.*\)$/, ""), lat: v.lat, lng: v.lng }, on);
  await logAgent("Weather", v.name, on ? `${v.name.replace(/ \(.*\)$/, "")} road flooded (test switch): road vehicles cannot pass within 25 km; re-planning every open order.` : `${v.name.replace(/ \(.*\)$/, "")} road dry again (test switch); re-planning.`);
  const results = await planAllOpen(new URL(req.url).origin, { replan: true });
  return NextResponse.json({ floods, replanned: results });
}
