import { NextResponse } from "next/server";
import { hasGrokVoice } from "@/lib/grokVoice";
import { hasJev } from "@/lib/jev";

// Tells the pod screen which services are configured, so it can fall back to typing / browser voice.
export async function GET() {
  return NextResponse.json({
    grok: hasGrokVoice(),
    jev: hasJev(),
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
