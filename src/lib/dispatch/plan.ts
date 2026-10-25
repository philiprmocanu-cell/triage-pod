// The dispatch brain: a deterministic planner for the Chipata distribution centre. No model is in
// the loop for any decision; Claude only words the explanation afterwards (explain.ts).
//
// Inputs (state.ts gathers them from SpacetimeDB and the weather routes): every post's shelf
// against what it must hold, what is already on its way, open visits and unmet needs, the
// malaria outlook six weeks out, the flood and cut-off risk and how many days the roads have
// left, who is due a vaccine, and the carriers the province actually has.
//
// Output: a ranked list of shipments, one per post and priority tier, each with the items, the
// carrier, a send-by date and plain reasons. The rules, in order:
//   (a) EMERGENCY: a red visit open at the post, or a life-saving item at zero (rectal artesunate,
//       ceftriaxone, ORS, ACT) -> send now, fastest carrier that can carry it.
//   (b) PRE-POSITION: the roads may close within CUT_OFF_HORIZON_DAYS and the demand expected
//       over the closure (malaria outlook x population) is more than the shelf holds -> send it
//       before the roads close, by the cheapest carrier that gets there in time.
//   (b2) PRE-POSITION (SEASONAL): the ten-year calendar says this post's road usually closes
//       within SEASON_HORIZON_DAYS -> stock for the whole usual closure window (and the malaria
//       peak when it falls inside it), leaving SEASON_LEAD_DAYS before the closure usually starts.
//   (c) OUTBREAK OUTLOOK: a high (or medium) malaria outlook raises the RDT / ACT / artesunate /
//       R21 targets for that post, so routine top-ups are bigger there.
//   (d) ROUTINE: top up to the (raised) minimum, batched into one truck or pickup run per area.
//   (e) Oxygen, IV fluids and blood never fly; weights come from ITEM_KG; a carrier is only
//       picked when the load fits.
// Every number here is the same one the SpacetimeDB module and the government view use.

export type PriorityTier = "emergency" | "urgent" | "pre-position" | "pre-position-seasonal" | "routine";
export type CarrierKind = "truck" | "pickup" | "motorbike" | "bicycle" | "boat" | "drone";

// The seasonal calendar for a post (GET /api/weather/seasons, from ten years of ERA5 rain):
// when the rains usually start and end, the weeks that usually close the road, how many days a
// month the post is usually cut off, and the malaria peak that follows the rain by 4–8 weeks.
export type PostSeason = {
  wetSeasonStart: string; // ISO dates in the current or coming season
  wetSeasonEnd: string;
  closureStart: string | null; // first typical closure week
  closureEnd: string | null; // last typical closure week's end
  closureWeeks: { from: string; to: string; frequency: number }[];
  cutOffDaysByMonth: number[]; // index 0 = January
  cutOffDaysInSeason: number;
  malariaPeak: { from: string; to: string };
  confidence: "high" | "medium" | "low";
};

export type Carrier = {
  id: number;
  name: string;
  kind: CarrierKind | string;
  operator: string;
  baseVillageId: number;
  capacityKg: number;
  speedKmh: number;
  costPerKm: number;
  status: string; // idle | out | down | proposed
};

export type PostOutlook = {
  malariaOutlook6w: "low" | "medium" | "high";
  floodRiskToday: boolean;
  floodRisk14d: boolean;
  floodTodayLevel: "low" | "medium" | "high";
  flood14dLevel: "low" | "medium" | "high";
  rainNext14Mm: number;
  cutOffRisk: number; // 0..1
  daysUntilCutOff: number | null; // null = no closure expected inside the horizon
  cutOffNow: boolean; // roads are closed right now
  cutOffReason?: string; // the weather route's sentence, when it gave one
  cutOffDate: string | null;
  source: "outlook" | "satellite" | "none";
  season?: PostSeason | null;
};

export type PostState = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  population: number;
  hub: boolean;
  stock: Record<string, number>;
  incoming: Record<string, number>; // undelivered restocks to this post
  redVisitsOpen: number; // red visits in the open window
  openNeeds: { item: string; qty: number }[]; // patient orders not yet delivered, summed per item
  vaccinesDue: Record<string, number>; // item -> doses due on the register
  outlook: PostOutlook;
};

export type Shipment = {
  id: string; // `${priority}-${villageId}`, stable between plan and execute
  rank: number;
  toVillageId: number;
  toVillage: string;
  fromVillageId: number;
  fromVillage: string;
  items: { item: string; qty: number; from?: string; fromVillageId?: number; why: string }[];
  kg: number;
  km: number;
  carrierKind: CarrierKind | "none";
  carrierName: string;
  carrierId: number | null;
  etaMinutes: number | null;
  priority: PriorityTier;
  sendBy: string; // ISO date
  why: string[];
  run: string | null; // the batched run this shipment rides on (routine and pre-position)
  droneAlternative: string | null; // what a proposed drone partner would do, when it would be faster
  score: number;
};

export type Run = { id: string; label: string; carrierKind: CarrierKind | "none"; carrierName: string; carrierId: number | null; posts: string[]; kg: number; km: number; minutes: number };

