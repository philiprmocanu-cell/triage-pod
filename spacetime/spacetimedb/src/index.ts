// Pod network database (SpacetimeDB). Zambia, Eastern Province: medicines exist at the regional
// hub, but village health posts run out because distribution is poor.
//
// Pods call `reportVisit` when a patient is triaged. Every need the pod flags becomes a delivery
// order addressed to that patient's home: from the village post if it has stock, otherwise from
// the hub (drone if light enough, truck if not). A scheduled `tick` moves orders along and can
// generate background patients from other villages, so the map stays alive during a demo.
// Clients subscribe to everything; `pop` is an event table for the "+1" bubbles on the globe.

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
    visitId: t.u64(),
    patientName: t.string(),
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
    kind: t.string(), // need | delivered | alert
  }
);

const settings = table(
  { name: 'settings', public: true },
  {
    id: t.u32().primaryKey(),
    simulate: t.bool(),
    simEverySeconds: t.u32(),
  }
);

const tickTimer = table(
  { name: 'tick_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({ village, stock, visit, deliveryOrder, pop, settings, tickTimer });
export default spacetimedb;

const Need = t.object('Need', { item: t.string(), qty: t.u32() });

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
];

const ITEMS = ['Amoxicillin', 'Malaria rapid test', 'Antimalarial (ACT)', 'Oral rehydration salts', 'Zinc', 'Paracetamol', 'Oxygen cylinder', 'Therapeutic food (RUTF)'];
const HEAVY = new Set(['Oxygen cylinder']);
const NAMES = ['Mwila Banda', 'Chanda Phiri', 'Thandiwe Zulu', 'Mutale Tembo', 'Bwalya Mbewe', 'Esther Lungu', 'Joseph Daka', 'Grace Mwanza', 'Peter Ngoma', 'Ruth Sakala', 'Kondwani Mvula', 'Precious Nyirenda'];
const SIM_NEEDS = [
  ['Malaria rapid test', 'Antimalarial (ACT)'],
  ['Amoxicillin'],
  ['Oral rehydration salts', 'Zinc'],
  ['Paracetamol'],
  ['Malaria rapid test'],
  ['Therapeutic food (RUTF)'],
];

function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function seed(ctx: any) {
  for (const v of VILLAGES) {
    ctx.db.village.insert(v);
    for (const item of ITEMS) {
      const qty = v.hub ? 500 : item === 'Oxygen cylinder' ? 0 : ctx.random.integerInRange(0, 6);
      ctx.db.stock.insert({ id: 0n, villageId: v.id, item, qty });
    }
  }
  ctx.db.settings.insert({ id: 1, simulate: true, simEverySeconds: 6 });
  ctx.db.tickTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
}

function stockRow(ctx: any, villageId: number, item: string) {
  return [...ctx.db.stock.villageId.filter(villageId)].find((s: any) => s.item === item);
}

// One patient, one or more flagged needs -> "+1" bubbles and orders to the patient's home.
function recordVisit(ctx: any, villageId: number, patientName: string, urgency: string, summary: string, needs: { item: string; qty: number }[], fromPod: boolean) {
  const home = ctx.db.village.id.find(villageId);
  if (!home) throw new Error(`Unknown village ${villageId}`);
  const v = ctx.db.visit.insert({ id: 0n, villageId, patientName, urgency, summary, fromPod, createdAt: ctx.timestamp });
  if (urgency === 'red') ctx.db.pop.insert({ villageId, text: `🚨 ${patientName}: emergency`, kind: 'alert' });
  for (const need of needs) {
    ctx.db.pop.insert({ villageId, text: `+${need.qty} ${need.item}`, kind: 'need' });
    // Nearest place that actually has it: the village post first, then the hub.
    const local = stockRow(ctx, villageId, need.item);
    let from = home;
    if (!local || local.qty < need.qty) {
      from = [...ctx.db.village.iter()]
        .filter((x: any) => x.id !== villageId && (stockRow(ctx, x.id, need.item)?.qty ?? 0) >= need.qty)
        .sort((a: any, b: any) => (b.hub ? 1 : 0) - (a.hub ? 1 : 0) || distanceKm(home, a) - distanceKm(home, b))[0];
      if (!from) {
        ctx.db.pop.insert({ villageId, text: `⚠ no ${need.item} anywhere`, kind: 'alert' });
        continue;
      }
    }
    const km = distanceKm(from, home);
    const mode = from.id === villageId ? 'walk' : HEAVY.has(need.item) ? 'road' : 'drone';
    const etaMinutes = Math.max(5, Math.round(mode === 'walk' ? 20 : mode === 'drone' ? (km / 100) * 60 : ((km * 1.5) / 40) * 60));
    const travelSeconds = mode === 'walk' ? 4 : Math.min(14, Math.max(5, Math.round(km / 12)));
    ctx.db.deliveryOrder.insert({
      id: 0n, visitId: v.id, patientName, toVillageId: villageId, fromVillageId: from.id, item: need.item, qty: need.qty,
      mode, status: 'ordered', travelSeconds, etaMinutes, createdAt: ctx.timestamp, departedAt: undefined, deliveredAt: undefined,
    });
  }
}

export const init = spacetimedb.init((ctx) => {
  seed(ctx);
});

// Called by a pod at the end of a visit.
export const reportVisit = spacetimedb.reducer(
  { villageName: t.string(), patientName: t.string(), urgency: t.string(), summary: t.string(), needs: t.array(Need) },
  (ctx, { villageName, patientName, urgency, summary, needs }) => {
    const key = villageName.toLowerCase();
    const v = [...ctx.db.village.iter()].find((x) => x.name.toLowerCase().includes(key) || key.includes(x.name.toLowerCase().split(' ')[0])) ?? ctx.db.village.id.find(2);
    recordVisit(ctx, v!.id, patientName || 'Patient', urgency, summary, needs, true);
  }
);

export const setSimulation = spacetimedb.reducer({ on: t.bool() }, (ctx, { on }) => {
  const s = ctx.db.settings.id.find(1);
  if (s) ctx.db.settings.id.update({ ...s, simulate: on });
});

export const resetDemo = spacetimedb.reducer((ctx) => {
  for (const o of [...ctx.db.deliveryOrder.iter()]) ctx.db.deliveryOrder.id.delete(o.id);
  for (const v of [...ctx.db.visit.iter()]) ctx.db.visit.id.delete(v.id);
  for (const s of [...ctx.db.stock.iter()]) ctx.db.stock.id.delete(s.id);
  for (const v of [...ctx.db.village.iter()]) ctx.db.village.id.delete(v.id);
  for (const s of [...ctx.db.settings.iter()]) ctx.db.settings.id.delete(s.id);
  for (const tm of [...ctx.db.tickTimer.iter()]) ctx.db.tickTimer.scheduledId.delete(tm.scheduledId);
  seed(ctx);
});

// Every second: move orders along, and (if on) a background patient somewhere every few seconds.
export const tick = spacetimedb.reducer({ onSchedule: tickTimer }, { timer: tickTimer.rowType }, (ctx) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const o of [...ctx.db.deliveryOrder.iter()]) {
    if (o.status === 'ordered' && now - o.createdAt.microsSinceUnixEpoch > 2_000_000n) {
      const src = stockRow(ctx, o.fromVillageId, o.item);
      if (src) ctx.db.stock.id.update({ ...src, qty: src.qty - o.qty });
      ctx.db.deliveryOrder.id.update({ ...o, status: 'on_the_way', departedAt: ctx.timestamp });
    } else if (o.status === 'on_the_way' && o.departedAt && now - o.departedAt.microsSinceUnixEpoch > BigInt(o.travelSeconds) * 1_000_000n) {
      ctx.db.deliveryOrder.id.update({ ...o, status: 'delivered', deliveredAt: ctx.timestamp });
      ctx.db.pop.insert({ villageId: o.toVillageId, text: `📦 ${o.item} → ${o.patientName}'s home`, kind: 'delivered' });
    }
  }
  const s = ctx.db.settings.id.find(1);
  if (s?.simulate && ctx.random.integerInRange(1, s.simEverySeconds) === 1) {
    const villages = [...ctx.db.village.iter()].filter((v) => !v.hub);
    const v = villages[ctx.random.integerInRange(0, villages.length - 1)];
    const needs = SIM_NEEDS[ctx.random.integerInRange(0, SIM_NEEDS.length - 1)].map((item) => ({ item, qty: 1 }));
    const name = NAMES[ctx.random.integerInRange(0, NAMES.length - 1)];
    const urgency = ctx.random.integerInRange(1, 12) === 1 ? 'red' : 'yellow';
    recordVisit(ctx, v.id, name, urgency, 'background patient', needs, false);
  }
});
