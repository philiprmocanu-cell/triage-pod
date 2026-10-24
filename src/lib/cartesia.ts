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

// The patient's dialect -> the Cartesia accents to look for, closest first. Cartesia has native
// Mexican, Panamanian, Colombian, Argentinian, Dominican, Bolivian (camba) and Spain voices;
// for regions without their own voice we use the nearest neighbour.
const ACCENTS: Record<string, string[]> = {
  "es-MX": ["mexican"],
  "es-GT": ["mexican", "panamanian"],
  "es-HN": ["panamanian", "mexican"],
  "es-SV": ["panamanian", "mexican"],
  "es-NI": ["panamanian", "mexican"],
  "es-PA": ["panamanian"],
  "es-CO": ["colombian"],
  "es-EC": ["colombian", "peruvian"],
  "es-PE": ["peruvian", "colombian"],
  "es-BO": ["camba", "peruvian", "colombian"],
  "es-AR": ["argentinian"],
  "es-CL": ["chilean", "argentinian"],
  "es-DO": ["dominican"],
  "es-ES": ["castilian"],
  "es-US": ["united-states-spanish", "mexican"],
};

// Cartesia's speech engine accepts only these Spanish regions; the voice carries the accent.
export function ttsLocale(locale: string): string {
  if (locale.startsWith("en")) return "en-US";
  if (locale === "es-ES") return "es-ES";
  if (["es-MX", "es-GT", "es-HN", "es-SV", "es-NI"].includes(locale)) return "es-MX";
  return "es-US"; // neutral Latin American
}

type CatalogVoice = Omit<Voice, "gender"> & { accents?: { accent: string; locale: string; is_native: boolean }[]; gender?: string | null };

let catalog: Promise<CatalogVoice[]> | null = null;
async function loadCatalog(): Promise<CatalogVoice[]> {
  const voices: CatalogVoice[] = [];
  let page = await cartesia().voices.list({ limit: 100 });
  voices.push(...page.data);
  while (page.hasNextPage()) {
    page = await page.getNextPage();
    voices.push(...page.data);
  }
  return voices;
}

export type PickedVoice = { id: string; name: string; locale: string; match: string };

// Find the voice that sounds most like the patient's region. A warm female voice by default.
export async function pickVoice(locale: string): Promise<PickedVoice> {
  const cloned = clonedByLocale.get(locale);
  if (cloned) return { ...cloned, locale, match: "cloned local voice" };

  catalog ??= loadCatalog().catch((e) => {
    catalog = null;
    throw e;
  });
  const voices = await catalog;
  const lang = locale.split("-")[0];
  const native = (v: CatalogVoice, accent: string) => v.accents?.some((a) => a.accent === accent && a.is_native);
  const prefer = (list: CatalogVoice[]) => list.find((v) => v.gender === "feminine") ?? list[0];

  for (const accent of ACCENTS[locale] ?? []) {
    const v = prefer(voices.filter((x) => x.language === lang && native(x, accent)));
    if (v) return { id: v.id, name: v.name, locale, match: `${accent} accent` };
  }
  const v = prefer(voices.filter((x) => x.language === lang));
  if (v) return { id: v.id, name: v.name, locale, match: "same language" };
  throw new Error(`No Cartesia voice found for ${locale}`);
}
