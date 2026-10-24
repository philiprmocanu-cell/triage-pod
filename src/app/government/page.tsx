"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";
import { STOCK_ITEMS, treatsWith } from "@/lib/triage/supplies";
import { dueFor, nextDoses } from "@/lib/vaccines";

// The government view: what the Provincial Medical Office sees. Every one of the 40 sites on the
// map (39 health posts and the Chipata hub): its shelf against what its pod flagged, the satellite
// weather over it, who there is due a vaccine, what the AI agents moved and why, and a Claude
// briefing that ends with the one decision a human must make.
// Where each number comes from: stock, visits, orders, patients and the agents' log are live from
// SpacetimeDB (shelf counts are the demo database's seed, not a real inventory, and the page says
// so); weather is NASA POWER; the country facts are the World Bank. Nothing is simulated unless
// the presenter switches "simulated visits" on.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";
const WINDOW_MS = 120_000; // the same "period" the allocator uses
// Keep identical to MIN_STOCK in spacetime/spacetimedb/src/index.ts.
const MIN_STOCK: Record<string, number> = {
  "Malaria rapid test": 6, "Antimalarial (ACT)": 4, "Rectal artesunate": 2, Amoxicillin: 4, "Ceftriaxone (pre-referral)": 2,
  "Oral rehydration salts": 6, Zinc: 4, Paracetamol: 6, "Salbutamol inhaler": 1, Aspirin: 2, "Glucose gel": 2,
  "Wound dressing kit": 3, "Tetanus vaccine": 2, "Therapeutic food (RUTF)": 7, Splint: 2,
  "Malaria vaccine (R21)": 4, "Measles-rubella vaccine": 4, "Pentavalent vaccine": 4, "PCV vaccine": 4, "Rotavirus vaccine": 3, "Polio vaccine (OPV)": 4, "BCG vaccine": 2, "HPV vaccine": 2,
};
const HUB_ONLY = new Set(["Oxygen cylinder", "IV fluids", "Blood (O negative)"]);
const SHORT: Record<string, string> = {
  "Malaria rapid test": "mRDT", "Antimalarial (ACT)": "ACT", "Rectal artesunate": "Artesun.", Amoxicillin: "Amox", "Ceftriaxone (pre-referral)": "Ceftri.",
  "Oral rehydration salts": "ORS", Zinc: "Zinc", Paracetamol: "Para", "Salbutamol inhaler": "Salbut.", "Oxygen cylinder": "O₂", Aspirin: "Aspirin",
  "Glucose gel": "Glucose", "Wound dressing kit": "Dressing", "Tetanus vaccine": "Tetanus", "IV fluids": "IV", "Blood (O negative)": "Blood", "Therapeutic food (RUTF)": "RUTF", Splint: "Splint",
  "Malaria vaccine (R21)": "R21 vx", "Measles-rubella vaccine": "MR vx", "Pentavalent vaccine": "Penta vx", "PCV vaccine": "PCV vx", "Rotavirus vaccine": "Rota vx", "Polio vaccine (OPV)": "OPV", "BCG vaccine": "BCG", "HPV vaccine": "HPV",
};
// How each agent shows up in the decisions feed.
const AGENT_TAG: Record<string, string> = { "Supply allocator": "ALLOC", "Outbreak sentinel": "SENTINEL", "Immunisation planner": "VACCINE", "Community connector": "CIRCLE", "Dispatch planner": "DISPATCH", "Route planner": "ROUTE", Pod: "POD" };
const AGENT_TONE: Record<string, string> = { "Outbreak sentinel": "t-alert", "Immunisation planner": "t-vax", "Community connector": "t-conn", "Dispatch planner": "t-dispatch", Pod: "t-live" };
// The dispatch brain's priorities, in the order they are sent.
const PRIORITY_LABEL: Record<string, string> = { emergency: "Emergency", urgent: "Urgent", "pre-position": "Pre-position", routine: "Routine" };
const CARRIER_LABEL: Record<string, string> = { truck: "truck", pickup: "pickup", motorbike: "motorbike", bicycle: "bicycle", boat: "boat", drone: "drone", none: "no carrier" };

type Village = { id: number; name: string; population: number; hub: boolean };
type Cell = { have: number; used: number; incoming: number; min: number };
type Row = { village: Village; cells: Record<string, Cell>; patients: number; red: number; out: number; low: number; due: number };
type LogLine = { id: bigint; agent: string; villageId: number; text: string; at: number };
type SkyPost = { villageId: number; id: string; name: string; rain30Mm: number; lastYearRain30Mm: number | null; wettestDayMm: number; meanTempC: number; malariaRisk: "low" | "medium" | "high"; floodRisk: boolean; suspectDays: number };
type Sky = { posts: SkyPost[]; source: string; fetchedAt?: string };
type Stat = { value: number; year: string } | undefined;
type Zambia = { stats: { population?: Stat; ruralPct?: Stat; u5mr?: Stat; doctors?: Stat; malaria?: Stat } };
type DueRow = { villageId: number; people: { id: number; name: string; doses: string[] }[] };
type Pod = { villageId: number; status: string; step: string; language: string; online: boolean; lastSeenMs: number };
type Word = { id: bigint; villageId: number; community: string; concept: string; word: string; times: number };
// What the dispatch brain (src/lib/dispatch/plan.ts) returns.
type Shipment = {
  id: string; rank: number; toVillageId: number; toVillage: string; fromVillage: string;
  items: { item: string; qty: number; from?: string; why: string }[];
  kg: number; km: number; carrierKind: string; carrierName: string; etaMinutes: number | null;
  priority: "emergency" | "urgent" | "pre-position" | "routine"; sendBy: string; why: string[]; run: string | null; droneAlternative: string | null;
};
type DispatchPlan = {
  plannedAt: string; shipments: Shipment[];
  runs: { id: string; label: string; carrierName: string; posts: string[]; kg: number; km: number; minutes: number }[];
  emergency: { active: boolean; reasons: string[]; cutOffPosts: string[]; redVisitPosts: string[] };
  posts: { villageId: number; name: string; cutOffRisk: number; daysUntilCutOff: number | null; cutOffDate: string | null; cutOffReason: string | null; cutOffNow: boolean; malariaOutlook6w: "low" | "medium" | "high"; floodTodayLevel: string; flood14dLevel: string; rainNext14Mm: number; redVisitsOpen: number; outlookSource: string }[];
  counts: { emergency: number; urgent: number; "pre-position": number; routine: number; items: number; kg: number; posts: number };
  notes: string[]; weatherSource: string; carrierSource: "table" | "fallback";
};
type SendResult = { executed?: number; orders?: { id: number; item: string; qty: number; mode: string }[]; routed?: number; logged?: string; notes?: string[]; error?: string; failed?: { id: string; error: string }[] };
type PlannerLog = { lines: { id: number; at: string; village: string; text: string; where: "agent_log" | "file" }[] };