export type DispatchPlan = {
  plannedAt: string;
  shipments: Shipment[];
  runs: Run[];
  emergency: { active: boolean; reasons: string[]; cutOffPosts: string[]; redVisitPosts: string[] };
  posts: {
    villageId: number; name: string; cutOffRisk: number; daysUntilCutOff: number | null; cutOffDate: string | null; cutOffReason: string | null; cutOffNow: boolean;
    malariaOutlook6w: "low" | "medium" | "high"; floodRiskToday: boolean; floodTodayLevel: "low" | "medium" | "high"; flood14dLevel: "low" | "medium" | "high"; rainNext14Mm: number; redVisitsOpen: number; outlookSource: PostOutlook["source"];
    // The season calendar strip: the wet season, the closure weeks, when the seasonal shipment must leave.
    season: (PostSeason & { sendBy: string | null; daysUntilClosure: number | null; inWindow: boolean }) | null;
  }[];
  counts: Record<PriorityTier, number> & { items: number; kg: number; posts: number };
  seasonSource: string;
  notes: string[]; // what could not be done (nothing in the province, no carrier can reach)
  weatherSource: string;
  carrierSource: "table" | "fallback";
};

// ---- Constants, mirrored from spacetime/spacetimedb/src/index.ts ----

// What every post should always hold (one patient's worth is 1). Keep identical to MIN_STOCK there.
export const MIN_STOCK: Record<string, number> = {
  "Malaria rapid test": 6, "Antimalarial (ACT)": 4, "Rectal artesunate": 2, Amoxicillin: 4, "Ceftriaxone (pre-referral)": 2,
  "Oral rehydration salts": 6, Zinc: 4, Paracetamol: 6, "Salbutamol inhaler": 1, Aspirin: 2, "Glucose gel": 2,
  "Wound dressing kit": 3, "Tetanus vaccine": 2, "Therapeutic food (RUTF)": 7, Splint: 2,
  "Malaria vaccine (R21)": 4, "Measles-rubella vaccine": 4, "Pentavalent vaccine": 4, "PCV vaccine": 4, "Rotavirus vaccine": 3, "Polio vaccine (OPV)": 4, "BCG vaccine": 2, "HPV vaccine": 2,
};
export const HUB_ONLY = new Set(["Oxygen cylinder", "IV fluids", "Blood (O negative)"]); // posts don't keep these
export const HEAVY = new Set(["Oxygen cylinder", "IV fluids"]); // by road, not drone
export const LIFE_SAVING = ["Rectal artesunate", "Ceftriaxone (pre-referral)", "Oral rehydration salts", "Antimalarial (ACT)"];
export const MALARIA_ITEMS = new Set(["Malaria rapid test", "Antimalarial (ACT)", "Rectal artesunate", "Malaria vaccine (R21)"]);
export const VACCINE_ITEMS = new Set(["Malaria vaccine (R21)", "Measles-rubella vaccine", "Pentavalent vaccine", "PCV vaccine", "Rotavirus vaccine", "Polio vaccine (OPV)", "BCG vaccine", "HPV vaccine", "Tetanus vaccine"]);

// Weight of one unit (one patient's course or one dose, packed), kg. Oxygen is a D-size cylinder.
export const ITEM_KG: Record<string, number> = {
  "Malaria rapid test": 0.02, "Antimalarial (ACT)": 0.04, "Rectal artesunate": 0.05, Amoxicillin: 0.06, "Ceftriaxone (pre-referral)": 0.08,
  "Oral rehydration salts": 0.03, Zinc: 0.01, Paracetamol: 0.02, "Salbutamol inhaler": 0.1, "Oxygen cylinder": 18, Aspirin: 0.01, "Glucose gel": 0.05,
  "Wound dressing kit": 0.3, "Tetanus vaccine": 0.05, "IV fluids": 1.1, "Blood (O negative)": 0.5, "Therapeutic food (RUTF)": 0.5, Splint: 0.4,
  "Malaria vaccine (R21)": 0.05, "Measles-rubella vaccine": 0.05, "Pentavalent vaccine": 0.05, "PCV vaccine": 0.05, "Rotavirus vaccine": 0.05, "Polio vaccine (OPV)": 0.05, "BCG vaccine": 0.05, "HPV vaccine": 0.05,
};
const COLD_CHAIN_KG = 2.5; // one vaccine carrier with ice packs, added once when any vaccine ships

// How far ahead the planner looks for a road closure, and how long a closure lasts once the
// Luangwa or a seasonal stream is over the road (weeks, from the district offices' experience).
export const CUT_OFF_HORIZON_DAYS = 14;
export const CLOSURE_WEEKS = 3;
// Seasonal pre-positioning (rule b2): a post whose typical closure weeks begin within this many
// days gets its stock before the roads usually close; the shipment leaves a week ahead.
export const SEASON_HORIZON_DAYS = 42;
export const SEASON_LEAD_DAYS = 7;
export const SEASON_MIN_WEEKS = 3, SEASON_MAX_WEEKS = 8; // how long a seasonal closure window is planned for
// Malaria cases per 1,000 people per week by outlook. Eastern Province runs ~300 cases per 1,000
// a year (World Bank), so ~6/1,000/week in season; low is the dry-season floor.
const MALARIA_PER_1000_WEEK: Record<PostOutlook["malariaOutlook6w"], number> = { low: 1, medium: 3.5, high: 8 };
// Watery diarrhoea per 1,000 per week when standing water is around (ORS and zinc).
const DIARRHOEA_PER_1000_WEEK = { dry: 1, wet: 3 };
// How much a raised malaria outlook multiplies the minimum for malaria items (rule c).
const OUTLOOK_FACTOR: Record<PostOutlook["malariaOutlook6w"], number> = { low: 1, medium: 1.5, high: 2 };

