// The pod learns how each patient (and each community) says things, and talks back the same way.
// If a mother in Llallagua says "mi wawa tiene calentura", the next questions say "wawa", not
// "niño". Words a community uses are remembered across visits (data/dialects.json), so the pod
// starts each new visit already speaking that village's words.

import { promises as fs } from "fs";
import path from "path";
import { communityLexiconLive } from "../spacetime";

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

// ---- Which variety is this? ----
// Nothing is assumed from the region: the pod starts neutral and decides from the words it
// actually hears. Each variety lists the everyday words and turns of phrase that give it away;
// the one with the most hits wins, and the hits are shown on screen so the audience can see why.

export type Dialect = { locale: string; language: string; name: string; markers: string[] };

type Variety = { locale: string; language: string; name: string; markers: string[]; weak?: boolean };

const DIALECTS: Variety[] = [
  // Arabic. Darija (Morocco) is far from the Arabic of the east; these words are Darija only.
  { locale: "ar-MA", language: "ar", name: "Moroccan Arabic (Darija)", markers: ["واش", "بزاف", "بزّاف", "شنو", "دابا", "كيداير", "كيدايرة", "كرشي", "وخا", "صافي", "لاباس", "ماشي", "كاين", "كاينة", "غادي", "بغيت", "كنحس", "كيضرني", "كتضرني", "راسي", "بلاصة", "شحال", "علاش", "حيت", "زعما", "دغيا", "عافاك", "ديالي", "ديال", "وليدي", "ولدي", "كيوجعني", "كتوجعني", "عندي"] },
  { locale: "ar", language: "ar", name: "Egyptian Arabic", markers: ["إزيك", "ازيك", "عايز", "عايزة", "كده", "كدة", "دلوقتي", "دلوقت", "مش", "بتوجعني", "بيوجعني", "إيه", "ايه", "أوي", "اوي", "خالص", "عشان", "النهارده", "امبارح"] },
  { locale: "ar", language: "ar", name: "Levantine Arabic", markers: ["شو", "كيفك", "هلق", "هلأ", "بدي", "بدّي", "ليش", "كتير", "منيح", "منيحة", "هيك", "لسا", "لسّا", "بعرف", "ما بعرف", "عم"] },
  { locale: "ar", language: "ar", name: "Gulf Arabic", markers: ["شلونك", "شلونج", "وش", "زين", "الحين", "أبي", "ابي", "أبغى", "ابغى", "وايد", "مب", "هني", "يوجعني", "تعبان"] },
  // Standard Arabic words turn up in every dialect, so they only count when nothing else does.
  { locale: "ar", language: "ar", name: "Standard Arabic", weak: true, markers: ["كيف حالك", "ماذا", "لماذا", "الآن", "أريد", "أشعر", "لدي", "لديّ", "يؤلمني", "منذ", "هل", "ليس", "جداً", "جدا"] },
  // English, by the words people use for everyday things (the lexicon above knows the same ones).
  { locale: "en-ZM", language: "en", name: "Zambian English", markers: ["running stomach", "runny stomach", "me i am", "me i have", "me i", "is it?", "now now", "just now", "bp", "my body is", "the body is", "shivering", "ehe", "imwe", "nkhongo", "mutu", "kuzizima", "malungo"] },
  { locale: "en-NG", language: "en", name: "Nigerian English", markers: ["body is hot", "body hot", "stooling", "purging", "catarrh", "pikin", "abi", "wahala", "abeg", "oga", "dey", "small small", "waist pain", "body dey pain", "na so"] },
  { locale: "en-IN", language: "en", name: "Indian English", markers: ["loose motions", "motions", "paining", "giddiness", "giddy", "prepone", "doing the needful", "since morning", "since two days", "since three days", "gas trouble", "acidity", "vomitings", "fever is there", "pain is there", "loose motion"] },
  { locale: "en-GB", language: "en", name: "British English", markers: ["poorly", "tummy bug", "gp", "feel rough", "feeling rough", "mum", "bloody", "fortnight", "chemist", "the surgery", "knackered", "whilst", "been sick", "a&e"] },
  { locale: "en-US", language: "en", name: "American English", weak: true, markers: ["mom", "diaper", "gotten", "stomach flu", "the er", "urgent care", "pediatrician", "kinda", "sorta", "gonna", "threw up", "throwing up", "tylenol", "advil"] },
  // Spanish varieties (the same words the triage brain is asked about).
  { locale: "es-MX", language: "es", name: "Mexican Spanish", markers: ["ahorita", "chamaco", "chamaca", "chamaquito", "mande", "¿mande?", "popó", "escuincle", "güey", "chido", "nomás", "órale", "ándale"] },
  { locale: "es-GT", language: "es", name: "Guatemalan Spanish", markers: ["patojo", "patoja", "chilero", "cabal", "vos", "calentura", "pisto", "chucho", "canche", "shuco", "ishto", "colocho"] },
  { locale: "es-HN", language: "es", name: "Honduran Spanish", markers: ["cipote", "cipota", "catracho", "catracha", "pisto", "vos", "macizo", "chele", "güirro"] },
  { locale: "es-SV", language: "es", name: "Salvadoran Spanish", markers: ["bicho", "bicha", "cipote", "cipota", "vos", "chivo", "chivísimo", "puya", "bolado", "guanaco", "cabal"] },
  { locale: "es-NI", language: "es", name: "Nicaraguan Spanish", markers: ["chavalo", "chavala", "vos", "tuani", "maje", "chigüín", "pinolero", "chunche", "idiay"] },
  { locale: "es-CO", language: "es", name: "Colombian Spanish", markers: ["parce", "parcero", "¿qué más?", "qué más", "chévere", "bacano", "guayabo", "a la orden", "sumercé", "pelao", "berraco"] },
  { locale: "es-PE", language: "es", name: "Peruvian Spanish", markers: ["chibolo", "chibola", "¿ya?", "al toque", "chamba", "jato", "bacán", "pe"] },
  { locale: "es-BO", language: "es", name: "Bolivian Spanish", markers: ["wawa", "wawita", "¿no ve?", "no ve", "elay", "pucha", "yapa", "chango", "changa", "camba", "colla"] },
  { locale: "es-EC", language: "es", name: "Ecuadorian Spanish", markers: ["guagua", "guaguita", "chuta", "¿ya?", "mande", "ñaño", "ñaña", "guambra", "aniñado"] },
  { locale: "es-ES", language: "es", name: "Spain Spanish", markers: ["vosotros", "vale", "tío", "tía", "mola", "guay", "hostia", "ordenador", "coche", "zumo", "venga", "móvil"] },
];

