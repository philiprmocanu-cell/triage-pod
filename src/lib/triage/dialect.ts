// The pod learns how each patient (and each community) says things, and talks back the same way.
// If a mother in Llallagua says "mi wawa tiene calentura", the next questions say "wawa", not
// "niño". Words a community uses are remembered across visits (data/dialects.json), so the pod
// starts each new visit already speaking that village's words.

import { promises as fs } from "fs";
import path from "path";

type Concept = { default: string; variants: string[] };

// Default word = what the question bank uses. Variants are regional words for the same thing.
export const CONCEPTS: Record<string, Concept> = {
  child: { default: "niño", variants: ["patojo", "wawa", "guagua", "chamaco", "chamaquito", "cipote", "bicho", "chavalo", "chibolo", "pelado", "crío", "nene", "güirro", "chiquito"] },
  fever: { default: "calentura", variants: ["fiebre", "calentura", "temperatura"] },
  poop: { default: "popó", variants: ["caca", "popó", "pupú", "heces"] },
  belly: { default: "panza", variants: ["barriga", "panza", "pancita", "guata", "estómago", "tripa"] },
  now: { default: "ahorita", variants: ["ahorita", "ahora", "ahoritita"] },
  talk: { default: "platicar", variants: ["platicar", "conversar", "hablar", "charlar"] },
  dizzy: { default: "mareado", variants: ["mareado", "mareada", "atarantado", "zonzo"] },
  // English, the way it is spoken in Zambia, Nigeria, India and Britain.
  diarrhea_en: { default: "diarrhea", variants: ["running stomach", "runny stomach", "loose motions", "stooling", "purging", "runny tummy", "the runs"] },
  fever_en: { default: "fever", variants: ["temperature", "hot body", "high temperature", "fever"] },
  belly_en: { default: "belly", variants: ["tummy", "stomach", "belly"] },
  child_en: { default: "child", variants: ["kid", "baby", "little one", "pikin", "small one", "child"] },
  dizzy_en: { default: "dizzy", variants: ["giddy", "light-headed", "dizzy"] },
  hurts_en: { default: "hurt", variants: ["paining", "pains", "hurt"] },
};

export type Lexicon = Partial<Record<string, string>>; // concept -> the patient's own word

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Which regional words did the patient use?
export function learnFrom(texts: string[]): Lexicon {
  const lex: Lexicon = {};
  const words = new Set(texts.flatMap((t) => norm(t).split(/[^a-zñ]+/)));
  for (const [concept, c] of Object.entries(CONCEPTS)) {
    const used = c.variants.find((v) => words.has(norm(v)));
    if (used) lex[concept] = used;
  }
  return lex;
}

// Say the next question with the patient's words instead of the defaults.
export function speakLike(text: string, lex: Lexicon): string {
  let out = text;
  for (const [concept, word] of Object.entries(lex)) {
    const d = CONCEPTS[concept]?.default;
    if (!d || !word || word === d) continue;
    if (concept === "child" && ["wawa", "guagua"].includes(word)) {
      // feminine in Andean Spanish: "la wawa", "a la wawa"
      out = out.replace(/\bal niño\b/gi, `a la ${word}`).replace(/\bel niño\b/gi, `la ${word}`);
    }
    out = out.replace(new RegExp(`\\b${d}\\b`, "gi"), (m) => (m[0] === m[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word));
    // plural/diminutive forms of the default ("niños", "niñito")
    out = out.replace(new RegExp(`\\b${d}s\\b`, "gi"), `${word}s`);
  }
  return out;
}

// ---- Community memory ----

const file = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "dialects.json");
type Memory = Record<string, Record<string, Record<string, number>>>; // community -> concept -> word -> times heard

async function readMemory(): Promise<Memory> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8"));
  } catch {
    return {};
  }
}

const key = (community: string) => norm(community).replace(/^(vengo de|soy de|de la|del|de)\s+/, "").trim();

// The words this community uses most, learned from earlier visits.
export async function communityLexicon(community: string | undefined): Promise<Lexicon> {
  if (!community) return {};
  const mem = (await readMemory())[key(community)] ?? {};
  const lex: Lexicon = {};
  for (const [concept, counts] of Object.entries(mem)) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) lex[concept] = top[0];
  }
  return lex;
}

// Words the listener should expect, so a village word is not "corrected" into the standard one.
// A full locale ("es-GT") adds that variety's markers. A bare language ("es") adds every variety.
const MARKERS: Record<string, string[]> = {
  "es-MX": ["ahorita", "chamaco", "mande", "calentura", "popó"],
  "es-GT": ["patojo", "chilero", "cabal", "vos", "calentura"],
  "es-HN": ["cipote", "catracho", "vos", "pisto"],
  "es-SV": ["bicho", "cipote", "vos", "chivo"],
  "es-NI": ["chavalo", "vos", "tuani"],
  "es-CO": ["parce", "qué más"],
  "es-PE": ["pata", "chibolo", "ya"],
  "es-BO": ["wawa", "no ve"],
  "es-EC": ["guagua", "chuta", "ya", "mande"],
  "es-ES": ["vosotros", "vale", "tío"],
  "en-ZM": ["running stomach", "now now", "is it"],
  "en-NG": ["body is hot", "stooling", "purging", "catarrh", "pikin", "abi"],
  "en-IN": ["loose motions", "paining", "giddiness"],
  "en-GB": ["poorly", "tummy bug", "I feel rough"],
  "ar-MA": ["wakha", "bzaf", "daba", "safi", "labas", "mashi mushkil", "kayn"],
};

export function dialectKeyterms(locale: string, lex: Lexicon = {}): string[] {
  const loc = locale || "en";
  const lang = loc.split("-")[0];
  const concepts = Object.entries(CONCEPTS).filter(([k]) => (lang === "en" ? k.endsWith("_en") : lang === "es" ? !k.includes("_") : false));
  const markers = MARKERS[loc] ?? Object.entries(MARKERS).filter(([k]) => k.startsWith(`${lang}-`)).flatMap(([, words]) => words);
  const learned = Object.values(lex).filter((w): w is string => Boolean(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...learned, ...markers, ...concepts.flatMap(([, c]) => c.variants)]) {
    const term = raw.trim();
    const id = norm(term);
    if (!term || term.length > 50 || seen.has(id)) continue;
    seen.add(id);
    out.push(term);
    if (out.length >= 100) break;
  }
  return out;
}

export async function rememberWords(community: string | null | undefined, lex: Lexicon) {
  if (!community || !Object.keys(lex).length) return;
  const mem = await readMemory();
  const c = (mem[key(community)] ??= {});
  for (const [concept, word] of Object.entries(lex)) {
    if (!word) continue;
    c[concept] ??= {};
    c[concept][word] = (c[concept][word] ?? 0) + 1;
  }
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(mem, null, 2));
}