// Road distance is about 1.5x the straight line in Eastern Province; boats follow the river bends.
const PATH_FACTOR: Record<string, number> = { truck: 1.5, pickup: 1.5, motorbike: 1.4, bicycle: 1.4, boat: 1.3, drone: 1 };
// Rough running cost per km in ZMW when the carrier table does not say (fallback fleet only).
const RUN_LABEL = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];

// Zambia's real means of moving medicine, used when the `carrier` table is not published yet:
// ZAMMSA's trucks out of Chipata, the eleven district health offices' pickups, Community Health
// Assistants' motorbikes, community health workers' bicycles, banana boats on the Luangwa (Mambwe
// and Chama) and a proposed drone partner (no drone fleet operates in Zambia today).
export function fallbackFleet(posts: Pick<PostState, "id" | "name" | "hub">[]): Carrier[] {
  const hub = posts.find((p) => p.hub)?.id ?? 1;
  const districts = posts.filter((p) => !p.hub && p.id >= 2 && p.id <= 12);
  const fleet: Carrier[] = [
    { id: 1, name: "ZAMMSA 10-tonne truck", kind: "truck", operator: "ZAMMSA", baseVillageId: hub, capacityKg: 10000, speedKmh: 40, costPerKm: 14, status: "idle" },
    { id: 2, name: "ZAMMSA 3-tonne truck", kind: "truck", operator: "ZAMMSA", baseVillageId: hub, capacityKg: 3000, speedKmh: 45, costPerKm: 9, status: "idle" },
    { id: 3, name: "Provincial office pickup", kind: "pickup", operator: "Provincial Health Office", baseVillageId: hub, capacityKg: 800, speedKmh: 50, costPerKm: 6, status: "idle" },
  ];
  let id = 10;
  for (const d of districts) {
    const name = d.name.replace(/ \(.*\)$/, "");
    fleet.push({ id: id++, name: `${name} district pickup`, kind: "pickup", operator: `District Health Office ${name}`, baseVillageId: d.id, capacityKg: 800, speedKmh: 50, costPerKm: 6, status: "idle" });
    fleet.push({ id: id++, name: `${name} CHA motorbike`, kind: "motorbike", operator: `Community Health Assistant, ${name}`, baseVillageId: d.id, capacityKg: 25, speedKmh: 45, costPerKm: 1.5, status: "idle" });
    fleet.push({ id: id++, name: `${name} CHW bicycle`, kind: "bicycle", operator: `Community health worker, ${name}`, baseVillageId: d.id, capacityKg: 15, speedKmh: 12, costPerKm: 0.2, status: "idle" });
  }
  for (const riverPost of [8, 10]) if (posts.some((p) => p.id === riverPost)) fleet.push({ id: id++, name: `Luangwa banana boat (${posts.find((p) => p.id === riverPost)!.name.replace(/ \(.*\)$/, "")})`, kind: "boat", operator: "River transport cooperative", baseVillageId: riverPost, capacityKg: 300, speedKmh: 15, costPerKm: 3, status: "idle" });
  fleet.push({ id: id++, name: "Medical drone (proposed partner)", kind: "drone", operator: "proposed partner, not operating in Zambia today", baseVillageId: hub, capacityKg: 3, speedKmh: 100, costPerKm: 4, status: "proposed" });
  return fleet;
}

// ---- Geometry ----

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const short = (name: string) => name.replace(/ \(.*\)$/, "");
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (from: Date, days: number) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---- Carrier choice ----

type Leg = { carrier: Carrier; km: number; minutes: number; cost: number };

// Minutes for one carrier to reach `to` from its base (loading and a stop at the hub if the stock
// is at the hub and the carrier is based elsewhere).
function leg(c: Carrier, from: { lat: number; lng: number; id: number }, to: { lat: number; lng: number }, byId: Map<number, PostState>): Leg {
  const base = byId.get(c.baseVillageId) ?? from;
  const factor = PATH_FACTOR[c.kind] ?? 1.5;
  const toPickUp = base.id === from.id ? 0 : distanceKm(base, from) * factor;
  const km = toPickUp + distanceKm(from, to) * factor;
  const minutes = Math.max(5, Math.round((km / c.speedKmh) * 60 + (c.kind === "drone" ? 10 : 30))); // loading
  return { carrier: c, km: Math.round(km), minutes, cost: Math.round(km * c.costPerKm) };
}

function canCarry(c: Carrier, items: { item: string; qty: number }[], kg: number, cutOffNow: boolean) {
  if (c.status === "down" || c.status === "out") return false;
  if (kg > c.capacityKg) return false;
  if (c.kind === "drone" && items.some((i) => HEAVY.has(i.item) || HUB_ONLY.has(i.item))) return false; // rule (e)
  if (cutOffNow && (c.kind === "truck" || c.kind === "pickup" || c.kind === "motorbike" || c.kind === "bicycle")) return false; // the road is under water
  return true;
}

// A carrier that does not exist yet (the drone partner the province is talking to) is a proposal:
// it is never relied on while something real can reach the post, but the plan says what it would do.
export const isProposed = (c: Carrier) => c.status === "proposed" || /proposed/i.test(c.name) || /proposed/i.test(c.operator);

