import { NextResponse } from "next/server";
import { act, snapshot } from "@/lib/network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await snapshot());
}

// Dashboard buttons: approve flights, start an outbreak, flood a road, reset the demo.
export async function POST(req: Request) {
  act(await req.json());
  return NextResponse.json(await snapshot());
}
