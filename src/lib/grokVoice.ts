// Grok Voice API (SpaceX track): the pod speaks with text-to-speech and hears with
// speech-to-text. The nurse still chooses the words. Grok voices them in the patient's
// dialect and transcribes with that dialect's words kept, not corrected away.

import { promises as fs } from "fs";
import path from "path";

export const GROK_TTS_URL = "https://api.x.ai/v1/tts";
export const GROK_STT_URL = "https://api.x.ai/v1/stt";
export const GROK_CLONE_URL = "https://api.x.ai/v1/custom-voices";
export const GROK_STT_MODEL = "grok-voice-transcribe-2.0";
export const SAMPLE_RATE = 24000;

export const hasGrokVoice = () => Boolean(process.env.XAI_API_KEY);

function key(): string {
  const k = process.env.XAI_API_KEY;
  if (!k) throw new Error("XAI_API_KEY is not set in .env.local");
  return k;
}

// Closest Grok voice and language code for each variety the nurse already knows.
// Grok speaks Mexican and Spain Spanish, British, Indian and Australian English, and
// Egyptian / Gulf Arabic. A village without its own voice gets the nearest of those,
// and the sentence itself uses that village's words. A cloned local speaker wins over this.
type DialectVoice = { voiceId: string; name: string; language: string; match: string; accent: string };

const DIALECTS: Record<string, DialectVoice> = {
  "es-MX": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Mexican Spanish", accent: "Mexican Spanish" },
  "es-GT": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Guatemalan Spanish, Latin American voice", accent: "Guatemalan Spanish" },
  "es-HN": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Honduran Spanish, Latin American voice", accent: "Honduran Spanish" },
  "es-SV": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Salvadoran Spanish, Latin American voice", accent: "Salvadoran Spanish" },
  "es-NI": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Nicaraguan Spanish, Latin American voice", accent: "Nicaraguan Spanish" },
  "es-PA": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Panamanian Spanish, Latin American voice", accent: "Panamanian Spanish" },
  "es-CO": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Colombian Spanish, Latin American voice", accent: "Colombian Spanish" },
  "es-EC": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Ecuadorian Spanish, Latin American voice", accent: "Ecuadorian Spanish" },
  "es-PE": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Peruvian Spanish, Latin American voice", accent: "Peruvian Spanish" },
  "es-BO": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Bolivian Spanish, Latin American voice", accent: "Bolivian Spanish" },
  "es-AR": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Argentinian Spanish, Latin American voice", accent: "Argentinian Spanish" },
  "es-CL": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Chilean Spanish, Latin American voice", accent: "Chilean Spanish" },
  "es-DO": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Dominican Spanish, Latin American voice", accent: "Dominican Spanish" },
  "es-US": { voiceId: "ara", name: "Ara", language: "es-MX", match: "Latin American Spanish", accent: "Latin American Spanish" },
  "es-ES": { voiceId: "sal", name: "Sal", language: "es-ES", match: "Spain Spanish", accent: "Castilian Spanish" },
  "en-ZM": { voiceId: "eve", name: "Eve", language: "en", match: "Zambian English, nearest accent is British", accent: "Zambian English" },
  "en-NG": { voiceId: "eve", name: "Eve", language: "en", match: "Nigerian English, nearest accent is British", accent: "Nigerian English" },
  "en-IN": { voiceId: "naksh", name: "Naksh", language: "en", match: "Indian English", accent: "Indian English" },
  "en-GB": { voiceId: "eve", name: "Eve", language: "en", match: "British English", accent: "British English" },
  "en-US": { voiceId: "ara", name: "Ara", language: "en", match: "American English", accent: "American English" },
  "ar-MA": { voiceId: "ara", name: "Ara", language: "ar-EG", match: "Moroccan Darija, nearest Arabic voice is Egyptian", accent: "Moroccan Arabic" },
  "ar-EG": { voiceId: "ara", name: "Ara", language: "ar-EG", match: "Egyptian Arabic", accent: "Egyptian Arabic" },
  "ar-SA": { voiceId: "ara", name: "Ara", language: "ar-SA", match: "Saudi Arabic", accent: "Saudi Arabic" },
  "ar-AE": { voiceId: "ara", name: "Ara", language: "ar-AE", match: "Emirati Arabic", accent: "Emirati Arabic" },
  ar: { voiceId: "ara", name: "Ara", language: "ar-EG", match: "Arabic", accent: "Arabic" },
};

export function dialectVoice(locale: string): DialectVoice {
  const loc = locale || "en";
  return (
    DIALECTS[loc] ??
    DIALECTS[loc.split("-")[0]] ?? {
      voiceId: "ara",
      name: "Ara",
      language: loc.startsWith("es") ? "es-MX" : loc.startsWith("ar") ? "ar-EG" : "en",
      match: "same language",
      accent: loc,
    }
  );
}

