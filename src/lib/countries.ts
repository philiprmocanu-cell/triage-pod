// Where pods could go first: candidate countries with live World Bank statistics, which
// languages the pod can already speak there, and a transparent estimate of the impact.

export type Country = {
  iso3: string;
  name: string;
  region: "Latin America" | "Caribbean" | "Africa";
  official: string; // language the pod can speak today (Cartesia)
  local: string; // languages many rural patients speak, which the pod cannot yet
  podLanguage: "es" | "fr" | "pt" | "en";
  partners: { name: string; what: string; url: string }[]; // filled from research; verify before contacting
};

export const COUNTRIES: Country[] = [
  { iso3: "ZMB", name: "Zambia", region: "Africa", official: "English", local: "Chewa/Nyanja, Bemba, Tonga, Lozi", podLanguage: "en", partners: [
    { name: "Zambia Medicines and Medical Supplies Agency (ZAMMSA)", what: "National medical stores; the hub-to-post distribution gap the pod network is built around.", url: "https://www.zammsa.co.zm" },
    { name: "Zipline Zambia", what: "Drone delivery of medicines and vaccines already flying from Zambian distribution centres.", url: "https://www.flyzipline.com" },
    { name: "Eastern Provincial Health Office (Chipata)", what: "Owns the posts in the demo; the government view is written for this office.", url: "https://www.moh.gov.zm" },
  ] },
  { iso3: "GTM", name: "Guatemala", region: "Latin America", official: "Spanish", local: "Q'eqchi', K'iche', Kaqchikel, Mam", podLanguage: "es", partners: [
    { name: "TulaSalud", what: "Cobán-based NGO working with the Ministry of Health in Alta Verapaz; phone-equipped community health workers (Kawok app). Best first pilot partner.", url: "https://tula.org/contact" },
    { name: "Wuqu' Kawoq / Maya Health Alliance", what: "Tecpán; care in Mayan languages; ran an mHealth trial; has its own US-registered ethics board (IRB).", url: "https://mayahealth.org" },
    { name: "PIES de Occidente", what: "Quetzaltenango; community health systems for Indigenous communities since 1994.", url: "https://piesdeoccidente.org.gt/document/direccion-y-telefonos/" },
    { name: "Curamericas Guatemala", what: "Huehuetenango; community health facilitators and birthing homes, strong evaluation record.", url: "https://www.curamericas.org" },
  ] },
  { iso3: "HND", name: "Honduras", region: "Latin America", official: "Spanish", local: "Garifuna, Miskito (small)", podLanguage: "es", partners: [] },
  { iso3: "NIC", name: "Nicaragua", region: "Latin America", official: "Spanish", local: "Miskito (Caribbean coast)", podLanguage: "es", partners: [] },
  { iso3: "BOL", name: "Bolivia", region: "Latin America", official: "Spanish", local: "Quechua, Aymara, Guaraní", podLanguage: "es", partners: [] },
  { iso3: "PER", name: "Peru", region: "Latin America", official: "Spanish", local: "Quechua, Aymara", podLanguage: "es", partners: [] },
  { iso3: "HTI", name: "Haiti", region: "Caribbean", official: "French", local: "Haitian Creole", podLanguage: "fr", partners: [] },
  { iso3: "MOZ", name: "Mozambique", region: "Africa", official: "Portuguese", local: "Makhuwa, Changana, Sena", podLanguage: "pt", partners: [{ name: "Malaria Consortium (upSCALE)", what: "Built the national health-worker app with the Ministry of Health and Dimagi; ~7,300 workers trained.", url: "https://www.malariaconsortium.org/upscale/" }] },
  { iso3: "AGO", name: "Angola", region: "Africa", official: "Portuguese", local: "Umbundu, Kimbundu", podLanguage: "pt", partners: [] },
  { iso3: "GNB", name: "Guinea-Bissau", region: "Africa", official: "Portuguese", local: "Kriol, Balanta, Fula", podLanguage: "pt", partners: [] },
  { iso3: "SLE", name: "Sierra Leone", region: "Africa", official: "English", local: "Krio, Mende, Temne", podLanguage: "en", partners: [
    { name: "Partners In Health Sierra Leone", what: "Digital health-worker tools (CommCare) in Kono since 2015.", url: "https://www.pih.org/country/sierra-leone" },
    { name: "Last Mile Health", what: "Built the digital supervision tool now used nationally.", url: "https://lastmilehealth.org" },
  ] },
  { iso3: "MWI", name: "Malawi", region: "Africa", official: "English", local: "Chichewa", podLanguage: "en", partners: [] },
  { iso3: "UGA", name: "Uganda", region: "Africa", official: "English", local: "Luganda, Runyankole and others", podLanguage: "en", partners: [] },
  { iso3: "LBR", name: "Liberia", region: "Africa", official: "English", local: "Liberian English, Kpelle", podLanguage: "en", partners: [{ name: "Last Mile Health", what: "National community health worker program partner in Liberia.", url: "https://lastmilehealth.org" }] },
  { iso3: "NER", name: "Niger", region: "Africa", official: "French", local: "Hausa, Zarma", podLanguage: "fr", partners: [] },
  { iso3: "TCD", name: "Chad", region: "Africa", official: "French", local: "Chadian Arabic, Sara", podLanguage: "fr", partners: [] },
  { iso3: "MLI", name: "Mali", region: "Africa", official: "French", local: "Bambara", podLanguage: "fr", partners: [{ name: "Muso", what: "Co-leads DISC-Mali, digitising 25,000+ community health workers.", url: "https://www.musohealth.org" }] },
  { iso3: "COD", name: "DR Congo", region: "Africa", official: "French", local: "Lingala, Swahili, Kikongo, Tshiluba", podLanguage: "fr", partners: [] },
  { iso3: "MDG", name: "Madagascar", region: "Africa", official: "French", local: "Malagasy", podLanguage: "fr", partners: [] },
];

export const INDICATORS = {
  population: "SP.POP.TOTL",
  ruralPct: "SP.RUR.TOTL.ZS",
  u5mr: "SH.DYN.MORT", // under-5 deaths per 1,000 live births
  birthRate: "SP.DYN.CBRT.IN", // births per 1,000 people per year
  doctors: "SH.MED.PHYS.ZS", // physicians per 1,000 people
  malaria: "SH.MLR.INCD.P3", // malaria cases per 1,000 people at risk
} as const;
export type Indicator = keyof typeof INDICATORS;

export type CountryStats = Partial<Record<Indicator, { value: number; year: string }>>;

let cache: { at: number; data: Record<string, CountryStats> } | null = null;

// Most recent value of each indicator for every candidate country, straight from the World Bank.
export async function liveStats(): Promise<Record<string, CountryStats>> {
  if (cache && Date.now() - cache.at < 12 * 3600_000) return cache.data;
  const codes = COUNTRIES.map((c) => c.iso3).join(";");
  const data: Record<string, CountryStats> = Object.fromEntries(COUNTRIES.map((c) => [c.iso3, {}]));
  await Promise.all(
    (Object.entries(INDICATORS) as [Indicator, string][]).map(async ([key, code]) => {
      const res = await fetch(`https://api.worldbank.org/v2/country/${codes}/indicator/${code}?format=json&mrnev=1&per_page=200`);
      const json = await res.json();
      for (const row of json?.[1] ?? []) {
        if (row.value != null && data[row.countryiso3code]) data[row.countryiso3code][key] = { value: row.value, year: row.date };
      }
    }),
  );
  cache = { at: Date.now(), data };
  return data;
}
