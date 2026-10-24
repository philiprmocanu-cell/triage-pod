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

const tickTimer = table(
  { name: 'tick_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({ village, stock, visit, deliveryOrder, pop, agentLog, settings, tickTimer });
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

// Keep identical to STOCK_ITEMS in src/lib/triage/supplies.ts.
const ITEMS = [
  'Malaria rapid test', 'Antimalarial (ACT)', 'Rectal artesunate', 'Amoxicillin', 'Ceftriaxone (pre-referral)',
  'Oral rehydration salts', 'Zinc', 'Paracetamol', 'Salbutamol inhaler', 'Oxygen cylinder', 'Aspirin', 'Glucose gel',
  'Wound dressing kit', 'Tetanus vaccine', 'IV fluids', 'Blood (O negative)', 'Therapeutic food (RUTF)',
];
const HEAVY = new Set(['Oxygen cylinder', 'IV fluids']); // by road, not drone
const HUB_ONLY = new Set(['Oxygen cylinder', 'IV fluids', 'Blood (O negative)']); // posts don't keep these
// What every post should always hold (one patient's worth is 1). Zero for hub-only items.
const MIN_STOCK: Record<string, number> = {
  'Malaria rapid test': 6, 'Antimalarial (ACT)': 4, 'Rectal artesunate': 2, 'Amoxicillin': 4, 'Ceftriaxone (pre-referral)': 2,
  'Oral rehydration salts': 6, 'Zinc': 4, 'Paracetamol': 6, 'Salbutamol inhaler': 1, 'Aspirin': 2, 'Glucose gel': 2,
  'Wound dressing kit': 3, 'Tetanus vaccine': 2, 'Therapeutic food (RUTF)': 7,
};
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
  ctx.db.settings.insert({ id: 1, simulate: true, simEverySeconds: 6, agents: false, lastAgentsRun: ctx.timestamp }); // the officer switches the agents on
  ctx.db.tickTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
  log(ctx, 'Supply allocator', 0, 'Online. Watching stock at 11 posts against what pods are flagging.');
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

function placeOrder(ctx: any, o: { visitId: bigint; kind: string; patientName: string; to: any; from: any; item: string; qty: number }) {
  const km = distanceKm(o.from, o.to);
  const mode = o.from.id === o.to.id ? 'walk' : HEAVY.has(o.item) ? 'road' : 'drone';
  const etaMinutes = Math.max(5, Math.round(mode === 'walk' ? 20 : mode === 'drone' ? (km / 100) * 60 : ((km * 1.5) / 40) * 60));
  const travelSeconds = mode === 'walk' ? 4 : Math.min(14, Math.max(5, Math.round(km / 12)));
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
function recordVisit(ctx: any, villageId: number, patientName: string, urgency: string, summary: string, needs: { item: string; qty: number }[], fromPod: boolean) {
  const home = ctx.db.village.id.find(villageId);
  if (!home) throw new Error(`Unknown village ${villageId}`);
  const v = ctx.db.visit.insert({ id: 0n, villageId, patientName, urgency, summary, fromPod, createdAt: ctx.timestamp });
  if (urgency === 'red') ctx.db.pop.insert({ villageId, text: `🚨 ${patientName}: emergency`, kind: 'alert' });
  if (fromPod) log(ctx, 'Pod', villageId, `${short(home.name)}: ${patientName}, ${urgency.toUpperCase()} — ${summary}${needs.length ? ` → needs ${needs.map((n) => `${n.qty} ${n.item}`).join(', ')}` : ' → nothing needed'}`);
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

  // Supply allocator: every post should hold its minimum plus what it is actually using.
  for (const v of posts) {
    for (const item of ITEMS) {
      if (HUB_ONLY.has(item)) continue;
      const used = demand.get(`${v.id}|${item}`) ?? 0;
      let target = Math.max(MIN_STOCK[item] ?? 3, Math.ceil(used * 1.5));
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
      const why = used ? `used ${used} this period, has ${have}` : `has ${have}, below the ${MIN_STOCK[item] ?? 3} every post must hold`;
      log(ctx, 'Supply allocator', v.id, `${short(v.name)}: ${why}${hot.has(v.id) && MALARIA_ITEMS.has(item) ? ', cluster nearby' : ''} → ${shortBy} ${item} by ${mode} from ${short(from.name)}${idle ? ' (idle stock, closer than the hub)' : ''}, ~${etaMinutes} min.`);
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
    const key = villageName.toLowerCase();
    const v = [...ctx.db.village.iter()].find((x) => x.name.toLowerCase().includes(key) || key.includes(x.name.toLowerCase().split(' ')[0])) ?? ctx.db.village.id.find(2);
    recordVisit(ctx, v!.id, patientName || 'Patient', urgency, summary, needs, true);
  }
);

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
  for (const s of [...ctx.db.settings.iter()]) ctx.db.settings.id.delete(s.id);
  for (const tm of [...ctx.db.tickTimer.iter()]) ctx.db.tickTimer.scheduledId.delete(tm.scheduledId);
  seed(ctx);
});

// Every second: move orders along, a background patient now and then, the agents every 10 s.
export const tick = spacetimedb.reducer({ onSchedule: tickTimer }, { timer: tickTimer.rowType }, (ctx) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const o of [...ctx.db.deliveryOrder.iter()]) {
    if (o.status === 'ordered' && now - o.createdAt.microsSinceUnixEpoch > 2_000_000n) {
      const src = stockRow(ctx, o.fromVillageId, o.item);
      if (src) ctx.db.stock.id.update({ ...src, qty: src.qty - o.qty });
      ctx.db.deliveryOrder.id.update({ ...o, status: 'on_the_way', departedAt: ctx.timestamp });
    } else if (o.status === 'on_the_way' && o.departedAt && now - o.departedAt.microsSinceUnixEpoch > BigInt(o.travelSeconds) * 1_000_000n) {
      ctx.db.deliveryOrder.id.update({ ...o, status: 'delivered', deliveredAt: ctx.timestamp });
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