const short = (name: string) => name.replace(/ \(.*\)$/, "");
const POD_STATUS: Record<string, string> = { idle: "waiting for a patient", listening: "listening", thinking: "deciding", speaking: "speaking", offline: "offline" };

export default function GovernmentPage() {
  const connRef = useRef<DbConnection | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [due, setDue] = useState<DueRow[]>([]);
  const [pods, setPods] = useState<Pod[]>([]);
  const [words, setWords] = useState<Word[]>([]);
  const [kpi, setKpi] = useState({ patients: 0, red: 0, needs: 0, met: 0, stockouts: 0, restocks: 0, redistributed: 0, due: 0 });
  const [agents, setAgents] = useState(false); // the seed starts with the agents paused and nothing simulated
  const [simulate, setSimulate] = useState(false);
  const [briefing, setBriefing] = useState<string | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [pickItem, setPickItem] = useState<string | null>(null);
  const [sky, setSky] = useState<Sky | null>(null);
  const [skyAll, setSkyAll] = useState(false);
  const [zambia, setZambia] = useState<Zambia | null>(null);
  // The dispatch brain: its latest plan, the explanation, what the office ticked, what was sent.
  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [planBusy, setPlanBusy] = useState<"" | "plan" | "claude">("");
  const [planError, setPlanError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<{ text: string; by: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SendResult | null>(null);
  const [showAllShipments, setShowAllShipments] = useState(false);
  const [plannerLog, setPlannerLog] = useState<PlannerLog["lines"]>([]);

  const planNow = async (explain: "planner" | "claude" = "planner") => {
    setPlanBusy(explain === "claude" ? "claude" : "plan");
    setPlanError(null);
    try {
      const r = await fetch("/api/dispatch/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ explain }) });
      const d = (await r.json()) as { plan?: DispatchPlan; explanation?: string; explainedBy?: string; error?: string };
      if (!r.ok || !d.plan) throw new Error(d.error ?? `planner ${r.status}`);
      setPlan(d.plan);
      setExplanation({ text: d.explanation ?? "", by: d.explainedBy ?? "planner" });
      setPicked(new Set());
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Planning failed");
    } finally {
      setPlanBusy("");
    }
  };
  const send = async (body: { shipmentIds?: string[]; which?: "urgent" | "all" }) => {
    setSending(true);
    setSent(null);
    try {
      const r = await fetch("/api/dispatch/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setSent((await r.json()) as SendResult);
      await planNow(); // the plan after the sends: what is now on its way drops out
    } catch (err) {
      setSent({ error: err instanceof Error ? err.message : "Send failed" });
    } finally {
      setSending(false);
    }
  };
  const togglePick = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  // The brain plans as soon as the page opens, and its own log lines are read every few seconds.
  useEffect(() => {
    planNow();
    const readLog = () => fetch("/api/dispatch/log").then((r) => r.json()).then((d: PlannerLog) => setPlannerLog(d.lines ?? [])).catch(() => {});
    readLog();
    const id = setInterval(readLog, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context from outside the database: satellite weather (NASA POWER) and country facts (World Bank).
  useEffect(() => {
    fetch("/api/satellite").then((r) => r.json()).then((d: Sky) => setSky(d.posts ? d : { posts: [], source: "" })).catch(() => setSky({ posts: [], source: "" }));
    fetch("/api/deploy")
      .then((r) => r.json())
      .then((d: { countries?: ({ iso3: string } & Zambia)[] }) => setZambia(d.countries?.find((c) => c.iso3 === "ZMB") ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const refresh = (c: DbConnection) => {
      const now = Date.now();
      const villages = [...c.db.village.iter()] as Village[];
      const orders = [...c.db.deliveryOrder.iter()];
      const visits = [...c.db.visit.iter()];
      const stock = [...c.db.stock.iter()];
      // Who is due which dose, per village (the immunisation planner uses the same rule).
      const dueRows: DueRow[] = [];
      for (const p of c.db.patient.iter()) {
        const doses = nextDoses(dueFor(p)).map((d) => d.label);
        if (!doses.length) continue;
        const row = dueRows.find((d) => d.villageId === p.villageId) ?? (dueRows.push({ villageId: p.villageId, people: [] }), dueRows[dueRows.length - 1]);
        row.people.push({ id: p.id, name: p.name, doses });
      }
      const rows: Row[] = villages
        .sort((a, b) => Number(b.hub) - Number(a.hub) || a.name.localeCompare(b.name))
        .map((v) => {
          const cells: Row["cells"] = {};
          for (const item of STOCK_ITEMS) {
            const have = stock.find((s) => s.villageId === v.id && s.item === item)?.qty ?? 0;
            const used = orders.filter((o) => o.kind === "patient" && o.toVillageId === v.id && o.item === item && now - Number(o.createdAt.microsSinceUnixEpoch / BigInt(1000)) <= WINDOW_MS).reduce((n, o) => n + o.qty, 0);
            const incoming = orders.filter((o) => o.kind === "restock" && o.toVillageId === v.id && o.item === item && o.status !== "delivered").reduce((n, o) => n + o.qty, 0);
            cells[item] = { have, used, incoming, min: v.hub ? 0 : HUB_ONLY.has(item) ? 0 : (MIN_STOCK[item] ?? 3) };
          }
          const mine = visits.filter((x) => x.villageId === v.id);
          const kept = Object.values(cells).filter((x) => x.min > 0);
          return {
            village: v,
            cells,
            patients: mine.length,
            red: mine.filter((x) => x.urgency === "red").length,
            out: kept.filter((x) => x.have === 0).length,
            low: kept.filter((x) => x.have > 0 && x.have < x.min).length,
            due: dueRows.find((d) => d.villageId === v.id)?.people.length ?? 0,
          };
        });
      setRows(rows);
      setDue(dueRows.sort((a, b) => b.people.length - a.people.length));
      // The pods themselves: one heartbeat row per village that has run a pod, and the words each village taught it.
      setPods([...c.db.pod.iter()].map((p) => ({ villageId: p.villageId, status: p.status, step: p.step, language: p.language, online: p.online, lastSeenMs: Number(p.lastSeen.microsSinceUnixEpoch / BigInt(1000)) })).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenMs - a.lastSeenMs));
      setWords([...c.db.dialectWord.iter()].map((w) => ({ id: w.id, villageId: w.villageId, community: w.community, concept: w.concept, word: w.word, times: w.times })).sort((a, b) => b.times - a.times).slice(0, 24));
      const patientOrders = orders.filter((o) => o.kind === "patient");
      const restocks = orders.filter((o) => o.kind === "restock");
      setKpi({
        patients: visits.length,
        red: visits.filter((v) => v.urgency === "red").length,
        needs: patientOrders.length,
        met: patientOrders.filter((o) => o.status === "delivered").length,
        stockouts: rows.filter((r) => !r.village.hub).reduce((n, r) => n + r.out, 0),
        restocks: restocks.length,
        redistributed: restocks.filter((o) => !villages.find((v) => v.id === o.fromVillageId)?.hub).length,
        due: dueRows.reduce((n, d) => n + d.people.length, 0),
      });
      setLog(
        [...c.db.agentLog.iter()]
          .map((l) => ({ id: l.id, agent: l.agent, villageId: l.villageId, text: l.text, at: Number(l.at.microsSinceUnixEpoch / BigInt(1000)) }))
          .sort((a, b) => Number(b.id - a.id))
          .slice(0, 40),
      );
      const s = [...c.db.settings.iter()][0];
      if (s) {
        setAgents(s.agents);
        setSimulate(s.simulate);
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setStatus("live");
        c.subscriptionBuilder()
          .onApplied(() => refresh(c))
          .subscribe(["SELECT * FROM village", "SELECT * FROM stock", "SELECT * FROM visit", "SELECT * FROM delivery_order", "SELECT * FROM settings", "SELECT * FROM agent_log", "SELECT * FROM patient", "SELECT * FROM pod", "SELECT * FROM dialect_word"]);
        timer = setInterval(() => refresh(c), 1000);
      })
      .onConnectError(() => setStatus("offline"))
      .onDisconnect(() => setStatus("offline"))
      .build();
    connRef.current = conn;
    return () => {
      clearInterval(timer);
      conn.disconnect();
    };
  }, []);

  const conn = connRef.current;
  const vname = (id: number) => short(rows.find((r) => r.village.id === id)?.village.name ?? "") || (id === 0 ? "Province" : `#${id}`);
  const posts = rows.filter((r) => !r.village.hub);
  const podOf = (villageId: number) => pods.find((p) => p.villageId === villageId);
  const online = pods.filter((p) => p.online);
  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };

  // Satellite weather per post, by village id (by name if the API fell back to the simulator's list).
  const skyOf = useMemo(() => {
    const byId = new Map<number, SkyPost>(), byName = new Map<string, SkyPost>();
    for (const p of sky?.posts ?? []) {
      byId.set(p.villageId, p);
      byName.set(short(p.name).toLowerCase(), p);
    }
    return (v: Village) => byId.get(v.id) ?? byName.get(short(v.name).toLowerCase());
  }, [sky]);
  const skySummary = useMemo(() => {
    const all = (sky?.posts ?? []).filter((p) => rows.some((r) => r.village.id === p.villageId || short(r.village.name).toLowerCase() === short(p.name).toLowerCase()));
    const n = (k: SkyPost["malariaRisk"]) => all.filter((p) => p.malariaRisk === k).length;
    return { all, high: n("high"), medium: n("medium"), low: n("low"), flood: all.filter((p) => p.floodRisk).length, flagged: all.filter((p) => p.malariaRisk !== "low" || p.floodRisk) };
  }, [sky, rows]);

  const askBriefing = async () => {
    setBriefingBusy(true);
    try {
      const state = {
        kpis: kpi,
        posts: posts.map((r) => ({
          village: short(r.village.name),
          people: r.village.population,
          patients: r.patients,
          red: r.red,
          critical: Object.entries(r.cells).filter(([, c]) => c.min > 0 && c.have === 0).map(([item, c]) => `${item} (0 left, used ${c.used}, ${c.incoming} on the way)`),
          low: Object.entries(r.cells).filter(([, c]) => c.min > 0 && c.have > 0 && c.have < c.min).map(([item, c]) => `${item} ${c.have}/${c.min}`),
          vaccines_due: due.find((d) => d.villageId === r.village.id)?.people.map((p) => `${p.name}: ${p.doses.join(", ")}`) ?? [],
          satellite: (() => {
            const s = skyOf(r.village);
            return s ? `malaria risk ${s.malariaRisk} (${s.rain30Mm} mm rain in 30 days, preliminary; ${s.lastYearRain30Mm ?? "?"} mm same weeks last year), ${s.floodRisk ? "roads may flood" : "roads clear"}` : "no satellite data";
          })(),
        })),
        agent_log: log.slice(0, 25).map((l) => `${l.agent}: ${l.text}`),
        agents_on: agents,
      };
      const r = await fetch("/api/government", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
      const d = await r.json();
      setBriefing(d.text ?? d.error ?? "No briefing");
    } finally {
      setBriefingBusy(false);
    }
  };

  const fmtM = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n.toLocaleString());

  return (
    <div className="min-h-screen bg-[#060b14] text-slate-100">
      <style>{CSS}</style>
      <header className="border-b border-emerald-900/60 bg-gradient-to-r from-emerald-950/70 via-[#060b14] to-[#060b14] px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-400">Provincial Health Office · Eastern Province · Zambia</p>
            <h1 className="mt-1 text-2xl font-bold">Supply command: {rows.length ? `${posts.length} health posts and the Chipata hub` : "every health post"}, stock against what pods are flagging</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Every post, every item it must hold, what its pod asked for this period, the satellite weather over it and who there is due a vaccine. The AI agents move stock before a post runs out and write down why.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`font-mono ${status === "live" ? "text-emerald-300" : "text-amber-300"}`}>
              ● {status === "live" ? `SpacetimeDB live · ${online.length} pod${online.length === 1 ? "" : "s"} online` : status === "connecting" ? "connecting…" : "SpacetimeDB offline — run `spacetime start`"}
            </span>
            <button onClick={() => conn?.reducers.setAgents({ on: !agents })} className={`rounded-lg border px-3 py-1.5 ${agents ? "border-emerald-600 bg-emerald-900/50 text-emerald-100" : "border-amber-600 bg-amber-900/40 text-amber-100"}`}>
              Agents: {agents ? "allocating automatically" : "paused, waiting for the office"}
            </button>
            <button onClick={() => conn?.reducers.allocate({})} className="rounded-lg border border-sky-600 bg-sky-900/40 px-3 py-1.5 text-sky-100 hover:bg-sky-800/50">
              Allocate now
            </button>
            <button onClick={() => conn?.reducers.setSimulation({ on: !simulate })} className={`rounded-lg border px-3 py-1.5 ${simulate ? "border-amber-500 bg-amber-950/70 text-amber-200" : "border-slate-600 bg-slate-900 hover:bg-slate-800"}`}>
              Simulated visits: {simulate ? "on" : "off"}
            </button>
            <button onClick={() => conn?.reducers.resetDemo({})} className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">
              Reset
            </button>
            <Link href="/globe" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">
              Live map
            </Link>
            <Link href="/patients" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">
              Patients &amp; vaccines
            </Link>
          </div>
        </div>
        {zambia?.stats && (
          <p className="mt-3 text-xs text-slate-400">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Zambia, World Bank · </span>
            {zambia.stats.population && <span>{fmtM(zambia.stats.population.value)} people ({zambia.stats.population.year}) · </span>}
            {zambia.stats.ruralPct && <span>{Math.round(zambia.stats.ruralPct.value)}% rural ({zambia.stats.ruralPct.year}) · </span>}
            {zambia.stats.doctors && <span className="text-amber-200">{zambia.stats.doctors.value.toFixed(2)} doctors per 1,000 people ({zambia.stats.doctors.year}) · </span>}
            {zambia.stats.u5mr && <span>{Math.round(zambia.stats.u5mr.value)} under-five deaths per 1,000 births ({zambia.stats.u5mr.year}) · </span>}
            {zambia.stats.malaria && <span>{Math.round(zambia.stats.malaria.value)} malaria cases per 1,000 people at risk a year ({zambia.stats.malaria.year})</span>}
          </p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          <Kpi label="patients" value={kpi.patients} />
          <Kpi label="emergencies" value={kpi.red} tone="text-red-300" />
          <Kpi label="needs flagged" value={kpi.needs} tone="text-amber-300" />
          <Kpi label="needs met" value={kpi.needs ? `${Math.round((100 * kpi.met) / kpi.needs)}%` : "–"} tone="text-emerald-300" />
          <Kpi label="stock-outs now" value={kpi.stockouts} tone={kpi.stockouts ? "text-red-300" : "text-emerald-300"} />
          <Kpi label="restocks by agents" value={kpi.restocks} tone="text-sky-300" />
          <Kpi label="post → post" value={kpi.redistributed} tone="text-teal-300" />
          <Kpi label="people due a vaccine" value={kpi.due} tone="text-violet-300" />
        </div>
      </header>

      <main className="grid gap-4 p-6 xl:grid-cols-[1fr_26rem]">
        <section className="rounded-2xl border border-orange-900/60 bg-orange-950/10 p-4 xl:col-span-2">
          {plan?.emergency.active && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-red-500/70 bg-red-950/60 px-4 py-3">
              <span className="blink inline-block h-2.5 w-2.5 rounded-full bg-red-400" />
              <p className="text-sm font-bold uppercase tracking-wide text-red-200">Emergency mode</p>
              <p className="text-sm text-red-100">{plan.emergency.reasons.join("; ")}. Emergency shipments go first, by the fastest carrier that can reach the post; road carriers are not sent where the road is under water.</p>
            </div>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-orange-300">Dispatch · Chipata distribution centre</p>
              <p className="mt-1 max-w-3xl text-xs text-slate-400">
                A deterministic planner reads every post&apos;s shelf, the open visits, the six-week malaria outlook, the flood and cut-off forecast and the fleet, then ranks what to send: emergencies now, pre-positioning before roads close, routine top-ups batched into one run per area. Nothing moves until the office presses send.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button onClick={() => planNow()} disabled={!!planBusy || sending} className="rounded-lg border border-orange-500 bg-orange-900/50 px-3 py-1.5 text-orange-100 hover:bg-orange-800/60 disabled:opacity-50">
                {planBusy === "plan" ? "Planning…" : "Plan now"}
              </button>
              <button onClick={() => send({ which: "urgent" })} disabled={!plan || sending || !!planBusy || !(plan.counts.emergency + plan.counts.urgent)} className="rounded-lg border border-red-500 bg-red-900/50 px-3 py-1.5 text-red-100 hover:bg-red-800/60 disabled:opacity-50">
                {sending ? "Sending…" : `Send all urgent${plan ? ` (${plan.counts.emergency + plan.counts.urgent})` : ""}`}
              </button>
              <button onClick={() => send({ shipmentIds: [...picked] })} disabled={!picked.size || sending || !!planBusy} className="rounded-lg border border-sky-500 bg-sky-900/50 px-3 py-1.5 text-sky-100 hover:bg-sky-800/60 disabled:opacity-50">
                Send selected{picked.size ? ` (${picked.size})` : ""}
              </button>
              <button onClick={() => planNow("claude")} disabled={!!planBusy || sending || !plan} className="rounded-lg border border-emerald-600 bg-emerald-900/40 px-3 py-1.5 text-emerald-100 hover:bg-emerald-800/50 disabled:opacity-50">
                {planBusy === "claude" ? "Wording…" : "Explain in words (Claude)"}
              </button>
            </div>
          </div>
          {planError && <p className="mt-2 text-xs text-red-300">The planner could not run: {planError}</p>}
          {plan && (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
                <Kpi label="emergency" value={plan.counts.emergency} tone={plan.counts.emergency ? "text-red-300" : "text-slate-500"} />
                <Kpi label="urgent" value={plan.counts.urgent} tone={plan.counts.urgent ? "text-amber-300" : "text-slate-500"} />
                <Kpi label="pre-position" value={plan.counts["pre-position"]} tone={plan.counts["pre-position"] ? "text-sky-300" : "text-slate-500"} />
                <Kpi label="routine" value={plan.counts.routine} tone="text-slate-300" />
                <Kpi label="posts served" value={plan.counts.posts} />
                <Kpi label="units" value={plan.counts.items} />
                <Kpi label="kg" value={plan.counts.kg} />
                <Kpi label="batched runs" value={plan.runs.length} tone="text-teal-300" />
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-200">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">{explanation?.by === "claude" ? "In words · Claude" : "In words · the planner"} · </span>
                {explanation?.text}
              </p>

              <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_20rem]">
                <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/70">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="sticky top-0 bg-slate-950 text-[10px] uppercase tracking-wider text-slate-400">
                        <th className="px-2 py-2 text-left" title="Tick the shipments to send">
                          <input type="checkbox" aria-label="select every shipment shown" checked={picked.size > 0 && (showAllShipments ? plan.shipments : plan.shipments.slice(0, 12)).every((s) => picked.has(s.id))} onChange={(e) => setPicked(e.target.checked ? new Set((showAllShipments ? plan.shipments : plan.shipments.slice(0, 12)).map((s) => s.id)) : new Set())} />
                        </th>
                        <th className="px-2 py-2 text-left">#</th>
                        <th className="px-2 py-2 text-left">priority</th>
                        <th className="px-2 py-2 text-left">post</th>
                        <th className="px-2 py-2 text-left">what</th>
                        <th className="px-2 py-2 text-left">carrier</th>
                        <th className="px-2 py-2 text-left">send by</th>
                        <th className="px-2 py-2 text-right">time</th>
                        <th className="px-2 py-2 text-left">why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(showAllShipments ? plan.shipments : plan.shipments.slice(0, 12)).map((s) => (
                        <tr key={s.id} className={`border-t border-slate-800/80 align-top ${picked.has(s.id) ? "bg-sky-950/40" : ""}`}>
                          <td className="px-2 py-1.5"><input type="checkbox" aria-label={`send to ${s.toVillage}`} checked={picked.has(s.id)} onChange={() => togglePick(s.id)} /></td>
                          <td className="px-2 py-1.5 tabular-nums text-slate-400">{s.rank}</td>
                          <td className="px-2 py-1.5"><span className={`pr ${s.priority}`}>{PRIORITY_LABEL[s.priority]}</span></td>
                          <td className="whitespace-nowrap px-2 py-1.5 font-medium text-slate-100">
                            {s.toVillage}
                            {s.fromVillage !== "Chipata" && <span className="block text-[10px] text-teal-300">from {s.fromVillage}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-slate-200">
                            {s.items.map((i) => (
                              <span key={i.item} className="mr-1.5 inline-block whitespace-nowrap" title={i.why}>
                                {i.qty} {SHORT[i.item] ?? i.item}{i.from ? <span className="text-teal-300"> ({i.from})</span> : null}
                              </span>
                            ))}
                            <span className="block text-[10px] text-slate-500">{s.kg} kg</span>
                          </td>
                          <td className="px-2 py-1.5 text-slate-200">
                            <span className={`car ${s.carrierKind}`}>{CARRIER_LABEL[s.carrierKind] ?? s.carrierKind}</span>
                            <span className="block text-[10px] text-slate-400">{s.carrierName}{s.run ? ` · ${s.run.replace("run-", "run ")}` : ""}</span>
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-200">{s.priority === "emergency" || s.priority === "urgent" ? <span className="text-red-200">now</span> : s.sendBy}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-slate-300">{s.etaMinutes == null ? "–" : s.etaMinutes >= 90 ? `${Math.round(s.etaMinutes / 6) / 10} h` : `${s.etaMinutes} min`}</td>
                          <td className="min-w-[16rem] px-2 py-1.5 text-slate-400">
                            {s.why.map((w, i) => (
                              <span key={i} className="block">{w}</span>
                            ))}
                            {s.droneAlternative && <span className="block text-sky-300/80">{s.droneAlternative}</span>}
                          </td>
                        </tr>
                      ))}
                      {!plan.shipments.length && (
                        <tr><td colSpan={9} className="px-3 py-4 text-emerald-300">Nothing to send: every post holds its minimum, no roads are closing and no pod is waiting.</td></tr>
                      )}
                    </tbody>
                  </table>
                  {plan.shipments.length > 12 && (
                    <button onClick={() => setShowAllShipments(!showAllShipments)} className="w-full border-t border-slate-800 px-3 py-1.5 text-left text-[11px] text-orange-300 hover:bg-slate-900">
                      {showAllShipments ? "show the top 12 only" : `show all ${plan.shipments.length} shipments`}
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400">Roads: cut-off countdown</p>
                    <p className="mt-1 text-[11px] text-slate-500">From the weather outlook: the day the forecast rain or river may close each post&apos;s road, and the malaria outlook six weeks out.</p>
                    <div className="mt-2 max-h-56 space-y-1 overflow-auto">
                      {plan.posts.filter((p) => p.cutOffNow || p.daysUntilCutOff !== null).map((p) => (
                        <div key={p.villageId} className="flex items-baseline justify-between gap-2 text-xs" title={p.cutOffReason ?? ""}>
                          <span className="text-slate-200">{p.name}<span className="text-slate-500"> · malaria {p.malariaOutlook6w}</span></span>
                          <span className={`shrink-0 tabular-nums ${p.cutOffNow ? "text-red-300" : (p.daysUntilCutOff ?? 99) <= 3 ? "text-amber-300" : "text-sky-300"}`}>
                            {p.cutOffNow ? "cut off now" : `${p.daysUntilCutOff} d${p.cutOffDate ? ` · ${p.cutOffDate.slice(5)}` : ""}`}
                          </span>
                        </div>
                      ))}
                      {!plan.posts.some((p) => p.cutOffNow || p.daysUntilCutOff !== null) && (
                        <p className="text-xs text-emerald-300">No road closures in the forecast at any post. {plan.posts.filter((p) => p.malariaOutlook6w !== "low").length} posts have a raised malaria outlook, so their test and treatment targets are higher.</p>
                      )}
                    </div>
                  </div>
                  {plan.runs.length > 0 && (
                    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400">Batched runs</p>
                      <div className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
                        {plan.runs.map((r) => (
                          <p key={r.id} className="text-slate-300"><span className="text-slate-100">{r.label}</span> · {r.carrierName} · {r.posts.length} posts · {r.kg} kg · {r.km} km</p>
                        ))}
                      </div>
                    </div>
                  )}
                  {sent && (
                    <div className={`rounded-xl border p-3 text-xs ${sent.error ? "border-red-700 bg-red-950/40 text-red-200" : "border-emerald-800 bg-emerald-950/30 text-emerald-100"}`}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.2em]">Sent</p>
                      {sent.error ? <p className="mt-1">{sent.error}</p> : <p className="mt-1">{sent.executed} shipment{sent.executed === 1 ? "" : "s"} placed: {sent.orders?.length ?? 0} orders{sent.routed ? `, ${sent.routed} routed` : ""}; logged to {sent.logged === "agent_log" ? "the agents' log" : "data/dispatch.json"}.</p>}
                      {sent.notes?.map((n, i) => <p key={i} className="mt-1 text-slate-400">{n}</p>)}
                    </div>
                  )}
                  {(plan.notes.length > 0 || plannerLog.some((l) => l.where === "file")) && (
                    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-slate-400">
                      {plan.notes.slice(0, 5).map((n, i) => <p key={i}>{n}</p>)}
                      {plan.notes.length > 5 && <p>and {plan.notes.length - 5} more.</p>}
                      {plannerLog.filter((l) => l.where === "file").slice(0, 5).map((l) => <p key={l.id} className="text-orange-200/80">{l.village}: {l.text}</p>)}
                    </div>
                  )}
                  <p className="text-[10px] leading-relaxed text-slate-500">
                    Weather: {plan.weatherSource}. Carriers: {plan.carrierSource === "table" ? "the carrier table (ZAMMSA trucks, district pickups, CHA motorbikes, bicycles, Luangwa boats; drones are a proposed partner and never relied on)" : "the planner's own list of the real fleet until the carrier table is published"}. Planned {new Date(plan.plannedAt).toLocaleTimeString([], { hour12: false })}.
                  </p>
                </div>
              </div>
            </>
          )}
          {!plan && !planError && <p className="mt-3 font-mono text-xs text-slate-500">{planBusy ? "reading the shelves, the visits, the weather outlook and the fleet…" : "no plan yet"}</p>}
        </section>

        <section className="overflow-auto rounded-2xl border border-slate-800 bg-slate-950/60">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="sticky top-0 bg-slate-950 text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-3 py-2 text-left">Post</th>
                <th className="px-2 py-2 text-right" title="People served (seed data, approximate)">People</th>
                <th className="px-2 py-2 text-right" title="Patients seen, emergencies in brackets">Pts</th>
                <th className="px-2 py-2 text-center" title="Malaria risk from satellite rain and temperature (NASA POWER); 'flood' when a day of 40 mm+ may cut the road">Sky</th>
                <th className="px-2 py-2 text-right" title="People in this village due a vaccine dose">Vx due</th>
                <th className="px-2 py-2 text-right" title="Items the post must hold but has none of">Out</th>
                {STOCK_ITEMS.map((item) => (
                  <th key={item} className={`cursor-pointer px-1.5 py-2 text-center ${pickItem === item ? "text-sky-300" : ""}`} title={item} onClick={() => setPickItem(pickItem === item ? null : item)}>
                    {SHORT[item] ?? item}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = skyOf(r.village);
                return (
                  <tr key={r.village.id} className={`border-t border-slate-800/80 ${r.village.hub ? "bg-emerald-950/30" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-1.5 font-medium">
                      {(() => {
                        const p = podOf(r.village.id);
                        return p ? <span className={`pod ${p.online ? "on" : "off"}`} title={`pod ${p.online ? "online" : "offline"}: ${POD_STATUS[p.status] ?? p.status}${p.step ? `, ${p.step}` : ""}, seen ${ago(p.lastSeenMs)}`} /> : null;
                      })()}
                      {short(r.village.name)}
                      {r.village.hub && <span className="ml-1.5 rounded bg-emerald-900/70 px-1 py-0.5 text-[9px] uppercase tracking-wide text-emerald-300">hub</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{r.village.population.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">
                      {r.patients}
                      {r.red > 0 && <span className="ml-1 text-red-400">({r.red} red)</span>}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {s ? (
                        <span
                          className={`sky ${s.malariaRisk}`}
                          title={`${s.rain30Mm} mm rain in 30 days (preliminary; ${s.lastYearRain30Mm ?? "?"} mm same weeks last year), wettest day ${s.wettestDayMm} mm, mean ${s.meanTempC} °C`}
                        >
                          {s.malariaRisk}
                          {s.floodRisk ? " · flood" : ""}
                        </span>
                      ) : (
                        <span className="text-slate-600">{sky ? "–" : "…"}</span>
                      )}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.due ? "text-violet-300" : "text-slate-600"}`}>{r.village.hub ? "" : r.due}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.out ? "text-red-300" : "text-slate-600"}`}>{r.village.hub ? "" : r.out}</td>
                    {STOCK_ITEMS.map((item) => {
                      const c = r.cells[item] ?? { have: 0, used: 0, incoming: 0, min: 0 };
                      const level = r.village.hub || c.min === 0 ? "hub" : c.have === 0 ? "out" : c.have < c.min ? "low" : "ok";
                      return (
                        <td key={item} className={`cell ${level} ${pickItem === item ? "picked" : ""}`} title={`${item}: ${c.have} on the shelf, ${c.used} used this period, ${c.incoming} on the way, must hold ${c.min}`}>
                          <span className="have">{c.have}</span>
                          {c.used > 0 && <span className="used">−{c.used}</span>}
                          {c.incoming > 0 && <span className="in">+{c.incoming}</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={6 + STOCK_ITEMS.length} className="px-3 py-6 font-mono text-slate-500">
                    {status === "offline" ? "SpacetimeDB offline — run `spacetime start`, then reload." : "loading the 40 sites…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-800 px-3 py-2 text-[11px] text-slate-400">
            <span><i className="sw out" /> none left</span>
            <span><i className="sw low" /> below what the post must hold</span>
            <span><i className="sw ok" /> enough</span>
            <span>−n used this period · +n on the way from the agents</span>
            <span className="text-slate-500">Shelf counts are the demo database&apos;s seed, not a real inventory; the shortage pattern (full hub, empty posts) is Zambia&apos;s documented one.</span>
            {pickItem && <span className="text-sky-300">{pickItem} treats: {treatsWith(pickItem).join(", ") || "—"}</span>}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <section className="rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-4">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-400">Officer&apos;s briefing · Claude</p>
              <button onClick={askBriefing} disabled={briefingBusy || !rows.length} className="rounded-lg border border-emerald-600 bg-emerald-900/50 px-3 py-1 text-xs text-emerald-100 hover:bg-emerald-800/60 disabled:opacity-50">
                {briefingBusy ? "Writing…" : briefing ? "Refresh" : "Write the briefing"}
              </button>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-200">{briefing ?? "Five sentences from the live state: where the province stands, what is critically low and why, what the agents moved, any cluster, and the one decision you need to make today."}</p>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-slate-300">Pods · {online.length} online</p>
            <p className="mt-1 text-[11px] text-slate-500">Each pod reports a heartbeat: what it is doing and in which language. A green dot beside a post in the table means its pod is online now.</p>
            <div className="mt-2 space-y-1">
              {pods.map((p) => (
                <div key={p.villageId} className="flex items-baseline justify-between gap-2 text-xs">
                  <span>
                    <span className={`pod ${p.online ? "on" : "off"}`} />
                    <span className="font-medium text-slate-200">{vname(p.villageId)}</span>
                    <span className="text-slate-400"> · {p.online ? POD_STATUS[p.status] ?? p.status : "offline"}{p.step ? ` · ${p.step}` : ""}{p.language ? ` · ${p.language}` : ""}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-500">{ago(p.lastSeenMs)}</span>
                </div>
              ))}
              {!pods.length && <p className="text-xs text-slate-500">{rows.length ? "No pod has reported yet. Open one from the map (click a post, then 'Open the pod here')." : "waiting for the database…"}</p>}
            </div>
            {words.length > 0 && (
              <div className="mt-3 border-t border-slate-800 pt-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Words the villages taught the pod</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {words.map((w) => (
                    <span key={String(w.id)} className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-200" title={`${w.community}: "${w.word}" for ${w.concept}, heard ${w.times} time${w.times === 1 ? "" : "s"}`}>
                      {w.word} <span className="text-slate-500">= {w.concept.replace(/_en$/, "")} · {w.community}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-sky-900/70 bg-sky-950/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-sky-300">Satellite · last 30 days</p>
              {skySummary.all.length > 0 && (
                <button onClick={() => setSkyAll(!skyAll)} className="text-[11px] text-sky-300 hover:underline">
                  {skyAll ? "flagged posts only" : `all ${skySummary.all.length} posts`}
                </button>
              )}
            </div>
            {skySummary.all.length > 0 ? (
              <>
                <p className="mt-1 text-xs text-slate-300">
                  Malaria risk from rain and warm nights: <span className="text-red-300">{skySummary.high} high</span>, <span className="text-amber-300">{skySummary.medium} medium</span>, <span className="text-emerald-300">{skySummary.low} low</span>; roads may flood at {skySummary.flood} posts.
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Rain + warm nights now means malaria in 2–6 weeks; a 40 mm day cuts roads. The last weeks are NASA&apos;s preliminary run, so each row also shows the finished record for the same weeks last year.
                </p>
                <div className="mt-2 max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="sticky top-0 bg-[#07111c] text-[10px] uppercase tracking-wider text-slate-500">
                        <th className="py-1 text-left">post</th><th className="text-right">rain 30d</th><th className="text-right">last yr</th><th className="text-right">worst day</th><th className="text-right">temp</th><th className="text-right">malaria</th><th className="text-right">roads</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(skyAll ? skySummary.all : skySummary.flagged).map((p) => (
                        <tr key={p.villageId} className="border-t border-slate-800/60">
                          <td className="py-1">{short(p.name)}</td>
                          <td className="text-right tabular-nums">{p.rain30Mm} mm</td>
                          <td className="text-right tabular-nums text-slate-400">{p.lastYearRain30Mm == null ? "–" : `${p.lastYearRain30Mm} mm`}</td>
                          <td className="text-right tabular-nums">{p.wettestDayMm} mm</td>
                          <td className="text-right tabular-nums">{p.meanTempC}°</td>
                          <td className={`text-right ${p.malariaRisk === "high" ? "text-red-300" : p.malariaRisk === "medium" ? "text-amber-300" : "text-emerald-300"}`}>{p.malariaRisk}</td>
                          <td className={`text-right ${p.floodRisk ? "text-amber-300" : "text-slate-400"}`}>{p.floodRisk ? "flood risk" : "clear"}</td>
                        </tr>
                      ))}
                      {!skyAll && !skySummary.flagged.length && (
                        <tr><td colSpan={7} className="py-2 text-emerald-300">Nothing flagged: low malaria risk and open roads at every post.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{sky?.source}</p>
              </>
            ) : (
              <p className="mt-2 text-xs text-slate-500">{sky ? "No satellite data right now (NASA POWER did not answer and nothing is saved yet)." : "Loading satellite data from NASA POWER…"}</p>
            )}
          </section>

          <section className="rounded-2xl border border-violet-900/70 bg-violet-950/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-violet-300">Vaccines due · {kpi.due} people</p>
              <Link href="/patients" className="text-[11px] text-violet-300 hover:underline">profiles →</Link>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">From the patient register and Zambia&apos;s schedule. The immunisation planner keeps each post stocked for exactly these doses; a pod visit by a known patient adds the dose to the same delivery.</p>
            <div className="mt-2 max-h-64 space-y-1.5 overflow-auto">
              {due.map((d) => (
                <div key={d.villageId} className="rounded-lg bg-slate-900/60 px-2.5 py-1.5 text-xs">
                  <p className="font-medium text-slate-200">{vname(d.villageId)} <span className="text-slate-500">· {d.people.length}</span></p>
                  {d.people.map((p) => (
                    <p key={p.id} className="text-slate-400">{p.name}: <span className="text-violet-200">{p.doses.join(", ")}</span></p>
                  ))}
                </div>
              ))}
              {!due.length && <p className="text-xs text-slate-500">{rows.length ? "Everyone on the register is up to date." : "waiting for the register…"}</p>}
            </div>
          </section>

          <section className="hud flex min-h-[28rem] flex-1 flex-col p-4">
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.25em] text-sky-300/90">
              <span className="blink mr-2 inline-block h-2 w-2 rounded-full bg-emerald-400 align-middle" />
              agent decisions // live
            </p>
            <div className="flex-1 space-y-1 overflow-auto">
              {log.map((l) => (
                <div key={String(l.id)} className={`feed ${AGENT_TONE[l.agent] ?? (l.text.startsWith("⚠") ? "t-need" : "t-agent")}`}>
                  <span className="stamp">
                    {new Date(l.at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    <br />
                    <b>{AGENT_TAG[l.agent] ?? l.agent.toUpperCase()}</b>
                  </span>
                  <span className="msg">
                    {l.villageId ? <span className="text-slate-400">{vname(l.villageId)} · </span> : null}
                    {l.text}
                  </span>
                </div>
              ))}
              {!log.length && <p className="font-mono text-xs text-slate-500">no decisions yet: the first lines appear when a pod flags a need or the office presses Allocate now.</p>}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function Kpi({ label, value, tone = "text-white" }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
      <p className={`text-xl font-bold tabular-nums ${tone}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
    </div>
  );
}

const CSS = `
.cell{text-align:center;padding:4px 2px;font-variant-numeric:tabular-nums;position:relative;border-left:1px solid rgba(30,41,59,.6)}
.cell .have{font-weight:700}
.cell .used{display:block;font-size:9px;color:#fbbf24;line-height:1}
.cell .in{display:block;font-size:9px;color:#38bdf8;line-height:1}
.cell.out{background:rgba(239,68,68,.28);color:#fecaca}
.cell.low{background:rgba(251,191,36,.18);color:#fde68a}
.cell.ok{background:rgba(52,211,153,.10);color:#a7f3d0}
.cell.hub{color:#94a3b8}
.cell.picked{outline:1px solid #38bdf8}
.sky{display:inline-block;white-space:nowrap;border-radius:999px;padding:1px 7px;font-size:10px;border:1px solid}
.sky.low{color:#a7f3d0;border-color:rgba(52,211,153,.4)}
.sky.medium{color:#fde68a;border-color:rgba(251,191,36,.5)}
.sky.high{color:#fecaca;border-color:rgba(239,68,68,.6);background:rgba(239,68,68,.15)}
.pod{display:inline-block;width:7px;height:7px;border-radius:999px;margin-right:6px;vertical-align:middle;background:#475569}
.pod.on{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,.9)}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
.sw.out{background:rgba(239,68,68,.6)}.sw.low{background:rgba(251,191,36,.5)}.sw.ok{background:rgba(52,211,153,.4)}
.hud{background:linear-gradient(180deg,rgba(2,6,23,.82),rgba(2,6,23,.7));border:1px solid rgba(56,189,248,.25);border-radius:14px;position:relative;overflow:hidden}
.hud:before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 3px)}
.hud:after{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(56,189,248,.8),transparent)}
.feed{display:grid;grid-template-columns:4.2rem 1fr;gap:.5rem;align-items:start;padding:.4rem .6rem .4rem .7rem;border-left:2px solid var(--c);background:linear-gradient(90deg,color-mix(in srgb,var(--c) 14%,transparent),transparent 70%);font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e2e8f0}
.feed .stamp{color:color-mix(in srgb,var(--c) 85%,white);font-size:10px;letter-spacing:.04em;padding-top:1px}
.feed .msg{text-shadow:0 0 12px color-mix(in srgb,var(--c) 45%,transparent)}
.t-need{--c:#fbbf24}.t-alert{--c:#ef4444}.t-live{--c:#c084fc}.t-agent{--c:#2dd4bf}.t-vax{--c:#60a5fa}.t-conn{--c:#f472b6}.t-dispatch{--c:#fb923c}
.pr{display:inline-block;white-space:nowrap;border-radius:6px;padding:2px 7px;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid}
.pr.emergency{color:#fecaca;border-color:rgba(239,68,68,.7);background:rgba(239,68,68,.22)}
.pr.urgent{color:#fde68a;border-color:rgba(251,191,36,.6);background:rgba(251,191,36,.16)}
.pr.pre-position{color:#bae6fd;border-color:rgba(56,189,248,.6);background:rgba(56,189,248,.14)}
.pr.routine{color:#cbd5e1;border-color:rgba(148,163,184,.4);background:rgba(148,163,184,.1)}
.car{display:inline-block;white-space:nowrap;border-radius:999px;padding:1px 7px;font-size:10px;border:1px solid rgba(148,163,184,.35);color:#e2e8f0}
.car.truck{border-color:rgba(251,146,60,.6);color:#fed7aa}.car.pickup{border-color:rgba(251,191,36,.5);color:#fde68a}.car.motorbike{border-color:rgba(45,212,191,.5);color:#99f6e4}
.car.bicycle{border-color:rgba(134,239,172,.5);color:#bbf7d0}.car.boat{border-color:rgba(96,165,250,.6);color:#bfdbfe}.car.drone{border-color:rgba(192,132,252,.6);color:#e9d5ff}.car.none{border-color:rgba(239,68,68,.6);color:#fecaca}
.blink{animation:blink 1.2s steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}
`;
