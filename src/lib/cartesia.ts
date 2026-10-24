import Cartesia from "@cartesia/cartesia-js";
import { promises as fs } from "fs";
import path from "path";
import type { Voice } from "@cartesia/cartesia-js/resources/voices";

export const TTS_MODEL = "sonic-3.5";
export const STT_MODEL = "ink-whisper";

let client: Cartesia | null = null;
export function cartesia(): Cartesia {
  if (!process.env.CARTESIA_API_KEY) throw new Error("CARTESIA_API_KEY is not set in .env.local");
  return (client ??= new Cartesia({ apiKey: process.env.CARTESIA_API_KEY }));
}

export const hasCartesia = () => Boolean(process.env.CARTESIA_API_KEY);

// Voices cloned at this post (e.g. the health worker reading a sentence), keyed by locale. They
// win over the catalog and are kept in data/voices.json so they survive restarts.
const voicesFile = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "voices.json");
type Cloned = Record<string, { id: string; name: string }>;
async function readCloned(): Promise<Cloned> {
  try {
    return JSON.parse(await fs.readFile(voicesFile(), "utf8"));
  } catch {
    return {};
  }
}
export async function registerClonedVoice(locale: string, id: string, name: string) {
  const all = await readCloned();
  all[locale] = { id, name };
  await fs.mkdir(path.dirname(voicesFile()), { recursive: true });
  await fs.writeFile(voicesFile(), JSON.stringify(all, null, 2));
}
export async function forgetClonedVoice(locale: string) {
  const all = await readCloned();
  delete all[locale];
  await fs.writeFile(voicesFile(), JSON.stringify(all, null, 2));
}
export async function clonedVoice(locale: string, community?: string) {
  const all = await readCloned();
  const key = community ? `${locale}@${community.trim().toLowerCase()}` : null;
  return (key && all[key]) || all[locale] || null;
}
export const voiceKey = (locale: string, community?: string) => (community ? `${locale}@${community.trim().toLowerCase()}` : locale);

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
  // English: Cartesia has native South African, British, Indian and American voices; Zambia and
  // West Africa get the nearest, South African.
  "en-ZM": ["south-african", "british"],
  "en-NG": ["south-african", "british"],
  "en-IN": ["indian-english", "british"],
  "en-GB": ["british"],
  "en-US": ["general-american"],
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

const picksFile = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "voice-picks.json");
async function readPicks(): Promise<Record<string, PickedVoice>> {
  try {
    return JSON.parse(await fs.readFile(picksFile(), "utf8"));
  } catch {
    return {};
  }
}
async function savePick(v: PickedVoice) {
  const all = await readPicks();
  all[v.locale] = v;
  await fs.mkdir(path.dirname(picksFile()), { recursive: true });
  await fs.writeFile(picksFile(), JSON.stringify(all, null, 2));
}

// Find the voice that sounds most like the patient's region. A warm female voice by default.
export async function pickVoice(locale: string, community?: string): Promise<PickedVoice> {
  const cloned = await clonedVoice(locale, community);
  if (cloned) return { ...cloned, locale, match: cloned.name.includes("learned") ? "learned from a patient here" : "taught by a local speaker" };
  const remembered = (await readPicks())[locale];
  if (remembered) return remembered;
  const picked = await pickFromCatalog(locale);
  await savePick(picked);
  return picked;
}

async function pickFromCatalog(locale: string): Promise<PickedVoice> {

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
