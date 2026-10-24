// What a species verdict means for a Zambian village, and what the pod should order.
//
// Honest limits: a wingbeat recording cannot say whether the insect carries Plasmodium. It can
// say which species (and, with a wider model, which sex) is flying, and in Zambia the malaria
// vectors are Anopheles females: An. arabiensis and An. gambiae s.s. (gambiae complex) and
// An. funestus s.s. are the primary vectors; An. squamosus and An. coustani have been found
// Plasmodium-positive and bite outdoors, so they count as secondary vectors. Culex, Aedes and
// Mansonia do not transmit malaria (they carry other things: filariasis, dengue, Rift Valley fever).

export type VectorRole = "primary" | "secondary" | "none";

export type OrderLine = { item: string; qty: number; why: string };

export type VectorVerdict = {
  species: string;
  genus: string;
  malariaVector: boolean;
  role: VectorRole;
  carries: string;
  orders: OrderLine[];
  note: string;
};

const SPECIES: Record<string, { role: VectorRole; carries: string; orders: OrderLine[] }> = {
  "Anopheles arabiensis": {
    role: "primary",
    carries: "Malaria (primary vector in Zambia, An. gambiae complex; bites indoors and outdoors, dusk to dawn)",
    orders: [
      { item: "Long-lasting insecticidal nets", qty: 20, why: "Anopheles bite at night; nets are the first line" },
      { item: "Indoor residual spray", qty: 1, why: "one spray round for the village's houses" },
      { item: "Malaria rapid test", qty: 25, why: "test fevers early while the vector is active" },
    ],
  },
  "Anopheles funestus s.s.": {
    role: "primary",
    carries: "Malaria (primary vector in Zambia; strongly indoor-biting, late-night)",
    orders: [
      { item: "Indoor residual spray", qty: 1, why: "An. funestus rests indoors, so spraying walls works well" },
      { item: "Long-lasting insecticidal nets", qty: 20, why: "late-night biting while people sleep" },
      { item: "Malaria rapid test", qty: 25, why: "test fevers early while the vector is active" },
    ],
  },
  "Anopheles squamosus": {
    role: "secondary",
    carries: "Malaria (secondary vector; found Plasmodium-positive in Zambia, bites outdoors)",
    orders: [
      { item: "Larvicide", qty: 2, why: "outdoor biters are reached by treating breeding water, not by spraying walls" },
      { item: "Long-lasting insecticidal nets", qty: 10, why: "still bites people sleeping outside or near doors" },
    ],
  },
  "Anopheles coustani": {
    role: "secondary",
    carries: "Malaria (secondary vector; outdoor, early-evening biter)",
    orders: [
      { item: "Larvicide", qty: 2, why: "outdoor biters are reached by treating breeding water" },
      { item: "Long-lasting insecticidal nets", qty: 10, why: "nets for anyone sleeping outdoors" },
    ],
  },
  "Culex pipiens complex": {
    role: "none",
    carries: "Not malaria. Lymphatic filariasis, West Nile; mostly a nuisance biter",
    orders: [{ item: "Larvicide", qty: 1, why: "Culex breed in pit latrines and drains; treat those" }],
  },
  "Aedes aegypti": {
    role: "none",
    carries: "Not malaria. Dengue, chikungunya, yellow fever (daytime biter)",
    orders: [{ item: "Larvicide", qty: 1, why: "Aedes breed in water containers; empty and treat them" }],
  },
  "Mansonia uniformis": {
    role: "none",
    carries: "Not malaria. Filariasis, Rift Valley fever; breeds on floating weeds",
    orders: [{ item: "Larvicide", qty: 1, why: "treat weedy ponds near the village" }],
  },
  "Mansonia africanus": {
    role: "none",
    carries: "Not malaria. Filariasis, Rift Valley fever; breeds on floating weeds",
    orders: [{ item: "Larvicide", qty: 1, why: "treat weedy ponds near the village" }],
  },
};

export function vectorVerdict(species: string, mosquito: boolean): VectorVerdict {
  const genus = species.split(" ")[0];
  const s = SPECIES[species];
  if (!mosquito || !s) {
    return {
      species,
      genus,
      malariaVector: false,
      role: "none",
      carries: mosquito ? "Unknown species" : "No mosquito heard in this clip",
      orders: [],
      note: mosquito
        ? "The Oxford model only knows eight species; this one is outside that list."
        : "Nothing to order. The detector did not hear a wingbeat in this clip.",
    };
  }
  const note =
    s.role === "none"
      ? `${species} is not a malaria vector. ${s.carries}.`
      : s.role === "primary"
        ? `${species} is a primary malaria vector in Zambia. Sound cannot tell whether this one is infected; it tells you the vector is here.`
        : `${species} is a secondary malaria vector in Zambia. Sound cannot tell whether this one is infected; it tells you the vector is here.`;
  return { species, genus, malariaVector: s.role !== "none", role: s.role, carries: s.carries, orders: s.orders, note };
}

export const KNOWN_SPECIES = Object.keys(SPECIES);
