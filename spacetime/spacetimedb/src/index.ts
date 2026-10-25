// Pod network database (SpacetimeDB). Zambia, Eastern Province: medicines exist at the regional
// hub, but village health posts run out because distribution is poor.
//
// Pods call `reportVisit` when a patient is triaged. Every need the pod flags becomes a delivery
// order addressed to that patient's home: from the village post if it has stock, otherwise from
// the hub (drone if light enough, truck if not). A scheduled `tick` moves orders along, can
// generate background patients from other villages, and every few seconds runs the network
// agents: the supply allocator restocks posts from the hub or from a post with idle stock, and
// the outbreak sentinel spots case clusters and pre-positions stock. Everything the agents decide
// is written to `agent_log` so the government view can show its reasoning.
// Clients subscribe to everything; `pop` is an event table for the "+1" bubbles on the globe.
//
// Three tables make the pods themselves live: `pod` (which pods are online and what each is doing
// right now, from `podHeartbeat`), `visit_record` (the full saved visit and the doctor's handover
// note, from `saveVisitRecord`, so the staff pages subscribe instead of polling a file) and
// `dialect_word` (the words each community uses, from `rememberWords`, shared across pods).

import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

const village = table(
  { name: 'village', public: true },
  {
    id: t.u32().primaryKey(),
    name: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    population: t.u32(),
    hub: t.bool(),
  }
);

const stock = table(
  { name: 'stock', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    villageId: t.u32().index('btree'),
    item: t.string(),
    qty: t.i32(),
  }
);

const visit = table(
  { name: 'visit', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    villageId: t.u32(),
    patientName: t.string(),
    urgency: t.string(), // green | yellow | red
    summary: t.string(),
    fromPod: t.bool(), // a real pod (true) or background simulation (false)
    createdAt: t.timestamp(),
  }
);

const deliveryOrder = table(
  { name: 'delivery_order', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    visitId: t.u64(), // 0 for a restock
    kind: t.string(), // patient | restock
    patientName: t.string(), // or "<village> health post" for a restock
    toVillageId: t.u32(),
    fromVillageId: t.u32(),
    item: t.string(),
    qty: t.u32(),
    mode: t.string(), // walk | drone | road
    status: t.string(), // ordered | on_the_way | delivered
    travelSeconds: t.u32(), // demo time on screen
    etaMinutes: t.u32(), // real-world estimate
    createdAt: t.timestamp(),
    departedAt: t.option(t.timestamp()),
    deliveredAt: t.option(t.timestamp()),
  }
);

const pop = table(
  { name: 'pop', public: true, event: true },
  {
    villageId: t.u32(),
    text: t.string(),
    kind: t.string(), // need | delivered | alert | restock
  }
);

// People the posts know: age, pregnancy and which vaccine doses they already had, so the pod and
// the immunisation planner can tell exactly who is due what.
const patient = table(
  { name: 'patient', public: true },
  {
    id: t.u32().primaryKey(),
    name: t.string(),
    villageId: t.u32().index('btree'),
    ageMonths: t.u32(),
    sex: t.string(), // f | m
    pregnant: t.bool(),
    notes: t.string(), // chronic conditions, in plain words
    vaccinesGiven: t.string(), // comma-separated dose codes: BCG,OPV0,PENTA1,...
    lastVisit: t.string(), // free text
  }
);

// People who opted in at the end of a visit: those who want company through a hard time, and
// volunteers willing to meet them. The connector agent pairs them within a village.
const communityMember = table(
  { name: 'community_member', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    villageId: t.u32().index('btree'),
    name: t.string(), // first name only is enough
    role: t.string(), // seeking | volunteer
    topic: t.string(), // what they are going through / what they can offer, in their words
    matchedWith: t.string(), // name of the person they were paired with, or ''
    joinedAt: t.timestamp(),
  }
);

const agentLog = table(
  { name: 'agent_log', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    agent: t.string(), // Supply allocator | Outbreak sentinel | Pod
    villageId: t.u32(), // 0 = whole province
    text: t.string(),
  }
);

const settings = table(
  { name: 'settings', public: true },
  {
    id: t.u32().primaryKey(),
    simulate: t.bool(),
    simEverySeconds: t.u32(),
    agents: t.bool(), // the allocator and sentinel run on their own
    lastAgentsRun: t.timestamp(),
  }
);

// One row per pod (one pod per village in the demo). The pod screen sends a heartbeat every few
// seconds while it is open; `tick` marks the pod offline once the heartbeats stop.
const pod = table(
  { name: 'pod', public: true },
  {
    villageId: t.u32().primaryKey(),
    status: t.string(), // idle | listening | thinking | speaking | offline
    step: t.string(), // what the pod is asking about right now ('' between visits)
    language: t.string(), // what the patient speaks (en, es, ar...), '' when nobody is there
    online: t.bool(),
    lastSeen: t.timestamp(),
  }
);

// The full visit as the registry saves it (a mirror of data/registry.json), so the staff and
// patient pages get every visit, and the doctor's handover note once Claude writes it, the
// moment it lands. Lists are kept as JSON text; '' stands for "not known / not given".
const visitRecord = table(
  { name: 'visit_record', public: true },
  {
    id: t.string().primaryKey(), // the registry's uuid
    villageId: t.u32().index('btree'),
    createdAt: t.string(), // ISO, as the registry wrote it
    region: t.string(),
    consent: t.bool(),
    name: t.string(), // '' when the patient did not agree to be saved
    community: t.string(),
    patient: t.string(), // "self" / "daughter, 3 years" ...
    ageGroup: t.string(),
    language: t.string(),
    locale: t.string(),
    urgency: t.string(), // green | yellow | red
    reason: t.string(),
    causes: t.string(), // JSON [{ name, probability }]
    resources: t.string(), // JSON [{ item, probability, delivery }]
    orders: t.string(), // JSON [{ item, qty, note, for }]
    mentalCategory: t.string(),
    wantsPeerGroup: t.bool(),
    volunteer: t.bool(),
    handover: t.string(), // '' until the note is written
    updatedAt: t.timestamp(),
  }
);

// The words a community uses for things ("running stomach" for diarrhea), one row per community,
// concept and word, counted every time a patient there says it. Every pod reads the same table,
// so a word learned in one village is spoken by every pod there from the next visit on.
const dialectWord = table(
  { name: 'dialect_word', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    villageId: t.u32().index('btree'), // 0 when the community is not one of the posts
    community: t.string(), // as the patient said it, lower-case
    concept: t.string(),
    word: t.string(),
    times: t.u32(),
    heardAt: t.timestamp(),
  }
);

// The vehicles that actually move medicine in Eastern Province: ZAMMSA's hub trucks out of
// Chipata, the district health offices' pickups, Community Health Assistants' motorbikes,
// community health workers' bicycles, banana boats where the Luangwa cuts a post off, and
// drones (seeded as a proposed partner: no drone fleet operates in Zambia today). Seeded by
// `seed`, re-seeded by `resetDemo`; status flips out/idle as orders depart and arrive.
const carrier = table(
  { name: 'carrier', public: true },
  {
    id: t.u32().primaryKey(),
    name: t.string(),
    kind: t.string(), // truck | pickup | motorbike | bicycle | boat | drone
    operator: t.string(), // ZAMMSA | District Health Office Katete | CHA ... | proposed partner
    baseVillageId: t.u32(),
    capacityKg: t.f64(),
    speedKmh: t.u32(),
    costPerKm: t.f64(), // ZMW per km, rough
    status: t.string(), // idle | out | down
  }
);

// A planned pathway for one delivery order: which carrier, the road it follows (JSON list of
// [lat, lng]), how far and how long, the flood risk the weather check gave the legs, and why
// it was chosen or re-routed. One plan per order; planning again replaces it.
const routePlan = table(
  { name: 'route_plan', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    orderId: t.u64().index('btree'),
    carrierId: t.u32(),
    waypoints: t.string(), // JSON [[lat,lng],...]
    km: t.f64(),
    minutes: t.u32(),
    floodRisk: t.string(), // low | medium | high
    status: t.string(), // planned | moving | done | rerouted
    reason: t.string(),
    createdAt: t.timestamp(),
  }
);