// One carrier has about ten hours of driving in a day; the plan spreads the work across the fleet.
export const CARRIER_DAY_MINUTES = 600;

function pickCarrier(carriers: Carrier[], from: PostState, to: PostState, items: { item: string; qty: number }[], kg: number, mode: "fastest" | "cheapest", byId: Map<number, PostState>, busy: Map<number, number>): { pick: Leg; proposedFaster: Leg | null; overDay: boolean } | null {
  const legs = carriers.filter((c) => canCarry(c, items, kg, to.outlook.cutOffNow)).map((c) => leg(c, from, to, byId));
  if (!legs.length) return null;
  const by = (a: Leg, b: Leg) => (mode === "fastest" ? a.minutes - b.minutes || a.cost - b.cost : a.cost - b.cost || a.minutes - b.minutes);
  const real = legs.filter((l) => !isProposed(l.carrier)).sort(by);
  const proposed = legs.filter((l) => isProposed(l.carrier)).sort((a, b) => a.minutes - b.minutes);
  // The leg has to fit in what is left of the carrier's day (the return can be tomorrow); when
  // nothing fits, the least-loaded real carrier takes it and the plan says the fleet is over its day.
  const left = (l: Leg) => busy.get(l.carrier.id) ?? 0;
  const free = real.filter((l) => left(l) + l.minutes <= CARRIER_DAY_MINUTES);
  const pick = free[0] ?? [...real].sort((a, b) => left(a) - left(b) || by(a, b))[0] ?? proposed[0];
  if (!pick) return null;
  if (!isProposed(pick.carrier)) busy.set(pick.carrier.id, left(pick) + pick.minutes);
  const proposedFaster = real[0] && proposed[0] && proposed[0].minutes < pick.minutes ? proposed[0] : null;
  return { pick, proposedFaster, overDay: !free.length && !!real.length };
}

// ---- Demand ----

function weightOf(items: { item: string; qty: number }[]) {
  const kg = items.reduce((s, i) => s + (ITEM_KG[i.item] ?? 0.05) * i.qty, 0);
  return Math.round((kg + (items.some((i) => VACCINE_ITEMS.has(i.item)) ? COLD_CHAIN_KG : 0)) * 100) / 100;
}

// The (raised) minimum a post should hold for an item (rule c).
export function targetFor(item: string, post: PostState) {
  if (HUB_ONLY.has(item)) return 0;
  const base = MIN_STOCK[item] ?? 3;
  const raised = MALARIA_ITEMS.has(item) ? Math.ceil(base * OUTLOOK_FACTOR[post.outlook.malariaOutlook6w]) : base;
  const due = VACCINE_ITEMS.has(item) ? (post.vaccinesDue[item] ?? 0) : 0;
  return Math.max(raised, due + 1 > base ? due + 1 : raised);
}

// What the post will use while its roads are closed (rule b). The seasonal rule (b2) passes its
// own window and, when the malaria peak falls inside it, the high case rate.
export function closureDemand(post: PostState, opts: { weeks?: number; malaria?: PostOutlook["malariaOutlook6w"]; wet?: boolean } = {}): Record<string, number> {
  const weeks = opts.weeks ?? CLOSURE_WEEKS;
  const cases = (post.population / 1000) * MALARIA_PER_1000_WEEK[opts.malaria ?? post.outlook.malariaOutlook6w] * weeks;
  const wet = opts.wet ?? (post.outlook.floodRiskToday || post.outlook.floodRisk14d || post.outlook.rainNext14Mm >= 60);
  const runs = (post.population / 1000) * (wet ? DIARRHOEA_PER_1000_WEEK.wet : DIARRHOEA_PER_1000_WEEK.dry) * weeks;
  const d: Record<string, number> = {
    "Malaria rapid test": Math.ceil(cases * 1.5), // more tests than cases
    "Antimalarial (ACT)": Math.ceil(cases),
    "Rectal artesunate": Math.max(1, Math.ceil(cases * 0.05)), // ~5% severe
    "Oral rehydration salts": Math.ceil(runs),
    Zinc: Math.ceil(runs * 0.6),
    Paracetamol: Math.ceil(cases * 0.8),
    Amoxicillin: Math.ceil((post.population / 1000) * 1.5 * weeks), // pneumonia in the wet season
  };
  for (const [item, due] of Object.entries(post.vaccinesDue)) d[item] = Math.max(d[item] ?? 0, due);
  return d;
}

// ---- The planner ----

export type PlanInput = { posts: PostState[]; carriers: Carrier[]; now?: Date; weatherSource?: string; seasonSource?: string; carrierSource?: "table" | "fallback" };

const daysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400_000);
const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from <= b.to && b.from <= a.to;

// The seasonal shipment's dates for a post: when its closure weeks start, when the truck must leave.
export function seasonWindow(season: PostSeason | null | undefined, now: Date) {
  if (!season?.closureStart || !season.closureEnd) return null;
  const today = isoDate(now);
  const daysUntilClosure = daysBetween(today, season.closureStart);
  const sendByIso = isoDate(plusDays(new Date(`${season.closureStart}T00:00:00Z`), -SEASON_LEAD_DAYS));
  const sendBy = sendByIso < today ? today : sendByIso; // late: it goes now
  const inWindow = daysUntilClosure <= SEASON_HORIZON_DAYS && today <= season.closureEnd;
  // Stock for the days the post is usually cut off (plus a week's margin, since the cut-off days
  // come in several spells), never less than the forecast rule's 3 weeks nor more than 8.
  const closureWeeksCount = Math.max(SEASON_MIN_WEEKS, Math.min(SEASON_MAX_WEEKS, Math.ceil(season.cutOffDaysInSeason / 7) + 1));
  return { daysUntilClosure, sendBy, inWindow, closureWeeksCount };
}

