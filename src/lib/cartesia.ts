import Cartesia from "@cartesia/cartesia-js";
import type { Voice } from "@cartesia/cartesia-js/resources/voices";

export const TTS_MODEL = "sonic-3.5";
export const STT_MODEL = "ink-whisper";

let client: Cartesia | null = null;
export function cartesia(): Cartesia {
  if (!process.env.CARTESIA_API_KEY) throw new Error("CARTESIA_API_KEY is not set in .env.local");
  return (client ??= new Cartesia({ apiKey: process.env.CARTESIA_API_KEY }));
}

export const hasCartesia = () => Boolean(process.env.CARTESIA_API_KEY);

// Voices cloned at this post (e.g. the health worker), keyed by locale. Wins over the catalog.
const clonedByLocale = new Map<string, { id: string; name: string }>();
export function registerClonedVoice(locale: string, id: string, name: string) {
  clonedByLocale.set(locale, { id, name });
}

let catalog: Promise<Voice[]> | null = null;
async function loadCatalog(): Promise<Voice[]> {
  const voices: Voice[] = [];
  let page = await cartesia().voices.list({ limit: 100 });
  voices.push(...page.data);
  for (let i = 0; i < 9 && page.hasNextPage(); i++) {
    page = await page.getNextPage();
    voices.push(...page.data);
  }
  return voices;
}

export type PickedVoice = { id: string; name: string; locale: string; match: "cloned" | "native" | "locale" | "language" };

// Find the voice that sounds most like the patient's region.
export async function pickVoice(locale: string): Promise<PickedVoice> {
  const cloned = clonedByLocale.get(locale);
  if (cloned) return { ...cloned, locale, match: "cloned" };

  catalog ??= loadCatalog().catch((e) => {
    catalog = null;
    throw e;
  });
  const voices = await catalog;
  const lang = locale.split("-")[0];
  const lc = locale.toLowerCase();

  const native = voices.find((v) => v.locales?.some((l) => l.locale.toLowerCase() === lc && l.is_native));
  if (native) return { id: native.id, name: native.name, locale, match: "native" };
  const anyLocale = voices.find((v) => v.locales?.some((l) => l.locale.toLowerCase() === lc));
  if (anyLocale) return { id: anyLocale.id, name: anyLocale.name, locale, match: "locale" };
  const sameLang = voices.find((v) => v.language === lang);
  if (sameLang) return { id: sameLang.id, name: sameLang.name, locale, match: "language" };
  throw new Error(`No Cartesia voice found for ${locale}`);
}
