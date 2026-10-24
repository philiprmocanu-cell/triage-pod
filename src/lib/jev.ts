// Jev (TypeSafe System One): fast, calibrated yes/no, choice and score answers about text and
// pictures. Docs: https://docs.typesafe.ai

const URL = "https://api.typesafe.ai/v1/systemone";

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export const hasJev = () => Boolean(process.env.TYPESAFE_API_KEY);

export async function jev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  images: Record<string, string> = {}, // reference -> base64 JPEG
): Promise<Record<string, JevAnswer>> {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set in .env.local");
  const withImages = Object.keys(images).length > 0;
  const body = {
    model: "jev-latest",
    state,
    questions,
    ...(withImages && {
      assets: Object.fromEntries(
        Object.entries(images).map(([ref, b64]) => [ref, { type: "image", format: "jpg", data_base64: b64 }]),
      ),
    }),
  };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
        ...(withImages && { "TypeSafe-Danger-Zone-Images": "true" }),
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()).answers;
    if ((res.status === 429 || res.status === 529) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export const noulOf = (a: JevAnswer | undefined) => (a?.type === "noul" ? a.noul : 0);
export const probsOf = (a: JevAnswer | undefined) => (a && a.type !== "noul" ? a.probabilities : {});
