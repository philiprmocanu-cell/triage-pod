// What exactly gets sent for each condition the pod is confident about. One source of truth for
// the pod (what it orders at the end of a visit), the network database (what moves between
// villages) and the government view (what each post must keep in stock).
//
// Only stock that can sit on a shelf is here. Services (transport, a doctor's review, an ECG)
// stay in the visit's resource list but are never "ordered".

export type Supply = { item: string; qty: number; note?: string };

// Stock items the network tracks. Keep this list identical to ITEMS in spacetime/spacetimedb.
export const STOCK_ITEMS = [
  "Malaria rapid test",
  "Antimalarial (ACT)",
  "Rectal artesunate",
  "Amoxicillin",
  "Ceftriaxone (pre-referral)",
  "Oral rehydration salts",
  "Zinc",
  "Paracetamol",
  "Salbutamol inhaler",
  "Oxygen cylinder",
  "Aspirin",
  "Glucose gel",
  "Wound dressing kit",
  "Tetanus vaccine",
  "IV fluids",
  "Blood (O negative)",
  "Therapeutic food (RUTF)",
] as const;
export type StockItem = (typeof STOCK_ITEMS)[number];

// Condition name (as in tree.ts subtypes / RULE_CAUSE) -> exactly what to send.
// Quantities are one treatment course for one patient.
export const SUPPLIES_FOR: Record<string, Supply[]> = {
  // Fever
  "Malaria": [
    { item: "Malaria rapid test", qty: 1 },
    { item: "Antimalarial (ACT)", qty: 1, note: "3-day course, give if the test is positive" },
  ],
  "Severe malaria": [
    { item: "Malaria rapid test", qty: 1 },
    { item: "Rectal artesunate", qty: 1, note: "pre-referral dose" },
  ],
  "Fever headache (malaria or infection)": [
    { item: "Malaria rapid test", qty: 1 },
    { item: "Paracetamol", qty: 1 },
  ],
  "Infection in pregnancy": [{ item: "Malaria rapid test", qty: 1 }],
  "Viral fever": [{ item: "Paracetamol", qty: 1 }, { item: "Malaria rapid test", qty: 1 }],
  "Dengue": [{ item: "Paracetamol", qty: 1 }, { item: "Oral rehydration salts", qty: 2 }],
  "Meningitis": [{ item: "Ceftriaxone (pre-referral)", qty: 1 }],
  // Breathing
  "Severe pneumonia": [{ item: "Oxygen cylinder", qty: 1 }, { item: "Ceftriaxone (pre-referral)", qty: 1 }],
  "Pneumonia": [{ item: "Amoxicillin", qty: 1, note: "5-day course" }],
  "Chest infection": [{ item: "Amoxicillin", qty: 1 }],
  "Asthma attack": [{ item: "Salbutamol inhaler", qty: 1 }],
  "Common cold": [{ item: "Paracetamol", qty: 1 }],
  // Heart / brain
  "Heart attack": [{ item: "Aspirin", qty: 1, note: "doctor to approve" }],
  "Low blood sugar": [{ item: "Glucose gel", qty: 1 }],
  "Migraine": [{ item: "Paracetamol", qty: 1 }],
  "Tension headache": [{ item: "Paracetamol", qty: 1 }],
  "Muscle or reflux pain": [{ item: "Paracetamol", qty: 1 }],
  "Sciatica / nerve pain": [{ item: "Paracetamol", qty: 1 }],
  "Muscle strain": [{ item: "Paracetamol", qty: 1 }],
  // Stomach
  "Severe dehydration": [{ item: "IV fluids", qty: 1 }, { item: "Oral rehydration salts", qty: 2 }],
  "Some dehydration": [{ item: "Oral rehydration salts", qty: 2 }, { item: "Zinc", qty: 1 }],
  "Diarrhea without dehydration": [{ item: "Oral rehydration salts", qty: 2 }, { item: "Zinc", qty: 1 }],
  "Dysentery": [{ item: "Oral rehydration salts", qty: 2 }, { item: "Ceftriaxone (pre-referral)", qty: 1, note: "doctor to confirm the antibiotic" }],
  // Injury / pregnancy
  "Major bleeding": [{ item: "Wound dressing kit", qty: 1 }, { item: "Blood (O negative)", qty: 1 }],
  "Bleeding in pregnancy": [{ item: "Blood (O negative)", qty: 1 }],
  "Wound needing care": [{ item: "Wound dressing kit", qty: 1 }, { item: "Tetanus vaccine", qty: 1 }],
  "Minor injury": [{ item: "Wound dressing kit", qty: 1 }],
  "Possible fracture": [{ item: "Paracetamol", qty: 1 }],
  // Nutrition
  "Severe malnutrition": [{ item: "Therapeutic food (RUTF)", qty: 7, note: "one week" }],
};

// Which conditions a stock item treats (for the government view's "why we need this").
export function treatsWith(item: string): string[] {
  return Object.entries(SUPPLIES_FOR).filter(([, s]) => s.some((x) => x.item === item)).map(([name]) => name);
}

// The exact order for a visit: one line per item, quantities added across confident conditions
// (the same item is never doubled for two overlapping conditions).
export function ordersFor(conditions: string[]): Supply[] {
  const out = new Map<string, Supply>();
  for (const name of conditions) {
    for (const s of SUPPLIES_FOR[name] ?? []) {
      const cur = out.get(s.item);
      if (!cur || cur.qty < s.qty) out.set(s.item, { ...s, note: s.note ?? cur?.note });
    }
  }
  return [...out.values()];
}

// What a fired safety rule sends on its own (rule id -> stock), even before a condition is named.
export const RULE_SUPPLIES: Record<string, Supply[]> = {
  fever_malaria_test: [{ item: "Malaria rapid test", qty: 1 }],
  child_malnutrition_oedema: [{ item: "Therapeutic food (RUTF)", qty: 7 }],
  low_oxygen: [{ item: "Oxygen cylinder", qty: 1 }],
  low_sugar: [{ item: "Glucose gel", qty: 1 }],
  severe_bleeding: [{ item: "Wound dressing kit", qty: 1 }, { item: "Blood (O negative)", qty: 1 }],
  dehydration: [{ item: "Oral rehydration salts", qty: 2 }, { item: "Zinc", qty: 1 }],
  dysentery: [{ item: "Oral rehydration salts", qty: 2 }],
  pneumonia: [{ item: "Amoxicillin", qty: 1 }],
};
