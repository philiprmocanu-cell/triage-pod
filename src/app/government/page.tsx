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
const AGENT_TAG: Record<string, string> = { "Supply allocator": "ALLOC", "Outbreak sentinel": "SENTINEL", "Immunisation planner": "VACCINE", "Community connector": "CIRCLE", Pod: "POD" };
const AGENT_TONE: Record<string, string> = { "Outbreak sentinel": "t-alert", "Immunisation planner": "t-vax", "Community connector": "t-conn", Pod: "t-live" };

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
.t-need{--c:#fbbf24}.t-alert{--c:#ef4444}.t-live{--c:#c084fc}.t-agent{--c:#2dd4bf}.t-vax{--c:#60a5fa}.t-conn{--c:#f472b6}
.blink{animation:blink 1.2s steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}
`;
