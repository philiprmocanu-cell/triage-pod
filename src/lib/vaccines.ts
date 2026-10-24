// Zambia's routine immunisation schedule, simplified, for the profiles page and the staff screen.
// Keep identical to SCHEDULE in spacetime/spacetimedb/src/index.ts (the planner agent uses that copy).

export type Dose = { code: string; label: string; months: number; item: string; who?: "girl" | "pregnant" };

export const SCHEDULE: Dose[] = [
  { code: "BCG", label: "BCG", months: 0, item: "BCG vaccine" },
  { code: "OPV0", label: "Polio 0", months: 0, item: "Polio vaccine (OPV)" },
  { code: "OPV1", label: "Polio 1", months: 1.5, item: "Polio vaccine (OPV)" },
  { code: "PENTA1", label: "Pentavalent 1", months: 1.5, item: "Pentavalent vaccine" },
  { code: "PCV1", label: "PCV 1", months: 1.5, item: "PCV vaccine" },
  { code: "ROTA1", label: "Rotavirus 1", months: 1.5, item: "Rotavirus vaccine" },
  { code: "OPV2", label: "Polio 2", months: 2.5, item: "Polio vaccine (OPV)" },
  { code: "PENTA2", label: "Pentavalent 2", months: 2.5, item: "Pentavalent vaccine" },
  { code: "PCV2", label: "PCV 2", months: 2.5, item: "PCV vaccine" },
  { code: "ROTA2", label: "Rotavirus 2", months: 2.5, item: "Rotavirus vaccine" },
  { code: "OPV3", label: "Polio 3", months: 3.5, item: "Polio vaccine (OPV)" },
  { code: "PENTA3", label: "Pentavalent 3", months: 3.5, item: "Pentavalent vaccine" },
  { code: "PCV3", label: "PCV 3", months: 3.5, item: "PCV vaccine" },
  { code: "R21-1", label: "Malaria (R21) 1", months: 5, item: "Malaria vaccine (R21)" },
  { code: "R21-2", label: "Malaria (R21) 2", months: 6, item: "Malaria vaccine (R21)" },
  { code: "R21-3", label: "Malaria (R21) 3", months: 7, item: "Malaria vaccine (R21)" },
  { code: "MR1", label: "Measles-rubella 1", months: 9, item: "Measles-rubella vaccine" },
  { code: "MR2", label: "Measles-rubella 2", months: 18, item: "Measles-rubella vaccine" },
  { code: "R21-4", label: "Malaria (R21) booster", months: 18, item: "Malaria vaccine (R21)" },
  { code: "HPV", label: "HPV (girls, 14 y)", months: 168, item: "HPV vaccine", who: "girl" },
  { code: "TT1", label: "Tetanus (pregnancy) 1", months: 0, item: "Tetanus vaccine", who: "pregnant" },
  { code: "TT2", label: "Tetanus (pregnancy) 2", months: 0, item: "Tetanus vaccine", who: "pregnant" },
];

export type Profile = { ageMonths: number; sex: string; pregnant: boolean; vaccinesGiven: string };

export function dueFor(p: Profile): Dose[] {
  const given = new Set(p.vaccinesGiven.split(",").map((s) => s.trim()).filter(Boolean));
  return SCHEDULE.filter((d) => {
    if (given.has(d.code)) return false;
    if (d.who === "pregnant") return p.pregnant;
    if (d.who === "girl") return p.sex === "f" && p.ageMonths >= d.months && p.ageMonths < 180;
    return p.ageMonths >= d.months && p.ageMonths < 60; // routine childhood doses only
  });
}

// Doses are given one at a time per vaccine (four weeks apart): the earliest due dose of each.
export function nextDoses(due: Dose[]): Dose[] {
  const seen = new Set<string>();
  return due.filter((d) => (seen.has(d.item) ? false : (seen.add(d.item), true)));
}

// The next dose coming up (not due yet), so a profile can say "Measles-rubella 2 at 18 months".
export function nextFor(p: Profile): Dose | null {
  const given = new Set(p.vaccinesGiven.split(",").filter(Boolean));
  if (p.ageMonths >= 60) return null;
  return SCHEDULE.filter((d) => !d.who && !given.has(d.code) && d.months > p.ageMonths).sort((a, b) => a.months - b.months)[0] ?? null;
}

export function ageText(months: number): string {
  if (months < 24) return `${months} month${months === 1 ? "" : "s"}`;
  return `${Math.floor(months / 12)} years`;
}
