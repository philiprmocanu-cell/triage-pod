import { NextResponse } from "next/server";
import { getSession, resetSession, setState, setVitals, Vitals } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSession());
}

export async function POST(req: Request) {
  const body = (await req.json()) as { state?: unknown; vitals?: Vitals; reset?: boolean };
  if (body.reset) resetSession();
  if (body.state !== undefined) setState(body.state);
  if (body.vitals) setVitals(body.vitals);
  return NextResponse.json({ ok: true });
}