// A short human name for a variety, for the screen ("Heard Moroccan Arabic (Darija)").
export function dialectName(locale: string): string {
  if (locale === "ar") return "Arabic (standard)";
  if (locale === "es-US") return "neutral Latin American Spanish";
  return DIALECTS.find((d) => d.locale === locale)?.name ?? (locale.startsWith("es") ? "Spanish" : locale.startsWith("en") ? "English" : locale);
}

// Everyone starts in this voice until the words say otherwise: the plain, unaccented variety.
export function neutralLocale(language: string): string {
  return language === "es" ? "es-US" : language === "ar" ? "ar" : language === "en" ? "en-US" : language;
}

// Which variety did these words come from? Returns null when nothing in them gives it away.
// `language` limits the search to that language's varieties (the transcript it came from).
export function detectDialect(texts: string[], language?: string): Dialect | null {
  // Punctuation becomes spaces so "بزاف،" and "wawa." still match whole words.
  const text = ` ${texts.map((t) => norm(t).replace(/[\u064B-\u0652]/g, "").replace(/[,.;:!؟،?¿"]/g, " ")).join(" ").replace(/\s+/g, " ")} `;
  let best: (Dialect & { score: number }) | null = null;
  for (const d of DIALECTS) {
    if (language && d.language !== language) continue;
    // Whole words only: "pe" must not match inside "pero". Arabic has no \b, so spaces do the job.
    const markers = d.markers.filter((m) => text.includes(` ${norm(m).replace(/[?¿]/g, "")} `));
    // Standard/neutral words only win alone, and never on one word: a garbled transcript of some
    // other language (speech-to-text guessing Arabic from English audio) can hit one by chance.
    const score = d.weak ? (markers.length >= 2 ? markers.length * 0.5 : 0) : markers.length;
    if (score > 0 && (!best || score > best.score)) best = { locale: d.locale, language: d.language, name: d.name, markers, score };
  }
  return best && { locale: best.locale, language: best.language, name: best.name, markers: best.markers };
}

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

// The words this community uses most, learned from earlier visits: this machine's file, plus what
// every other pod in the network heard for the same community (SpacetimeDB). A word learned at
// one pod is spoken at all of them; the network's word wins when the two disagree.
export async function communityLexicon(community: string | undefined): Promise<Lexicon> {
  if (!community) return {};
  const mem = (await readMemory())[key(community)] ?? {};
  const lex: Lexicon = {};
  for (const [concept, counts] of Object.entries(mem)) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) lex[concept] = top[0];
  }
  try {
    const shared = await communityLexiconLive(community);
    for (const [concept, word] of Object.entries(shared)) if (word) lex[concept] = word;
  } catch {
    /* network down: this pod's own memory carries on */
  }
  return lex;
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