export function ttsLanguage(locale: string): string {
  return dialectVoice(locale).language;
}

// Transcription codes. `es` leans Mexican; Spain is asked for explicitly.
export function sttLanguage(language: string): string {
  const lang = (language || "en").toLowerCase();
  if (lang === "es-es") return "es-ES";
  if (lang.startsWith("es")) return "es";
  if (lang.startsWith("en")) return "en";
  if (lang.startsWith("ar-sa")) return "ar-SA";
  if (lang.startsWith("ar-ae")) return "ar-AE";
  if (lang.startsWith("ar")) return "ar";
  if (lang.startsWith("pt")) return "pt";
  return lang.slice(0, 2);
}

// Voices taught at a post, keyed by locale or locale@village. Grok voice ids only.
const voicesFile = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "grok-voices.json");
type Cloned = Record<string, { id: string; name: string }>;
async function readCloned(): Promise<Cloned> {
  try {
    return JSON.parse(await fs.readFile(voicesFile(), "utf8"));
  } catch {
    return {};
  }
}
export async function registerClonedVoice(voiceKey: string, id: string, name: string) {
  const all = await readCloned();
  all[voiceKey] = { id, name };
  await fs.mkdir(path.dirname(voicesFile()), { recursive: true });
  await fs.writeFile(voicesFile(), JSON.stringify(all, null, 2));
}
export async function forgetClonedVoice(voiceKey: string) {
  const all = await readCloned();
  delete all[voiceKey];
  await fs.mkdir(path.dirname(voicesFile()), { recursive: true });
  await fs.writeFile(voicesFile(), JSON.stringify(all, null, 2));
}
export async function clonedVoice(locale: string, community?: string) {
  const all = await readCloned();
  const village = community ? `${locale}@${community.trim().toLowerCase()}` : null;
  return (village && all[village]) || all[locale] || null;
}
export const voiceKey = (locale: string, community?: string) => (community ? `${locale}@${community.trim().toLowerCase()}` : locale);

export type PickedVoice = { id: string; name: string; language: string; match: string };

export async function pickGrokVoice(locale: string, community?: string): Promise<PickedVoice> {
  const base = dialectVoice(locale);
  const cloned = await clonedVoice(locale, community);
  if (cloned) {
    const learned = cloned.name.toLowerCase().includes("learned");
    return { id: cloned.id, name: cloned.name, language: base.language, match: learned ? "learned from a patient in this village" : "taught by a local speaker" };
  }
  return { id: base.voiceId, name: `Grok Voice · ${base.name}`, language: base.language, match: base.match };
}

export async function grokSpeak(text: string, voice: PickedVoice, codec: "pcm" | "wav"): Promise<Response> {
  const res = await fetch(GROK_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voice.id,
      language: voice.language,
      optimize_streaming_latency: 1,
      text_normalization: true,
      output_format: { codec, sample_rate: SAMPLE_RATE },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(detail || `Grok Voice TTS failed (${res.status})`);
  }
  return res;
}

// Learn a consenting speaker's voice and keep it for this locale, or this village.
export async function cloneGrokVoice(file: File, opts: { name: string; locale: string; community?: string }): Promise<{ id: string; name: string }> {
  const dialect = dialectVoice(opts.locale);
  const body = new FormData();
  body.append("name", opts.name);
  body.append("language", dialect.language);
  body.append("accent", dialect.accent);
  body.append("gender", "female");
  body.append("tone", "warm");
  body.append("use_case", "conversational");
  body.append("file", file, file.name || "voice.wav");
  const res = await fetch(GROK_CLONE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(detail || `Grok Voice could not learn this speaker (${res.status})`);
  }
  const data = (await res.json()) as { voice_id?: string; name?: string };
  if (!data.voice_id) throw new Error("Grok Voice did not return a voice id");
  const name = data.name || opts.name;
  await registerClonedVoice(voiceKey(opts.locale, opts.community), data.voice_id, name);
  return { id: data.voice_id, name };
}

export type GrokTranscript = {
  text: string;
  words: { start: number; end: number }[];
};

export async function grokTranscribe(file: File, language: string, keyterms: string[] = []): Promise<GrokTranscript> {
  const body = new FormData();
  body.append("model", GROK_STT_MODEL);
  body.append("language", sttLanguage(language));
  for (const term of keyterms.slice(0, 100)) body.append("keyterm", term);
  body.append("file", file, file.name || "speech.wav");
  const res = await fetch(GROK_STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(detail || `Grok Voice STT failed (${res.status})`);
  }
  const data = (await res.json()) as { text?: string; words?: { start?: number; end?: number }[] };
  return {
    text: (data.text ?? "").trim(),
    words: (data.words ?? [])
      .filter((w) => typeof w.start === "number" && typeof w.end === "number")
      .map((w) => ({ start: w.start as number, end: w.end as number })),
  };
}