export function planDispatch(input: PlanInput): DispatchPlan {
  const now = input.now ?? new Date();
  const byId = new Map(input.posts.map((p) => [p.id, p]));
  const hub = input.posts.find((p) => p.hub);
  if (!hub) throw new Error("No hub in the village table");
  const posts = input.posts.filter((p) => !p.hub);
  const carriers = input.carriers.length ? input.carriers : fallbackFleet(input.posts);
  const notes: string[] = [];
  // Stock we can still promise: the hub's shelf, less what earlier shipments in this plan take.
  const hubLeft: Record<string, number> = { ...hub.stock };
  // Posts with idle surplus (the real Zambian pattern) lend before the hub is asked, when closer.
  const surplusLeft = new Map<number, Record<string, number>>();
  for (const p of posts) surplusLeft.set(p.id, { ...p.stock });

  type Line = { item: string; qty: number; why: string };
  const draft: { post: PostState; priority: PriorityTier; lines: Line[]; why: string[]; score: number; sendBy: Date; mode: "fastest" | "cheapest" }[] = [];

  for (const post of posts) {
    const o = post.outlook;
    const have = (item: string) => post.stock[item] ?? 0;
    const onWay = (item: string) => post.incoming[item] ?? 0;
    const promised = new Set<string>();

    // (a) Emergency: a red visit, or a life-saving item at zero.
    // The pod's own order for the patient is already moving (the module sends it the moment the
    // visit is reported), so the shipment REPLACES what that order took from the shelf and fills
    // every life-saving item back up to its target.
    const outLife = LIFE_SAVING.filter((item) => have(item) === 0 && onWay(item) === 0);
    const needLines: Line[] = post.openNeeds.filter((n) => n.qty > 0 && !HUB_ONLY.has(n.item)).map((n) => ({ item: n.item, qty: n.qty, why: `replaces the ${n.qty} ${n.item} the pod just ordered for a patient` }));
    if (post.redVisitsOpen > 0 || outLife.length) {
      const lines: Line[] = [];
      const why: string[] = [];
      if (post.redVisitsOpen > 0) why.push(`${plural(post.redVisitsOpen, "red visit")} open at ${short(post.name)}: the pod flagged an emergency`);
      for (const n of needLines) lines.push(n);
      for (const item of LIFE_SAVING) {
        const target = targetFor(item, post);
        const gap = target - have(item) - onWay(item);
        if (gap <= 0) continue;
        const existing = lines.find((l) => l.item === item);
        if (existing) existing.qty = Math.max(existing.qty, gap);
        else lines.push({ item, qty: gap, why: have(item) === 0 ? `${item} is at zero and it saves lives` : `${item} has ${have(item)}, below the ${target} it must hold for the next emergency` });
      }
      if (outLife.length) why.push(`life-saving items at zero: ${outLife.join(", ")}`);
      if (o.cutOffNow) why.push("the post is cut off right now, so the road carriers cannot reach it");
      for (const l of lines) promised.add(l.item);
      let score = 1000 + post.redVisitsOpen * 200 + outLife.length * 40 + (o.cutOffNow ? 150 : 0) + Math.min(50, post.population / 500);
      if (o.malariaOutlook6w === "high") score += 20;
      if (lines.length) draft.push({ post, priority: "emergency", lines, why, score, sendBy: now, mode: "fastest" });
    } else if (needLines.length) {
      // A pod asked and the order has not left: urgent, today.
      for (const l of needLines) promised.add(l.item);
      draft.push({ post, priority: "urgent", lines: needLines, why: [`${plural(needLines.length, "need")} flagged by the pod not yet delivered`], score: 600 + needLines.length * 20 + Math.min(50, post.population / 500), sendBy: now, mode: "fastest" });
    }

    // (b) Pre-position before the roads close.
    if (o.daysUntilCutOff !== null && o.daysUntilCutOff <= CUT_OFF_HORIZON_DAYS && !o.cutOffNow) {
      const demand = closureDemand(post);
      const lines: Line[] = [];
      for (const [item, need] of Object.entries(demand)) {
        if (promised.has(item) || HUB_ONLY.has(item)) continue;
        const gap = need - have(item) - onWay(item);
        if (gap > 0) lines.push({ item, qty: gap, why: `${CLOSURE_WEEKS} weeks closed needs ~${need}, has ${have(item)}${onWay(item) ? ` + ${onWay(item)} on the way` : ""}` });
      }
      if (lines.length) {
        for (const l of lines) promised.add(l.item);
        const why = [
          `roads may close in ${plural(o.daysUntilCutOff, "day")} (cut-off risk ${Math.round(o.cutOffRisk * 100)}%${o.rainNext14Mm ? `, ${Math.round(o.rainNext14Mm)} mm forecast in 14 days` : ""})`,
          `malaria outlook ${o.malariaOutlook6w} for ${post.population.toLocaleString()} people: ${CLOSURE_WEEKS} weeks of demand is more than the shelf holds`,
        ];
        // Leave a day for loading and the drive; never later than the closure itself.
        const sendBy = plusDays(now, Math.max(0, o.daysUntilCutOff - 2));
        draft.push({ post, priority: "pre-position", lines, why, score: 400 + o.cutOffRisk * 100 + (14 - o.daysUntilCutOff) * 5 + (o.malariaOutlook6w === "high" ? 40 : o.malariaOutlook6w === "medium" ? 15 : 0) + Math.min(30, post.population / 1000), sendBy, mode: "cheapest" });
      }
    }

    // (b2) Pre-position from the seasonal calendar: the post's typical closure weeks begin within
    // SEASON_HORIZON_DAYS (whether or not the 16-day forecast sees them yet). Stock for the whole
    // typical closure window (its length in weeks, 3–8) at the high malaria rate when the malaria
    // peak falls inside it; the truck leaves SEASON_LEAD_DAYS before the first closure week.
    const sw = seasonWindow(o.season, now);
    if (sw && sw.inWindow && !o.cutOffNow && !draft.some((d) => d.post.id === post.id && d.priority === "pre-position")) {
      const season = o.season!;
      const peakInside = overlaps(season.malariaPeak, { from: season.closureStart!, to: season.closureEnd! });
      const malaria: PostOutlook["malariaOutlook6w"] = peakInside ? "high" : o.malariaOutlook6w === "low" ? "medium" : o.malariaOutlook6w;
      const demand = closureDemand(post, { weeks: sw.closureWeeksCount, malaria, wet: true });
      const lines: Line[] = [];
      for (const [item, need] of Object.entries(demand)) {
        if (promised.has(item) || HUB_ONLY.has(item)) continue;
        const gap = need - have(item) - onWay(item);
        if (gap > 0) lines.push({ item, qty: gap, why: `${sw.closureWeeksCount} weeks of the usual closure${peakInside ? " at the malaria peak" : ""} needs ~${need}, has ${have(item)}${onWay(item) ? ` + ${onWay(item)} on the way` : ""}` });
      }
      if (lines.length) {
        for (const l of lines) promised.add(l.item);
        const late = sw.daysUntilClosure < SEASON_LEAD_DAYS;
        const why = [
          `roads usually close from ${season.closureStart} (${sw.daysUntilClosure <= 0 ? "the closure weeks have begun" : `in ${plural(sw.daysUntilClosure, "day")}`}; ${season.closureWeeks.length} closure week${season.closureWeeks.length === 1 ? "" : "s"} to ${season.closureEnd}, about ${season.cutOffDaysInSeason} cut-off days a season; ${season.confidence} confidence from 10 years of rain)`,
          `${peakInside ? `malaria peak ${season.malariaPeak.from} → ${season.malariaPeak.to} falls inside the closure, planned at the high rate` : `malaria outlook ${malaria} for the window`} for ${post.population.toLocaleString()} people: ${sw.closureWeeksCount} weeks of demand is more than the shelf holds`,
          late ? `send now: the usual lead of ${SEASON_LEAD_DAYS} days before the closure has passed` : `send by ${sw.sendBy}, ${SEASON_LEAD_DAYS} days before the closure usually starts`,
        ];
        draft.push({ post, priority: "pre-position-seasonal", lines, why, score: 300 + Math.max(0, SEASON_HORIZON_DAYS - sw.daysUntilClosure) * 2 + (peakInside ? 20 : 0) + season.cutOffDaysInSeason + Math.min(30, post.population / 1000), sendBy: new Date(`${sw.sendBy}T00:00:00Z`), mode: "cheapest" });
      }
    }

    // (c)+(d) Routine top-up to the (raised) minimum.
    const lines: Line[] = [];
    for (const item of Object.keys(MIN_STOCK)) {
      if (promised.has(item)) continue;
      const target = targetFor(item, post);
      const gap = target - have(item) - onWay(item);
      if (gap <= 0) continue;
      const raised = MALARIA_ITEMS.has(item) && o.malariaOutlook6w !== "low";
      const due = VACCINE_ITEMS.has(item) ? post.vaccinesDue[item] ?? 0 : 0;
      lines.push({ item, qty: gap, why: due ? `${plural(due, "dose")} due on the register, has ${have(item)}` : raised ? `has ${have(item)}, target raised to ${target} for the ${o.malariaOutlook6w} malaria outlook` : `has ${have(item)}, below the ${target} every post must hold` });
    }
    if (lines.length) {
      const outs = lines.filter((l) => have(l.item) === 0).length;
      const why = [`${plural(lines.length, "item")} below the minimum, ${outs} at zero`];
      if (o.malariaOutlook6w !== "low") why.push(`malaria outlook ${o.malariaOutlook6w} in six weeks: test and treatment targets raised`);
      if (Object.keys(post.vaccinesDue).length) why.push(`${Object.values(post.vaccinesDue).reduce((a, b) => a + b, 0)} vaccine doses due on the register`);
      draft.push({ post, priority: "routine", lines, why, score: 100 + outs * 8 + lines.length * 2 + (o.malariaOutlook6w === "high" ? 30 : o.malariaOutlook6w === "medium" ? 10 : 0) + Math.min(20, post.population / 1500), sendBy: plusDays(now, 7), mode: "cheapest" });
    }
  }

  // Rank, then allocate stock in rank order: the hub first, a nearer post with idle surplus when it has plenty.
  draft.sort((a, b) => b.score - a.score || a.post.name.localeCompare(b.post.name));
  const shipments: Shipment[] = [];
  const busy = new Map<number, number>(); // carrier id -> minutes already promised today
  let overDay = 0;
  for (const d of draft) {
    const items: Shipment["items"] = [];
    for (const line of d.lines) {
      let qty = line.qty;
      // Idle surplus at a post nearer than the hub (keeps at least twice its own minimum).
      const lender = posts
        .filter((p) => p.id !== d.post.id && !p.outlook.cutOffNow && (surplusLeft.get(p.id)?.[line.item] ?? 0) >= 2 * (MIN_STOCK[line.item] ?? 3) + qty && distanceKm(p, d.post) < distanceKm(hub, d.post))
        .sort((a, b) => distanceKm(a, d.post) - distanceKm(b, d.post))[0];
      if (lender) {
        surplusLeft.get(lender.id)![line.item] -= qty;
        items.push({ item: line.item, qty, from: short(lender.name), fromVillageId: lender.id, why: `${line.why}; from ${short(lender.name)}'s idle stock, nearer than the hub` });
        continue;
      }
      const left = hubLeft[line.item] ?? 0;
      if (left <= 0) {
        notes.push(`${short(d.post.name)}: no ${line.item} left at the hub or any post, so it is not in the plan.`);
        continue;
      }
      if (left < qty) {
        notes.push(`${short(d.post.name)}: only ${left} of ${qty} ${line.item} left at the hub.`);
        qty = left;
      }
      hubLeft[line.item] = left - qty;
      items.push({ item: line.item, qty, why: line.why });
    }
    if (!items.length) continue;
    const kg = weightOf(items);
    // One source village per shipment: the hub unless everything comes from one lender.
    const lenders = new Set(items.map((i) => i.fromVillageId ?? hub.id));
    const fromId = lenders.size === 1 ? [...lenders][0] : hub.id;
    const from = byId.get(fromId) ?? hub;
    const choice = pickCarrier(carriers, from, d.post, items, kg, d.mode, byId, busy);
    const pick = choice?.pick ?? null;
    if (choice?.overDay) overDay++;
    if (!pick) notes.push(`${short(d.post.name)}: no carrier can reach it with ${kg} kg right now${d.post.outlook.cutOffNow ? " (roads closed: needs a boat or a drone)" : ""}.`);
    const why = [...d.why];
    const hhmm = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10} h` : `${m} min`);
    if (pick) why.push(`${pick.carrier.name} from ${short(from.name)}, ~${pick.km} km, about ${hhmm(pick.minutes)}${isProposed(pick.carrier) ? " (proposed partner: nothing real can reach the post)" : d.mode === "fastest" ? " (fastest that can carry it)" : " (cheapest in time)"}`);
    const alt = choice?.proposedFaster ?? null;
    shipments.push({
      id: `${d.priority}-${d.post.id}`,
      rank: 0,
      toVillageId: d.post.id,
      toVillage: short(d.post.name),
      fromVillageId: from.id,
      fromVillage: short(from.name),
      items,
      kg,
      km: pick?.km ?? Math.round(distanceKm(from, d.post) * 1.5),
      carrierKind: (pick?.carrier.kind as CarrierKind) ?? "none",
      carrierName: pick?.carrier.name ?? "no carrier can reach",
      carrierId: pick?.carrier.id ?? null,
      etaMinutes: pick?.minutes ?? null,
      priority: d.priority,
      sendBy: isoDate(d.sendBy),
      why,
      run: null,
      droneAlternative: alt ? `${alt.carrier.name} would do it in about ${hhmm(alt.minutes)} (${alt.km} km straight line), ${Math.max(0, (pick?.minutes ?? 0) - alt.minutes)} min sooner` : null,
      score: Number.isFinite(d.score) ? Math.round(d.score) : 0,
    });
  }
  shipments.forEach((s, i) => (s.rank = i + 1));

  // (d) Batch the routine and pre-position shipments into runs: one truck or pickup per area
  // (the district centre nearest each post), when the loads fit.
  const runs: Run[] = [];
  const districts = posts.filter((p) => p.id >= 2 && p.id <= 12);
  const groups = new Map<number, Shipment[]>();
  for (const s of shipments) {
    if (s.priority === "emergency" || s.priority === "urgent" || s.carrierKind === "none") continue; // routine and both pre-position tiers ride the runs
    const post = byId.get(s.toVillageId)!;
    const nearest = districts.length ? districts.reduce((best, d) => (distanceKm(d, post) < distanceKm(best, post) ? d : best)) : hub;
    const key = nearest.id;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  let n = 0;
  for (const [districtId, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    const district = byId.get(districtId)!;
    const kg = Math.round(list.reduce((s, x) => s + x.kg, 0) * 100) / 100;
    // Tour: hub -> the district centre -> each post in order of distance from the hub -> back.
    const stops = list.map((s) => byId.get(s.toVillageId)!).sort((a, b) => distanceKm(hub, a) - distanceKm(hub, b));
    let km = 0, at: { lat: number; lng: number } = hub;
    for (const stop of stops) {
      km += distanceKm(at, stop) * 1.5;
      at = stop;
    }
    km += distanceKm(at, hub) * 1.5;
    // A ZAMMSA truck out of the hub, or this area's own district pickup (which first drives to the
    // hub to load): whichever costs less for the whole trip. Pickups from other districts stay home.
    const candidates = carriers
      .filter((c) => (c.kind === "truck" || c.kind === "pickup") && c.status !== "down" && c.status !== "out" && !isProposed(c) && c.capacityKg >= kg && (c.baseVillageId === hub.id || c.baseVillageId === district.id) && !stops.some((p) => p.outlook.cutOffNow))
      .map((c) => {
        const base = byId.get(c.baseVillageId) ?? hub;
        const extra = base.id === hub.id ? 0 : distanceKm(base, hub) * 1.5 * 2; // out to load and back home
        const minutes = Math.round(((km + extra) / c.speedKmh) * 60 + 20 * stops.length);
        return { c, trip: km + extra, minutes, cost: (km + extra) * c.costPerKm, fits: (busy.get(c.id) ?? 0) + minutes <= CARRIER_DAY_MINUTES };
      })
      .sort((a, b) => Number(b.fits) - Number(a.fits) || (a.fits ? a.cost - b.cost : (busy.get(a.c.id) ?? 0) - (busy.get(b.c.id) ?? 0)) || a.trip - b.trip);
    const best = candidates[0];
    const fits = best?.c;
    if (best && !best.fits) overDay++;
    if (fits) busy.set(fits.id, (busy.get(fits.id) ?? 0) + best!.minutes);
    const id = `run-${RUN_LABEL[n] ?? n + 1}`;
    n++;
    const minutes = best?.minutes ?? 0;
    runs.push({ id, label: `Run ${RUN_LABEL[n - 1] ?? n}: ${short(district.name)} area`, carrierKind: (fits?.kind as CarrierKind) ?? "none", carrierName: fits?.name ?? "no truck free", carrierId: fits?.id ?? null, posts: stops.map((p) => short(p.name)), kg, km: Math.round(km), minutes });
    for (const s of list) {
      s.run = id;
      if (fits) {
        s.carrierKind = fits.kind as CarrierKind;
        s.carrierName = fits.name;
        s.carrierId = fits.id;
        s.why = s.why.filter((w) => !w.includes("(cheapest in time)"));
        s.why.push(`rides on ${id.replace("run-", "run ")} (${fits.name}, ${stops.length} posts around ${short(district.name)}, ${kg} kg, ~${Math.round(km)} km)`);
      }
    }
  }

  if (overDay) notes.push(`The fleet is over its day: ${plural(overDay, "trip")} beyond ${CARRIER_DAY_MINUTES / 60} hours of driving per carrier; they run tomorrow or need another vehicle.`);

  // Emergency mode: a post cut off, or a red visit open anywhere.
  const cutOffPosts = posts.filter((p) => p.outlook.cutOffNow).map((p) => short(p.name));
  const redVisitPosts = posts.filter((p) => p.redVisitsOpen > 0).map((p) => short(p.name));
  const reasons: string[] = [];
  if (redVisitPosts.length) reasons.push(`red visit open at ${redVisitPosts.join(", ")}`);
  if (cutOffPosts.length) reasons.push(`roads closed at ${cutOffPosts.join(", ")}`);

  const counts = { emergency: 0, urgent: 0, "pre-position": 0, "pre-position-seasonal": 0, routine: 0, items: 0, kg: 0, posts: new Set(shipments.map((s) => s.toVillageId)).size };
  for (const s of shipments) {
    counts[s.priority]++;
    counts.items += s.items.reduce((a, i) => a + i.qty, 0);
    counts.kg += s.kg;
  }
  counts.kg = Math.round(counts.kg * 10) / 10;

  return {
    plannedAt: now.toISOString(),
    shipments,
    runs,
    emergency: { active: reasons.length > 0, reasons, cutOffPosts, redVisitPosts },
    posts: posts
      .map((p) => ({
        villageId: p.id,
        name: short(p.name),
        cutOffRisk: p.outlook.cutOffRisk,
        daysUntilCutOff: p.outlook.daysUntilCutOff,
        cutOffDate: p.outlook.cutOffDate,
        cutOffReason: p.outlook.cutOffReason ?? null,
        cutOffNow: p.outlook.cutOffNow,
        malariaOutlook6w: p.outlook.malariaOutlook6w,
        floodRiskToday: p.outlook.floodRiskToday,
        floodTodayLevel: p.outlook.floodTodayLevel,
        flood14dLevel: p.outlook.flood14dLevel,
        rainNext14Mm: p.outlook.rainNext14Mm,
        redVisitsOpen: p.redVisitsOpen,
        outlookSource: p.outlook.source,
        season: p.outlook.season ? (() => { const sw = seasonWindow(p.outlook.season, now); return { ...p.outlook.season!, sendBy: sw?.sendBy ?? null, daysUntilClosure: sw?.daysUntilClosure ?? null, inWindow: !!sw?.inWindow }; })() : null,
      }))
      .sort((a, b) => Number(b.cutOffNow) - Number(a.cutOffNow) || (a.daysUntilCutOff ?? 99) - (b.daysUntilCutOff ?? 99) || b.cutOffRisk - a.cutOffRisk),
    counts,
    notes: [...new Set(notes)],
    weatherSource: input.weatherSource ?? "",
    seasonSource: input.seasonSource ?? "",
    carrierSource: input.carrierSource ?? (input.carriers.length ? "table" : "fallback"),
  };
}