const tickTimer = table(
  { name: 'tick_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({ village, stock, visit, deliveryOrder, pop, patient, communityMember, agentLog, settings, pod, visitRecord, dialectWord, carrier, routePlan, tickTimer });
export default spacetimedb;

const Need = t.object('Need', { item: t.string(), qty: t.u32() });
const Word = t.object('Word', { concept: t.string(), word: t.string() });
const VisitRecordIn = t.object('VisitRecordIn', {
  id: t.string(), village: t.string(), createdAt: t.string(), region: t.string(), consent: t.bool(), name: t.string(), community: t.string(), patient: t.string(),
  ageGroup: t.string(), language: t.string(), locale: t.string(), urgency: t.string(), reason: t.string(), causes: t.string(), resources: t.string(), orders: t.string(),
  mentalCategory: t.string(), wantsPeerGroup: t.bool(), volunteer: t.bool(), handover: t.string(),
});
const POD_OFFLINE_AFTER_US = 20_000_000n; // no heartbeat for this long = the pod screen is closed

// Approximate locations. Chipata is the regional hub with full shelves; the posts are short.
const VILLAGES = [
  { id: 1, name: 'Chipata (hub)', lat: -13.633, lng: 32.65, population: 127000, hub: true },
  { id: 2, name: 'Katete', lat: -14.05, lng: 32.05, population: 26000, hub: false },
  { id: 3, name: 'Petauke', lat: -14.25, lng: 31.32, population: 31000, hub: false },
  { id: 4, name: 'Sinda', lat: -14.217, lng: 31.767, population: 12000, hub: false },
  { id: 5, name: 'Nyimba', lat: -14.55, lng: 30.817, population: 9000, hub: false },
  { id: 6, name: 'Lundazi', lat: -12.283, lng: 33.167, population: 17000, hub: false },
  { id: 7, name: 'Chadiza', lat: -14.067, lng: 32.433, population: 8000, hub: false },
  { id: 8, name: 'Mfuwe (Mambwe)', lat: -13.083, lng: 31.783, population: 10000, hub: false },
  { id: 9, name: 'Vubwi', lat: -13.983, lng: 32.883, population: 6000, hub: false },
  { id: 10, name: 'Chama', lat: -11.217, lng: 33.167, population: 15000, hub: false },
  { id: 11, name: 'Lumezi', lat: -12.8, lng: 32.75, population: 7000, hub: false },
  { id: 12, name: 'Kasenengwa', lat: -13.88, lng: 32.17, population: 6500, hub: false },
  // Rural health posts around each district (approximate locations, for the map).
  { id: 13, name: 'Mphangwe', lat: -13.93, lng: 32.18, population: 2100, hub: false },
  { id: 14, name: 'Kagoro', lat: -14.12, lng: 31.98, population: 1800, hub: false },
  { id: 15, name: 'Kafumbwe', lat: -14.22, lng: 32.12, population: 2400, hub: false },
  { id: 16, name: 'Minga', lat: -14.37, lng: 31.52, population: 2600, hub: false },
  { id: 17, name: 'Nyamphande', lat: -14.17, lng: 31.22, population: 1900, hub: false },
  { id: 18, name: 'Ukwimi', lat: -14.42, lng: 31.02, population: 2200, hub: false },
  { id: 19, name: 'Nyanje', lat: -14.42, lng: 31.74, population: 2000, hub: false },
  { id: 20, name: 'Mtaya', lat: -14.1, lng: 31.82, population: 1500, hub: false },
  { id: 21, name: 'Kacholola', lat: -14.76, lng: 30.63, population: 1700, hub: false },
  { id: 22, name: 'Chipembe', lat: -14.68, lng: 30.95, population: 1300, hub: false },
  { id: 23, name: 'Egichikeni', lat: -12.45, lng: 33.08, population: 1900, hub: false },
  { id: 24, name: 'Mwase', lat: -12.1, lng: 33.3, population: 2100, hub: false },
  { id: 25, name: 'Kanyanga', lat: -12.38, lng: 33.36, population: 1600, hub: false },
  { id: 26, name: 'Zingalume', lat: -13.93, lng: 32.6, population: 1800, hub: false },
  { id: 27, name: 'Naviruli', lat: -14.2, lng: 32.5, population: 1400, hub: false },
  { id: 28, name: 'Kakumbi', lat: -13.1, lng: 31.72, population: 2300, hub: false },
  { id: 29, name: 'Jumbe', lat: -13.3, lng: 31.92, population: 1900, hub: false },
  { id: 30, name: 'Msoro', lat: -13.57, lng: 31.78, population: 2000, hub: false },
  { id: 31, name: 'Kapata', lat: -13.7, lng: 32.72, population: 3500, hub: false },
  { id: 32, name: 'Mwami', lat: -13.76, lng: 32.78, population: 2800, hub: false },
  { id: 33, name: 'Mkanda', lat: -13.48, lng: 32.6, population: 2200, hub: false },
  { id: 34, name: 'Mlolo', lat: -14.1, lng: 32.95, population: 1200, hub: false },
  { id: 35, name: 'Chikwa', lat: -11.55, lng: 32.95, population: 1500, hub: false },
  { id: 36, name: 'Mapamba', lat: -11.0, lng: 33.3, population: 1300, hub: false },
  { id: 37, name: 'Chasefu', lat: -12.62, lng: 32.85, population: 1700, hub: false },
  { id: 38, name: 'Lumezi Mission', lat: -12.9, lng: 32.9, population: 1500, hub: false },
  { id: 39, name: 'Chimtende', lat: -14.3, lng: 32.3, population: 1400, hub: false },
  { id: 40, name: 'Kamoto', lat: -13.0, lng: 31.6, population: 1600, hub: false },
];

// Keep identical to STOCK_ITEMS in src/lib/triage/supplies.ts.
const ITEMS = [
  'Malaria rapid test', 'Antimalarial (ACT)', 'Rectal artesunate', 'Amoxicillin', 'Ceftriaxone (pre-referral)',
  'Oral rehydration salts', 'Zinc', 'Paracetamol', 'Salbutamol inhaler', 'Oxygen cylinder', 'Aspirin', 'Glucose gel',
  'Wound dressing kit', 'Tetanus vaccine', 'IV fluids', 'Blood (O negative)', 'Therapeutic food (RUTF)', 'Splint',
  'Malaria vaccine (R21)', 'Measles-rubella vaccine', 'Pentavalent vaccine', 'PCV vaccine', 'Rotavirus vaccine', 'Polio vaccine (OPV)', 'BCG vaccine', 'HPV vaccine',
];
const HEAVY = new Set(['Oxygen cylinder', 'IV fluids']); // by road, not drone
const HUB_ONLY = new Set(['Oxygen cylinder', 'IV fluids', 'Blood (O negative)']); // posts don't keep these
// What every post should always hold (one patient's worth is 1). Zero for hub-only items.
const MIN_STOCK: Record<string, number> = {
  'Malaria rapid test': 6, 'Antimalarial (ACT)': 4, 'Rectal artesunate': 2, 'Amoxicillin': 4, 'Ceftriaxone (pre-referral)': 2,
  'Oral rehydration salts': 6, 'Zinc': 4, 'Paracetamol': 6, 'Salbutamol inhaler': 1, 'Aspirin': 2, 'Glucose gel': 2,
  'Wound dressing kit': 3, 'Tetanus vaccine': 2, 'Therapeutic food (RUTF)': 7, 'Splint': 2,
  'Malaria vaccine (R21)': 4, 'Measles-rubella vaccine': 4, 'Pentavalent vaccine': 4, 'PCV vaccine': 4, 'Rotavirus vaccine': 3, 'Polio vaccine (OPV)': 4, 'BCG vaccine': 2, 'HPV vaccine': 2,
};
const VACCINE_ITEMS = new Set(['Malaria vaccine (R21)', 'Measles-rubella vaccine', 'Pentavalent vaccine', 'PCV vaccine', 'Rotavirus vaccine', 'Polio vaccine (OPV)', 'BCG vaccine', 'HPV vaccine', 'Tetanus vaccine']);

// Zambia's routine schedule (simplified): dose code, age it is due (months), the stock item.
// Keep identical to SCHEDULE in src/lib/vaccines.ts.
const SCHEDULE: { code: string; label: string; months: number; item: string; who?: 'girl' | 'pregnant' }[] = [
  { code: 'BCG', label: 'BCG', months: 0, item: 'BCG vaccine' },
  { code: 'OPV0', label: 'Polio 0', months: 0, item: 'Polio vaccine (OPV)' },
  { code: 'OPV1', label: 'Polio 1', months: 1.5, item: 'Polio vaccine (OPV)' },
  { code: 'PENTA1', label: 'Pentavalent 1', months: 1.5, item: 'Pentavalent vaccine' },
  { code: 'PCV1', label: 'PCV 1', months: 1.5, item: 'PCV vaccine' },
  { code: 'ROTA1', label: 'Rotavirus 1', months: 1.5, item: 'Rotavirus vaccine' },
  { code: 'OPV2', label: 'Polio 2', months: 2.5, item: 'Polio vaccine (OPV)' },
  { code: 'PENTA2', label: 'Pentavalent 2', months: 2.5, item: 'Pentavalent vaccine' },
  { code: 'PCV2', label: 'PCV 2', months: 2.5, item: 'PCV vaccine' },
  { code: 'ROTA2', label: 'Rotavirus 2', months: 2.5, item: 'Rotavirus vaccine' },
  { code: 'OPV3', label: 'Polio 3', months: 3.5, item: 'Polio vaccine (OPV)' },
  { code: 'PENTA3', label: 'Pentavalent 3', months: 3.5, item: 'Pentavalent vaccine' },
  { code: 'PCV3', label: 'PCV 3', months: 3.5, item: 'PCV vaccine' },
  { code: 'R21-1', label: 'Malaria (R21) 1', months: 5, item: 'Malaria vaccine (R21)' },
  { code: 'R21-2', label: 'Malaria (R21) 2', months: 6, item: 'Malaria vaccine (R21)' },
  { code: 'R21-3', label: 'Malaria (R21) 3', months: 7, item: 'Malaria vaccine (R21)' },
  { code: 'MR1', label: 'Measles-rubella 1', months: 9, item: 'Measles-rubella vaccine' },
  { code: 'MR2', label: 'Measles-rubella 2', months: 18, item: 'Measles-rubella vaccine' },
  { code: 'R21-4', label: 'Malaria (R21) booster', months: 18, item: 'Malaria vaccine (R21)' },
  { code: 'HPV', label: 'HPV (girls, 14 y)', months: 168, item: 'HPV vaccine', who: 'girl' },
  { code: 'TT1', label: 'Tetanus (pregnancy) 1', months: 0, item: 'Tetanus vaccine', who: 'pregnant' },
  { code: 'TT2', label: 'Tetanus (pregnancy) 2', months: 0, item: 'Tetanus vaccine', who: 'pregnant' },
];

// A roster for the demo: infants mid-schedule, toddlers missing boosters, pregnant women, elders.
const PATIENTS = [
  { id: 1, name: 'Mwila Banda', villageId: 2, ageMonths: 6, sex: 'm', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3,R21-1', lastVisit: 'Fever 2 weeks ago, malaria negative' },
  { id: 2, name: 'Thandiwe Zulu', villageId: 2, ageMonths: 20, sex: 'f', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3,R21-1,R21-2,R21-3,MR1', lastVisit: 'Weighed last month, growing well' },
  { id: 3, name: 'Mercy Banda', villageId: 2, ageMonths: 360, sex: 'f', pregnant: true, notes: '2nd pregnancy, 24 weeks', vaccinesGiven: 'TT1', lastVisit: 'Antenatal visit 3 weeks ago' },
  { id: 4, name: 'Joseph Daka', villageId: 4, ageMonths: 660, sex: 'm', pregnant: false, notes: 'High blood pressure, on amlodipine', vaccinesGiven: '', lastVisit: 'Blood pressure check last month' },
  { id: 5, name: 'Chanda Phiri', villageId: 3, ageMonths: 2, sex: 'm', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1', lastVisit: 'Cough 1 week ago' },
  { id: 6, name: 'Agnes Phiri', villageId: 3, ageMonths: 336, sex: 'f', pregnant: false, notes: 'Mother of Chanda', vaccinesGiven: '', lastVisit: '' },
  { id: 7, name: 'Esther Lungu', villageId: 12, ageMonths: 9, sex: 'f', pregnant: false, notes: 'Low weight for age', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2', lastVisit: 'RUTF started 2 weeks ago' },
  { id: 8, name: 'Peter Ngoma', villageId: 7, ageMonths: 300, sex: 'm', pregnant: false, notes: 'Asthma', vaccinesGiven: '', lastVisit: 'Inhaler refill' },
  { id: 9, name: 'Grace Mwanza', villageId: 6, ageMonths: 336, sex: 'f', pregnant: true, notes: '1st pregnancy, 30 weeks', vaccinesGiven: '', lastVisit: 'First antenatal visit' },
  { id: 10, name: 'Ruth Sakala', villageId: 5, ageMonths: 348, sex: 'f', pregnant: false, notes: 'Mother of Precious', vaccinesGiven: '', lastVisit: '' },
  { id: 11, name: 'Precious Nyirenda', villageId: 5, ageMonths: 36, sex: 'f', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3,MR1', lastVisit: 'Diarrhea, ORS given' },
  { id: 12, name: 'Kondwani Mvula', villageId: 8, ageMonths: 7, sex: 'm', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3', lastVisit: 'Missed the 5-month visit' },
  { id: 13, name: 'Bwalya Mbewe', villageId: 2, ageMonths: 600, sex: 'm', pregnant: false, notes: 'Smoker', vaccinesGiven: '', lastVisit: '' },
  { id: 14, name: 'Mutale Tembo', villageId: 11, ageMonths: 168, sex: 'f', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,OPV2,PENTA2,PCV2,OPV3,PENTA3,PCV3,MR1,MR2', lastVisit: 'School health day' },
  { id: 15, name: 'Chileshe Mumba', villageId: 9, ageMonths: 1, sex: 'f', pregnant: false, notes: 'Born at home', vaccinesGiven: '', lastVisit: 'Not yet seen' },
  { id: 16, name: 'Natasha Chirwa', villageId: 10, ageMonths: 19, sex: 'f', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3,R21-1,R21-2,R21-3,MR1', lastVisit: 'Fever, malaria positive, treated' },
  { id: 17, name: 'Lackson Zimba', villageId: 10, ageMonths: 780, sex: 'm', pregnant: false, notes: 'Diabetes', vaccinesGiven: '', lastVisit: 'Glucose check' },
  { id: 18, name: 'Beatrice Nkhoma', villageId: 4, ageMonths: 264, sex: 'f', pregnant: true, notes: '3rd pregnancy, 12 weeks', vaccinesGiven: 'TT1,TT2', lastVisit: 'Antenatal booking' },
  { id: 19, name: 'Gift Mulenga', villageId: 7, ageMonths: 5, sex: 'm', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3', lastVisit: 'Weighed, well' },
  { id: 20, name: 'Memory Phiri', villageId: 12, ageMonths: 168, sex: 'f', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,OPV2,PENTA2,PCV2,OPV3,PENTA3,PCV3,MR1,MR2', lastVisit: '' },
  { id: 21, name: 'Isaac Mwale', villageId: 6, ageMonths: 10, sex: 'm', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3,R21-1,R21-2', lastVisit: 'Cough, settled' },
  { id: 22, name: 'Dorothy Soko', villageId: 8, ageMonths: 420, sex: 'f', pregnant: false, notes: 'HIV, on treatment', vaccinesGiven: '', lastVisit: 'ART refill' },
  { id: 23, name: 'Emmanuel Tembo', villageId: 11, ageMonths: 8, sex: 'm', pregnant: false, notes: '', vaccinesGiven: 'BCG,OPV0,OPV1,PENTA1,PCV1,ROTA1,OPV2,PENTA2,PCV2,ROTA2,OPV3,PENTA3,PCV3,R21-1', lastVisit: 'Missed the 6-month visit' },
  { id: 24, name: 'Violet Kunda', villageId: 9, ageMonths: 228, sex: 'f', pregnant: true, notes: '1st pregnancy, 36 weeks', vaccinesGiven: 'TT1', lastVisit: 'Antenatal visit' },
];

// Zambia's real last-mile fleet, by operator (sources in docs/ROUTES.md):
// - ZAMMSA (Zambia Medicines and Medical Supplies Agency) runs regional hubs, Chipata among them,
//   and trucks stock from the hub to district health offices and facilities; its last-mile
//   distribution has been contracted through the USAID PASCO programme (Chemonics tenders).
// - District Health Offices run the pickups (Land Cruiser / Hilux class) that reach rural posts.
// - Community Health Assistants ride motorbikes; Riders for Health ran the Eastern Province fleet
//   and its maintenance 2009-2016, the Ministry of Health keeps the model.
// - Community health workers ride bicycles (World Bicycle Relief's Buffalo bicycle programmes).
// - Banana boats cross the Luangwa where the rains cut posts off (Mambwe, Chama, Nyimba valley).
// - Drones: no drone fleet operates in Zambia today (a 2017 Ministry trial never went live), so
//   they are seeded as a proposed partner and only picked when nothing on the ground can go.
const CARRIERS = [
  { id: 1, name: 'ZAMMSA hub truck 1', kind: 'truck', operator: 'ZAMMSA', baseVillageId: 1, capacityKg: 3000, speedKmh: 50, costPerKm: 18 },
  { id: 2, name: 'ZAMMSA hub truck 2', kind: 'truck', operator: 'ZAMMSA', baseVillageId: 1, capacityKg: 3000, speedKmh: 50, costPerKm: 18 },
  { id: 3, name: 'ZAMMSA cold-chain van', kind: 'truck', operator: 'ZAMMSA', baseVillageId: 1, capacityKg: 1200, speedKmh: 55, costPerKm: 14 },
  { id: 10, name: 'DHO pickup Chipata', kind: 'pickup', operator: 'District Health Office Chipata', baseVillageId: 1, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 11, name: 'DHO pickup Katete', kind: 'pickup', operator: 'District Health Office Katete', baseVillageId: 2, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 12, name: 'DHO pickup Petauke', kind: 'pickup', operator: 'District Health Office Petauke', baseVillageId: 3, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 13, name: 'DHO pickup Sinda', kind: 'pickup', operator: 'District Health Office Sinda', baseVillageId: 4, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 14, name: 'DHO pickup Nyimba', kind: 'pickup', operator: 'District Health Office Nyimba', baseVillageId: 5, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 15, name: 'DHO pickup Lundazi', kind: 'pickup', operator: 'District Health Office Lundazi', baseVillageId: 6, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 16, name: 'DHO pickup Chadiza', kind: 'pickup', operator: 'District Health Office Chadiza', baseVillageId: 7, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 17, name: 'DHO pickup Mambwe', kind: 'pickup', operator: 'District Health Office Mambwe', baseVillageId: 8, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 18, name: 'DHO pickup Vubwi', kind: 'pickup', operator: 'District Health Office Vubwi', baseVillageId: 9, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 19, name: 'DHO pickup Chama', kind: 'pickup', operator: 'District Health Office Chama', baseVillageId: 10, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 20, name: 'DHO pickup Lumezi', kind: 'pickup', operator: 'District Health Office Lumezi', baseVillageId: 11, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 21, name: 'DHO pickup Kasenengwa', kind: 'pickup', operator: 'District Health Office Kasenengwa', baseVillageId: 12, capacityKg: 800, speedKmh: 60, costPerKm: 9 },
  { id: 30, name: 'CHA motorbike Katete', kind: 'motorbike', operator: 'CHA', baseVillageId: 2, capacityKg: 25, speedKmh: 45, costPerKm: 2.5 },
  { id: 31, name: 'CHA motorbike Petauke', kind: 'motorbike', operator: 'CHA', baseVillageId: 3, capacityKg: 25, speedKmh: 45, costPerKm: 2.5 },
  { id: 32, name: 'CHA motorbike Nyimba', kind: 'motorbike', operator: 'CHA', baseVillageId: 5, capacityKg: 25, speedKmh: 45, costPerKm: 2.5 },
  { id: 33, name: 'CHA motorbike Lundazi', kind: 'motorbike', operator: 'CHA', baseVillageId: 6, capacityKg: 25, speedKmh: 45, costPerKm: 2.5 },
  { id: 34, name: 'CHA motorbike Mfuwe', kind: 'motorbike', operator: 'CHA', baseVillageId: 8, capacityKg: 25, speedKmh: 45, costPerKm: 2.5 },
  { id: 35, name: 'CHA motorbike Chama', kind: 'motorbike', operator: 'CHA', baseVillageId: 10, capacityKg: 25, speedKmh: 45, costPerKm: 2.5 },
  { id: 36, name: 'CHA motorbike Chadiza', kind: 'motorbike', operator: 'CHA', baseVillageId: 7, capacityKg: 25, speedKmh: 45, costPerKm: 2.5 },
  { id: 40, name: 'CHW bicycle Mphangwe', kind: 'bicycle', operator: 'Community health worker (Buffalo bicycle)', baseVillageId: 13, capacityKg: 10, speedKmh: 12, costPerKm: 0.2 },
  { id: 41, name: 'CHW bicycle Minga', kind: 'bicycle', operator: 'Community health worker (Buffalo bicycle)', baseVillageId: 16, capacityKg: 10, speedKmh: 12, costPerKm: 0.2 },
  { id: 42, name: 'CHW bicycle Egichikeni', kind: 'bicycle', operator: 'Community health worker (Buffalo bicycle)', baseVillageId: 23, capacityKg: 10, speedKmh: 12, costPerKm: 0.2 },
  { id: 43, name: 'CHW bicycle Kakumbi', kind: 'bicycle', operator: 'Community health worker (Buffalo bicycle)', baseVillageId: 28, capacityKg: 10, speedKmh: 12, costPerKm: 0.2 },
  { id: 44, name: 'CHW bicycle Mwami', kind: 'bicycle', operator: 'Community health worker (Buffalo bicycle)', baseVillageId: 32, capacityKg: 10, speedKmh: 12, costPerKm: 0.2 },
  { id: 45, name: 'CHW bicycle Chikwa', kind: 'bicycle', operator: 'Community health worker (Buffalo bicycle)', baseVillageId: 35, capacityKg: 10, speedKmh: 12, costPerKm: 0.2 },
  { id: 50, name: 'Banana boat Mfuwe (Luangwa)', kind: 'boat', operator: 'District Health Office Mambwe', baseVillageId: 8, capacityKg: 300, speedKmh: 15, costPerKm: 6 },
  { id: 51, name: 'Banana boat Chama (Luangwa)', kind: 'boat', operator: 'District Health Office Chama', baseVillageId: 10, capacityKg: 300, speedKmh: 15, costPerKm: 6 },
  { id: 60, name: 'Drone 1 (proposed)', kind: 'drone', operator: 'proposed partner', baseVillageId: 1, capacityKg: 1.8, speedKmh: 100, costPerKm: 3 },
  { id: 61, name: 'Drone 2 (proposed)', kind: 'drone', operator: 'proposed partner', baseVillageId: 1, capacityKg: 1.8, speedKmh: 100, costPerKm: 3 },
];

// Doses are given one at a time per vaccine (four weeks apart): the earliest due dose of each.
function nextDoses(due: { code: string; label: string; months: number; item: string }[]) {
  const seen = new Set<string>();
  return due.filter((d) => (seen.has(d.item) ? false : (seen.add(d.item), true)));
}

const SEED_COMMUNITY = [
  { villageId: 2, name: 'Dorothy', role: 'volunteer', topic: 'Lost my husband in 2024; I know the long evenings. Happy to sit with anyone.' },
  { villageId: 2, name: 'Mutale', role: 'seeking', topic: 'Not sleeping, no interest in the field work since the floods.' },
  { villageId: 3, name: 'Agnes', role: 'volunteer', topic: 'Church choir leader; good listener, free on Sundays.' },
  { villageId: 6, name: 'Isaac', role: 'volunteer', topic: 'Retired teacher. Can walk to anyone in Lundazi.' },
  { villageId: 6, name: 'Violet', role: 'seeking', topic: 'First baby coming, far from my family, worried all the time.' },
  { villageId: 8, name: 'Peter', role: 'seeking', topic: 'Since the accident I stay inside. Would like someone to talk to.' },
];

function dueFor(p: { ageMonths: number; sex: string; pregnant: boolean; vaccinesGiven: string }) {
  const given = new Set(p.vaccinesGiven.split(',').map((s) => s.trim()).filter(Boolean));
  return SCHEDULE.filter((d) => {
    if (given.has(d.code)) return false;
    if (d.who === 'pregnant') return p.pregnant;
    if (d.who === 'girl') return p.sex === 'f' && p.ageMonths >= d.months && p.ageMonths < 180;
    return p.ageMonths >= d.months && p.ageMonths < 60; // routine childhood doses only
  });
}
const MALARIA_ITEMS = new Set(['Malaria rapid test', 'Antimalarial (ACT)', 'Rectal artesunate']);
const DEMAND_WINDOW_US = 120_000_000n; // demo seconds that stand for "the last two weeks"
const AGENTS_EVERY_US = 10_000_000n;
const NAMES = ['Mwila Banda', 'Chanda Phiri', 'Thandiwe Zulu', 'Mutale Tembo', 'Bwalya Mbewe', 'Esther Lungu', 'Joseph Daka', 'Grace Mwanza', 'Peter Ngoma', 'Ruth Sakala', 'Kondwani Mvula', 'Precious Nyirenda'];
const SIM_NEEDS = [
  { summary: 'fever and chills, malaria suspected', items: ['Malaria rapid test', 'Antimalarial (ACT)'] },
  { summary: 'cough with fast breathing, pneumonia', items: ['Amoxicillin'] },
  { summary: 'diarrhea with some dehydration', items: ['Oral rehydration salts', 'Oral rehydration salts', 'Zinc'] },
  { summary: 'headache, no danger signs', items: ['Paracetamol'] },
  { summary: 'fever, malaria test', items: ['Malaria rapid test'] },
  { summary: 'child with severe malnutrition', items: ['Therapeutic food (RUTF)'] },
  { summary: 'cut needing cleaning', items: ['Wound dressing kit', 'Tetanus vaccine'] },
];

function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The real pattern in Zambia: a few posts sit on a big push of stock from last quarter while
// their neighbours have none. The allocator moves that idle stock before it asks the hub.
const IDLE_SURPLUS: Record<number, Record<string, number>> = {
  6: { 'Malaria rapid test': 30, 'Antimalarial (ACT)': 20, Paracetamol: 24 }, // Lundazi
  3: { 'Oral rehydration salts': 30, Zinc: 20, Amoxicillin: 16 }, // Petauke
};

function seed(ctx: any) {
  for (const v of VILLAGES) {
    ctx.db.village.insert(v);
    for (const item of ITEMS) {
      const qty = v.hub ? 500 : IDLE_SURPLUS[v.id]?.[item] ?? (HUB_ONLY.has(item) ? 0 : ctx.random.integerInRange(0, Math.max(1, Math.round((MIN_STOCK[item] ?? 3) * 0.8))));
      ctx.db.stock.insert({ id: 0n, villageId: v.id, item, qty });
    }
  }
  for (const p of PATIENTS) ctx.db.patient.insert(p);
  for (const c of CARRIERS) ctx.db.carrier.insert({ ...c, status: 'idle' });
  for (const m of SEED_COMMUNITY) ctx.db.communityMember.insert({ id: 0n, ...m, matchedWith: '', joinedAt: ctx.timestamp });
  ctx.db.settings.insert({ id: 1, simulate: false, simEverySeconds: 6, agents: false, lastAgentsRun: ctx.timestamp }); // nothing moves until a real pod visit, or the presenter switches the simulation / agents on
  ctx.db.tickTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
  log(ctx, 'Supply allocator', 0, 'Online. Watching stock at 39 posts against what pods are flagging.');
  log(ctx, 'Outbreak sentinel', 0, 'Online. Watching for case clusters by village.');
}

function stockRow(ctx: any, villageId: number, item: string) {
  return [...ctx.db.stock.villageId.filter(villageId)].find((s: any) => s.item === item);
}

function log(ctx: any, agent: string, villageId: number, text: string) {
  ctx.db.agentLog.insert({ id: 0n, at: ctx.timestamp, agent, villageId, text });
  const all = [...ctx.db.agentLog.iter()].sort((a: any, b: any) => Number(a.id - b.id));
  for (const old of all.slice(0, Math.max(0, all.length - 80))) ctx.db.agentLog.id.delete(old.id);
}

function short(name: string) {
  return name.replace(/ \(.*\)$/, '');
}

// The post a pod or patient names, loosely ("katete", "Chipata", "Mfuwe"). Katete when nothing matches.
// Exact name first (with or without the " (hub)" suffix, any case), so "Lumezi Mission" is
// Lumezi Mission and not Lumezi; the loose includes-match only when nothing is exact.
function matchVillage(ctx: any, villageName: string) {
  const key = villageName.trim().toLowerCase();
  if (!key) return undefined;
  const all = [...ctx.db.village.iter()];
  const exact = all.find((x: any) => x.name.toLowerCase() === key || short(x.name).toLowerCase() === key);
  if (exact) return exact;
  return all.find((x: any) => x.name.toLowerCase().includes(key) || key.includes(x.name.toLowerCase().split(' ')[0]));
}

function findVillage(ctx: any, villageName: string) {
  return matchVillage(ctx, villageName) ?? ctx.db.village.id.find(2);
}

// Same match, but 0 (the whole province) when the name is empty or matches nothing.
function villageIdOrNone(ctx: any, villageName: string): number {
  return matchVillage(ctx, villageName)?.id ?? 0;
}

function placeOrder(ctx: any, o: { visitId: bigint; kind: string; patientName: string; to: any; from: any; item: string; qty: number }) {
  const km = distanceKm(o.from, o.to);
  const mode = o.from.id === o.to.id ? 'walk' : HEAVY.has(o.item) ? 'road' : 'drone';
  // Drone 100 km/h straight line; truck 40 km/h on roads about 1.5× the straight distance.
  // On screen one second stands for one real minute, so a 70 km drone hop takes 42 s.
  const etaMinutes = Math.max(5, Math.round(mode === 'walk' ? 20 : mode === 'drone' ? (km / 100) * 60 : ((km * 1.5) / 40) * 60));
  const travelSeconds = Math.min(240, etaMinutes);
  ctx.db.deliveryOrder.insert({
    id: 0n, visitId: o.visitId, kind: o.kind, patientName: o.patientName, toVillageId: o.to.id, fromVillageId: o.from.id, item: o.item, qty: o.qty,
    mode, status: 'ordered', travelSeconds, etaMinutes, createdAt: ctx.timestamp, departedAt: undefined, deliveredAt: undefined,
  });
  return { mode, etaMinutes };
}

// Nearest place that actually has the item: the village itself first, then the hub, then others.
function sourceFor(ctx: any, home: any, item: string, qty: number) {
  const local = stockRow(ctx, home.id, item);
  if (local && local.qty >= qty) return home;
  return [...ctx.db.village.iter()]
    .filter((x: any) => x.id !== home.id && (stockRow(ctx, x.id, item)?.qty ?? 0) >= qty)
    .sort((a: any, b: any) => (b.hub ? 1 : 0) - (a.hub ? 1 : 0) || distanceKm(home, a) - distanceKm(home, b))[0];
}

// One patient, one or more flagged needs -> "+1" bubbles and orders to the patient's home.
function recordVisit(ctx: any, villageId: number, patientName: string, urgency: string, summary: string, needsIn: { item: string; qty: number }[], fromPod: boolean) {
  let needs = needsIn;
  const home = ctx.db.village.id.find(villageId);
  if (!home) throw new Error(`Unknown village ${villageId}`);
  const v = ctx.db.visit.insert({ id: 0n, villageId, patientName, urgency, summary, fromPod, createdAt: ctx.timestamp });
  if (urgency === 'red') ctx.db.pop.insert({ villageId, text: `🚨 ${patientName}: emergency`, kind: 'alert' });
  if (fromPod) log(ctx, 'Pod', villageId, `${short(home.name)}: ${patientName}, ${urgency.toUpperCase()} — ${summary}${needs.length ? ` → needs ${needs.map((n) => `${n.qty} ${n.item}`).join(', ')}` : ' → nothing needed'}`);
  // A known patient who is due a vaccine gets it with the same delivery.
  if (fromPod) {
    const profile = [...ctx.db.patient.iter()].find((p: any) => p.name.toLowerCase() === patientName.toLowerCase());
    const due = profile ? dueFor(profile) : [];
    if (due.length) {
      const next = nextDoses(due);
      for (const d of next) if (!needs.some((n) => n.item === d.item)) needs = [...needs, { item: d.item, qty: 1 }];
      log(ctx, 'Immunisation planner', villageId, `${patientName} is due ${next.map((d) => d.label).join(', ')} → added to this delivery.`);
    }
  }
  for (const need of needs) {
    ctx.db.pop.insert({ villageId, text: `+${need.qty} ${need.item}`, kind: 'need' });
    const from = sourceFor(ctx, home, need.item, need.qty);
    if (!from) {
      ctx.db.pop.insert({ villageId, text: `⚠ no ${need.item} anywhere`, kind: 'alert' });
      log(ctx, 'Supply allocator', villageId, `⚠ ${need.item} for ${patientName} (${short(home.name)}): none anywhere in the province.`);
      continue;
    }
    placeOrder(ctx, { visitId: v.id, kind: 'patient', patientName, to: home, from, item: need.item, qty: need.qty });
  }
}

// ---- Network agents ----

// Patient orders per village and item in the demand window, and what is already on its way.
function demandAndIncoming(ctx: any, now: bigint) {
  const demand = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const o of ctx.db.deliveryOrder.iter()) {
    const key = `${o.toVillageId}|${o.item}`;
    if (o.kind === 'patient' && now - o.createdAt.microsSinceUnixEpoch <= DEMAND_WINDOW_US) demand.set(key, (demand.get(key) ?? 0) + o.qty);
    if (o.kind === 'restock' && o.status !== 'delivered') incoming.set(key, (incoming.get(key) ?? 0) + o.qty);
  }
  return { demand, incoming };
}

function runAgents(ctx: any) {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const { demand, incoming } = demandAndIncoming(ctx, now);
  const villages = [...ctx.db.village.iter()];
  const posts = villages.filter((v: any) => !v.hub);
  const hub = villages.find((v: any) => v.hub);

  // Outbreak sentinel: 3+ malaria-type patients at one post in the window is a cluster.
  const hot = new Set<number>();
  for (const v of posts) {
    const malaria = demand.get(`${v.id}|Malaria rapid test`) ?? 0;
    if (malaria >= 3) {
      const near = posts.filter((x: any) => x.id !== v.id && distanceKm(x, v) <= 45);
      const recent = [...ctx.db.agentLog.iter()].some((l: any) => l.agent === 'Outbreak sentinel' && l.villageId === v.id && now - l.at.microsSinceUnixEpoch < DEMAND_WINDOW_US);
      if (!recent) {
        log(ctx, 'Outbreak sentinel', v.id, `${malaria} malaria patients at ${short(v.name)} this period → cluster. Pods in ${[v, ...near].map((x: any) => short(x.name)).join(', ')} ask about fever, chills and bed nets first; allocator holds 3× malaria stock there.`);
        ctx.db.pop.insert({ villageId: v.id, text: '⚠ malaria cluster', kind: 'alert' });
      }
      hot.add(v.id);
      for (const n of near) hot.add(n.id);
    }
  }

  // Immunisation planner: doses due in each village, by item.
  const dueByVillage = new Map<string, number>();
  for (const p of ctx.db.patient.iter()) for (const d of nextDoses(dueFor(p))) dueByVillage.set(`${p.villageId}|${d.item}`, (dueByVillage.get(`${p.villageId}|${d.item}`) ?? 0) + 1);

  // Community connector: pair each person seeking company with a free volunteer in the same village.
  for (const v of posts) {
    const members = [...ctx.db.communityMember.villageId.filter(v.id)];
    const freeVols = members.filter((m: any) => m.role === 'volunteer' && !m.matchedWith);
    for (const s of members.filter((m: any) => m.role === 'seeking' && !m.matchedWith)) {
      const vol = freeVols.shift();
      if (!vol) {
        log(ctx, 'Community connector', v.id, `${s.name} (${short(v.name)}) is waiting for a volunteer: none free in the village yet.`);
        break;
      }
      ctx.db.communityMember.id.update({ ...s, matchedWith: vol.name });
      ctx.db.communityMember.id.update({ ...vol, matchedWith: s.name });
      log(ctx, 'Community connector', v.id, `${short(v.name)}: ${vol.name} (volunteer) will meet ${s.name} this week; the health worker makes the introduction.`);
    }
  }

  // Supply allocator: every post should hold its minimum plus what it is actually using.
  for (const v of posts) {
    for (const item of ITEMS) {
      if (HUB_ONLY.has(item)) continue;
      const used = demand.get(`${v.id}|${item}`) ?? 0;
      const due = dueByVillage.get(`${v.id}|${item}`) ?? 0;
      let target = Math.max(MIN_STOCK[item] ?? 3, Math.ceil(used * 1.5), VACCINE_ITEMS.has(item) ? due + 1 : 0);
      if (hot.has(v.id) && MALARIA_ITEMS.has(item)) target *= 3;
      const have = stockRow(ctx, v.id, item)?.qty ?? 0;
      const onWay = incoming.get(`${v.id}|${item}`) ?? 0;
      const shortBy = target - have - onWay;
      if (shortBy <= 0) continue;
      // Redistribution first: a post that holds more than twice its target and is closer than the hub.
      const idle = posts
        .filter((x: any) => x.id !== v.id && (stockRow(ctx, x.id, item)?.qty ?? 0) >= 2 * (MIN_STOCK[item] ?? 3) + shortBy && distanceKm(x, v) < distanceKm(hub, v))
        .sort((a: any, b: any) => distanceKm(a, v) - distanceKm(b, v))[0];
      const from = idle ?? ((stockRow(ctx, hub.id, item)?.qty ?? 0) >= shortBy ? hub : null);
      if (!from) {
        log(ctx, 'Supply allocator', v.id, `⚠ ${short(v.name)} needs ${shortBy} ${item} and nobody in the province has it. Escalate to national stores.`);
        continue;
      }
      const { mode, etaMinutes } = placeOrder(ctx, { visitId: 0n, kind: 'restock', patientName: `${short(v.name)} health post`, to: v, from, item, qty: shortBy });
      ctx.db.pop.insert({ villageId: v.id, text: `+${shortBy} ${item} (restock)`, kind: 'restock' });
      const why = due && VACCINE_ITEMS.has(item) ? `${due} patient${due > 1 ? 's' : ''} due, has ${have}` : used ? `used ${used} this period, has ${have}` : `has ${have}, below the ${MIN_STOCK[item] ?? 3} every post must hold`;
      log(ctx, due && VACCINE_ITEMS.has(item) ? 'Immunisation planner' : 'Supply allocator', v.id, `${short(v.name)}: ${why}${hot.has(v.id) && MALARIA_ITEMS.has(item) ? ', cluster nearby' : ''} → ${shortBy} ${item} by ${mode} from ${short(from.name)}${idle ? ' (idle stock, closer than the hub)' : ''}, ~${etaMinutes} min.`);
    }
  }
}

export const init = spacetimedb.init((ctx) => {
  seed(ctx);
});

// Called by a pod at the end of a visit.
export const reportVisit = spacetimedb.reducer(
  { villageName: t.string(), patientName: t.string(), urgency: t.string(), summary: t.string(), needs: t.array(Need) },
  (ctx, { villageName, patientName, urgency, summary, needs }) => {
    const v = findVillage(ctx, villageName);
    recordVisit(ctx, v!.id, patientName || 'Patient', urgency, summary, needs, true);
  }
);

// The pod screen, every few seconds and on every change of what it is doing. One row per village;
// `tick` flips `online` off when the heartbeats stop. Status 'offline' is the screen closing.
export const podHeartbeat = spacetimedb.reducer(
  { villageName: t.string(), status: t.string(), step: t.string(), language: t.string() },
  (ctx, { villageName, status, step, language }) => {
    const v = findVillage(ctx, villageName);
    const online = status !== 'offline';
    const row = { villageId: v!.id, status, step, language, online, lastSeen: ctx.timestamp };
    const old = ctx.db.pod.villageId.find(v!.id);
    if (old) ctx.db.pod.villageId.update(row);
    else ctx.db.pod.insert(row);
    if (online && !old?.online) log(ctx, 'Pod', v!.id, `${short(v!.name)}: pod online.`);
    if (!online && old?.online) log(ctx, 'Pod', v!.id, `${short(v!.name)}: pod switched off.`);
  }
);

// The registry saving a visit: once when the patient finishes, again a few seconds later with the
// clean name, community and the doctor's handover note. Same id both times.
export const saveVisitRecord = spacetimedb.reducer({ record: VisitRecordIn }, (ctx, { record }) => {
  const { village, ...fields } = record;
  const v = findVillage(ctx, village || record.community);
  const row = { ...fields, villageId: v!.id, updatedAt: ctx.timestamp };
  if (ctx.db.visitRecord.id.find(record.id)) ctx.db.visitRecord.id.update(row);
  else ctx.db.visitRecord.insert(row);
});

// A patient used their community's words for things: count them, so every pod there can say them.
export const rememberWords = spacetimedb.reducer({ community: t.string(), words: t.array(Word) }, (ctx, { community, words }) => {
  const key = community.trim().toLowerCase();
  if (!key || !words.length) return;
  const v = [...ctx.db.village.iter()].find((x) => x.name.toLowerCase().includes(key) || key.includes(x.name.toLowerCase().split(' ')[0]));
  const villageId = v?.id ?? 0;
  const known = [...ctx.db.dialectWord.iter()].filter((d) => d.community === key);
  for (const { concept, word } of words) {
    if (!word) continue;
    const old = known.find((d) => d.concept === concept && d.word === word);
    if (old) ctx.db.dialectWord.id.update({ ...old, times: old.times + 1, heardAt: ctx.timestamp });
    else ctx.db.dialectWord.insert({ id: 0n, villageId, community: key, concept, word, times: 1, heardAt: ctx.timestamp });
  }
});

// From the profiles page: send everything this patient is due to their home.
export const orderVaccines = spacetimedb.reducer({ patientId: t.u32() }, (ctx, { patientId }) => {
  const p = ctx.db.patient.id.find(patientId);
  if (!p) return;
  const next = nextDoses(dueFor(p));
  if (!next.length) return;
  recordVisit(ctx, p.villageId, p.name, 'green', `vaccination: ${next.map((d) => d.label).join(', ')}`, next.map((d) => ({ item: d.item, qty: 1 })), true);
});

// A dose was given: record it on the profile.
export const recordDose = spacetimedb.reducer({ patientId: t.u32(), code: t.string() }, (ctx, { patientId, code }) => {
  const p = ctx.db.patient.id.find(patientId);
  if (!p) return;
  const given = new Set(p.vaccinesGiven.split(',').filter(Boolean));
  given.add(code);
  ctx.db.patient.id.update({ ...p, vaccinesGiven: [...given].join(',') });
});

// Someone opted in at the end of a visit (or on the community page).
export const joinCommunity = spacetimedb.reducer(
  { villageName: t.string(), name: t.string(), role: t.string(), topic: t.string() },
  (ctx, { villageName, name, role, topic }) => {
    const v = findVillage(ctx, villageName);
    const first = name.trim().split(' ')[0] || 'Someone';
    if ([...ctx.db.communityMember.villageId.filter(v!.id)].some((m) => m.name === first && m.role === role)) return;
    ctx.db.communityMember.insert({ id: 0n, villageId: v!.id, name: first, role, topic, matchedWith: '', joinedAt: ctx.timestamp });
    log(ctx, 'Community connector', v!.id, role === 'volunteer' ? `${first} (${short(v!.name)}) offered to volunteer: "${topic}"` : `${first} (${short(v!.name)}) would like company through a hard time.`);
  }
);

// The route planner (src/app/api/routes/plan) decided how an order travels. One plan per order:
// planning the same order again replaces the old plan, and counts as a re-route when the new
// reason says so (it starts with "Rerouted"). Marks the carrier out from the moment the order is
// already moving; otherwise `tick` does it when the order departs.
export const planRoute = spacetimedb.reducer(
  { orderId: t.u64(), carrierId: t.u32(), waypoints: t.string(), km: t.f64(), minutes: t.u32(), floodRisk: t.string(), reason: t.string() },
  (ctx, { orderId, carrierId, waypoints, km, minutes, floodRisk, reason }) => {
    const order = ctx.db.deliveryOrder.id.find(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    if (!ctx.db.carrier.id.find(carrierId)) throw new Error(`Unknown carrier ${carrierId}`);
    const old = [...ctx.db.routePlan.orderId.filter(orderId)];
    for (const p of old) ctx.db.routePlan.id.delete(p.id);
    // A carrier the order no longer uses goes back to idle unless something else of theirs is moving.
    for (const p of old) {
      if (p.carrierId === carrierId) continue;
      const c = ctx.db.carrier.id.find(p.carrierId);
      const busy = [...ctx.db.routePlan.iter()].some((q) => q.carrierId === p.carrierId && q.status === 'moving');
      if (c && c.status === 'out' && !busy) ctx.db.carrier.id.update({ ...c, status: 'idle' });
    }
    const rerouted = /^rerouted/i.test(reason.trim()) || (old.length > 0 && old.some((p) => p.carrierId !== carrierId || p.waypoints !== waypoints));
    const status = order.status === 'delivered' ? 'done' : order.status === 'on_the_way' ? 'moving' : rerouted ? 'rerouted' : 'planned';
    ctx.db.routePlan.insert({ id: 0n, orderId, carrierId, waypoints, km, minutes, floodRisk, status, reason, createdAt: ctx.timestamp });
    // The plan is the truth for how the order travels: the carrier decides drone vs road, and the
    // road time replaces the straight-line guess made when the order was created (unless it has
    // already left, when only the ETA shown is corrected so the mover doesn't jump).
    const carrier = ctx.db.carrier.id.find(carrierId)!;
    const mode = order.mode === 'walk' ? 'walk' : carrier.kind === 'drone' ? 'drone' : 'road';
    if (order.status === 'ordered') ctx.db.deliveryOrder.id.update({ ...order, mode, etaMinutes: minutes, travelSeconds: Math.min(240, Math.max(5, minutes)) });
    else if (order.mode !== mode) ctx.db.deliveryOrder.id.update({ ...order, mode, etaMinutes: minutes });
    if (order.status === 'on_the_way') {
      const c = ctx.db.carrier.id.find(carrierId);
      if (c && c.status !== 'down') ctx.db.carrier.id.update({ ...c, status: 'out' });
    }
  }
);

// The dispatch planner sends stock to a post: one restock order, no visit row. fromVillageId 0
// lets the module pick the source the allocator would: a post holding idle surplus that is
// nearer than the hub, else the hub. The stock leaves the source when the order departs (tick).
export const restock = spacetimedb.reducer(
  { toVillageId: t.u32(), fromVillageId: t.u32(), item: t.string(), qty: t.u32(), reason: t.string() },
  (ctx, { toVillageId, fromVillageId, item, qty, reason }) => {
    const to = ctx.db.village.id.find(toVillageId);
    if (!to) throw new Error(`Unknown village ${toVillageId}`);
    if (qty < 1) throw new Error('qty must be at least 1');
    let from: any;
    if (fromVillageId) {
      from = ctx.db.village.id.find(fromVillageId);
      if (!from) throw new Error(`Unknown village ${fromVillageId}`);
      if (from.id === to.id) throw new Error('source and destination are the same post');
    } else {
      const hub = [...ctx.db.village.iter()].find((v: any) => v.hub);
      if (!hub) throw new Error('No hub village');
      const idle = [...ctx.db.village.iter()]
        .filter((x: any) => !x.hub && x.id !== to.id && (stockRow(ctx, x.id, item)?.qty ?? 0) >= 2 * (MIN_STOCK[item] ?? 3) + qty && distanceKm(x, to) < distanceKm(hub, to))
        .sort((a: any, b: any) => distanceKm(a, to) - distanceKm(b, to))[0];
      from = idle ?? ((stockRow(ctx, hub.id, item)?.qty ?? 0) >= qty ? hub : undefined);
      if (!from) {
        log(ctx, 'Dispatch planner', to.id, `⚠ ${short(to.name)} needs ${qty} ${item} and nobody in the province has it. ${reason}`.trim());
        return;
      }
    }
    const { mode, etaMinutes } = placeOrder(ctx, { visitId: 0n, kind: 'restock', patientName: `${short(to.name)} health post`, to, from, item, qty });
    ctx.db.pop.insert({ villageId: to.id, text: `+${qty} ${item} (restock)`, kind: 'restock' });
    log(ctx, 'Dispatch planner', to.id, `${short(to.name)}: ${qty} ${item} by ${mode} from ${short(from.name)}, ~${etaMinutes} min. ${reason}`.trim());
  }
);

// Any agent outside the module (dispatcher, route planner, weather) writes a line to the same log
// the government view reads. Village 0 = the whole province.
export const logAgent = spacetimedb.reducer({ agent: t.string(), villageName: t.string(), text: t.string() }, (ctx, { agent, villageName, text }) => {
  log(ctx, agent || 'Agent', villageIdOrNone(ctx, villageName), text);
});

export const setSimulation = spacetimedb.reducer({ on: t.bool() }, (ctx, { on }) => {
  const s = ctx.db.settings.id.find(1);
  if (s) ctx.db.settings.id.update({ ...s, simulate: on });
});

export const setAgents = spacetimedb.reducer({ on: t.bool() }, (ctx, { on }) => {
  const s = ctx.db.settings.id.find(1);
  if (s) ctx.db.settings.id.update({ ...s, agents: on });
  log(ctx, 'Supply allocator', 0, on ? 'Automatic allocation switched on by the provincial office.' : 'Automatic allocation paused by the provincial office; plans wait for approval.');
});

// The provincial office presses "allocate now".
export const allocate = spacetimedb.reducer((ctx) => {
  runAgents(ctx);
  const s = ctx.db.settings.id.find(1);
  if (s) ctx.db.settings.id.update({ ...s, lastAgentsRun: ctx.timestamp });
});

export const resetDemo = spacetimedb.reducer((ctx) => {
  for (const o of [...ctx.db.deliveryOrder.iter()]) ctx.db.deliveryOrder.id.delete(o.id);
  for (const v of [...ctx.db.visit.iter()]) ctx.db.visit.id.delete(v.id);
  for (const s of [...ctx.db.stock.iter()]) ctx.db.stock.id.delete(s.id);
  for (const v of [...ctx.db.village.iter()]) ctx.db.village.id.delete(v.id);
  for (const l of [...ctx.db.agentLog.iter()]) ctx.db.agentLog.id.delete(l.id);
  for (const p of [...ctx.db.patient.iter()]) ctx.db.patient.id.delete(p.id);
  for (const m of [...ctx.db.communityMember.iter()]) ctx.db.communityMember.id.delete(m.id);
  for (const s of [...ctx.db.settings.iter()]) ctx.db.settings.id.delete(s.id);
  for (const r of [...ctx.db.visitRecord.iter()]) ctx.db.visitRecord.id.delete(r.id);
  for (const p of [...ctx.db.pod.iter()]) ctx.db.pod.villageId.delete(p.villageId); // open pods come back on their next heartbeat
  for (const r of [...ctx.db.routePlan.iter()]) ctx.db.routePlan.id.delete(r.id);
  for (const c of [...ctx.db.carrier.iter()]) ctx.db.carrier.id.delete(c.id); // re-seeded idle at their bases
  for (const tm of [...ctx.db.tickTimer.iter()]) ctx.db.tickTimer.scheduledId.delete(tm.scheduledId);
  seed(ctx); // `dialect_word` stays: what a community calls things is knowledge, not demo state
});

// Every second: move orders along, pods that went quiet, a background patient now and then, the
// agents every 10 s.
export const tick = spacetimedb.reducer({ onSchedule: tickTimer }, { timer: tickTimer.rowType }, (ctx) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const p of [...ctx.db.pod.iter()]) {
    if (p.online && now - p.lastSeen.microsSinceUnixEpoch > POD_OFFLINE_AFTER_US) {
      ctx.db.pod.villageId.update({ ...p, online: false, status: 'offline', step: '', language: '' });
      const v = ctx.db.village.id.find(p.villageId);
      if (v) log(ctx, 'Pod', p.villageId, `${short(v.name)}: pod stopped answering (no heartbeat for 20 s).`);
    }
  }
  for (const o of [...ctx.db.deliveryOrder.iter()]) {
    if (o.status === 'ordered' && now - o.createdAt.microsSinceUnixEpoch > 2_000_000n) {
      const src = stockRow(ctx, o.fromVillageId, o.item);
      if (src) ctx.db.stock.id.update({ ...src, qty: src.qty - o.qty });
      ctx.db.deliveryOrder.id.update({ ...o, status: 'on_the_way', departedAt: ctx.timestamp });
      // The planned pathway (if the route planner made one) starts moving with its carrier.
      for (const p of ctx.db.routePlan.orderId.filter(o.id)) {
        ctx.db.routePlan.id.update({ ...p, status: 'moving' });
        const c = ctx.db.carrier.id.find(p.carrierId);
        if (c && c.status === 'idle') ctx.db.carrier.id.update({ ...c, status: 'out' });
      }
    } else if (o.status === 'on_the_way' && o.departedAt && now - o.departedAt.microsSinceUnixEpoch > BigInt(o.travelSeconds) * 1_000_000n) {
      ctx.db.deliveryOrder.id.update({ ...o, status: 'delivered', deliveredAt: ctx.timestamp });
      for (const p of ctx.db.routePlan.orderId.filter(o.id)) {
        ctx.db.routePlan.id.update({ ...p, status: 'done' });
        const c = ctx.db.carrier.id.find(p.carrierId);
        // Back to idle once no other order of theirs is still moving.
        const busy = [...ctx.db.routePlan.iter()].some((q) => q.id !== p.id && q.carrierId === p.carrierId && q.status === 'moving');
        if (c && c.status === 'out' && !busy) ctx.db.carrier.id.update({ ...c, status: 'idle' });
      }
      if (o.kind === 'restock') {
        const dst = stockRow(ctx, o.toVillageId, o.item);
        if (dst) ctx.db.stock.id.update({ ...dst, qty: dst.qty + o.qty });
        ctx.db.pop.insert({ villageId: o.toVillageId, text: `📦 ${o.qty} ${o.item} → post restocked`, kind: 'delivered' });
      } else {
        ctx.db.pop.insert({ villageId: o.toVillageId, text: `📦 ${o.item} → ${o.patientName}'s home`, kind: 'delivered' });
      }
    }
  }
  const s = ctx.db.settings.id.find(1);
  if (!s) return;
  if (s.simulate && ctx.random.integerInRange(1, s.simEverySeconds) === 1) {
    const villages = [...ctx.db.village.iter()].filter((v) => !v.hub);
    const v = villages[ctx.random.integerInRange(0, villages.length - 1)];
    const pick = SIM_NEEDS[ctx.random.integerInRange(0, SIM_NEEDS.length - 1)];
    const counts = new Map<string, number>();
    for (const item of pick.items) counts.set(item, (counts.get(item) ?? 0) + 1);
    const needs = [...counts].map(([item, qty]) => ({ item, qty }));
    const name = NAMES[ctx.random.integerInRange(0, NAMES.length - 1)];
    const urgency = ctx.random.integerInRange(1, 12) === 1 ? 'red' : 'yellow';
    recordVisit(ctx, v.id, name, urgency, pick.summary, needs, false);
  }
  if (s.agents && now - s.lastAgentsRun.microsSinceUnixEpoch >= AGENTS_EVERY_US) {
    runAgents(ctx);
    ctx.db.settings.id.update({ ...s, lastAgentsRun: ctx.timestamp });
  }
});
