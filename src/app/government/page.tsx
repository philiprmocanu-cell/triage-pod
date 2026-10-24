"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";
import { STOCK_ITEMS, treatsWith } from "@/lib/triage/supplies";

// The government view: what the Provincial Medical Office sees. Every post's shelf against what
// its pod is actually flagging, what the AI agents moved and why, and a Claude briefing that ends
// with the one decision a human must make. All of it live from SpacetimeDB.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";
const WINDOW_MS = 120_000; // the same "period" the allocator uses
const MIN_STOCK: Record<string, number> = {
  "Malaria rapid test": 6, "Antimalarial (ACT)": 4, "Rectal artesunate": 2, Amoxicillin: 4, "Ceftriaxone (pre-referral)": 2,
  "Oral rehydration salts": 6, Zinc: 4, Paracetamol: 6, "Salbutamol inhaler": 1, Aspirin: 2, "Glucose gel": 2,
  "Wound dressing kit": 3, "Tetanus vaccine": 2, "Therapeutic food (RUTF)": 7,
  "Malaria vaccine (R21)": 4, "Measles-rubella vaccine": 4, "Pentavalent vaccine": 4, "PCV vaccine": 4, "Rotavirus vaccine": 3, "Polio vaccine (OPV)": 4, "BCG vaccine": 2, "HPV vaccine": 2,
};
const HUB_ONLY = new Set(["Oxygen cylinder", "IV fluids", "Blood (O negative)"]);
const SHORT: Record<string, string> = {
  "Malaria rapid test": "mRDT", "Antimalarial (ACT)": "ACT", "Rectal artesunate": "Artesun.", Amoxicillin: "Amox", "Ceftriaxone (pre-referral)": "Ceftri.",
  "Oral rehydration salts": "ORS", Zinc: "Zinc", Paracetamol: "Para", "Salbutamol inhaler": "Salbut.", "Oxygen cylinder": "O₂", Aspirin: "Aspirin",
  "Glucose gel": "Glucose", "Wound dressing kit": "Dressing", "Tetanus vaccine": "Tetanus", "IV fluids": "IV", "Blood (O negative)": "Blood", "Therapeutic food (RUTF)": "RUTF",
  "Malaria vaccine (R21)": "R21 vx", "Measles-rubella vaccine": "MR vx", "Pentavalent vaccine": "Penta vx", "PCV vaccine": "PCV vx", "Rotavirus vaccine": "Rota vx", "Polio vaccine (OPV)": "OPV", "BCG vaccine": "BCG", "HPV vaccine": "HPV",
};

type Village = { id: number; name: string; population: number; hub: boolean };
type Row = { village: Village; cells: Record<string, { have: number; used: number; incoming: number; min: number }>; patients: number; red: number };
type LogLine = { id: bigint; agent: string; villageId: number; text: string; at: number };

export default function GovernmentPage() {
  const connRef = useRef<DbConnection | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [kpi, setKpi] = useState({ patients: 0, red: 0, needs: 0, met: 0, stockouts: 0, restocks: 0, redistributed: 0 });
  const [agents, setAgents] = useState(true);
  const [simulate, setSimulate] = useState(true);
  const [briefing, setBriefing] = useState<string | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [pickItem, setPickItem] = useState<string | null>(null);

  useEffect(() => {
    const refresh = (c: DbConnection) => {
      const now = Date.now();
      const villages = [...c.db.village.iter()] as Village[];
      const orders = [...c.db.deliveryOrder.iter()];
      const visits = [...c.db.visit.iter()];
      const stock = [...c.db.stock.iter()];
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
          return { village: v, cells, patients: mine.length, red: mine.filter((x) => x.urgency === "red").length };
        });
      setRows(rows);
      const patientOrders = orders.filter((o) => o.kind === "patient");
      const restocks = orders.filter((o) => o.kind === "restock");
      setKpi({
        patients: visits.length,
        red: visits.filter((v) => v.urgency === "red").length,
        needs: patientOrders.length,
        met: patientOrders.filter((o) => o.status === "delivered").length,
        stockouts: rows.filter((r) => !r.village.hub).flatMap((r) => Object.values(r.cells).filter((x) => x.min > 0 && x.have === 0)).length,
        restocks: restocks.length,
        redistributed: restocks.filter((o) => !villages.find((v) => v.id === o.fromVillageId)?.hub).length,
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
          .subscribe(["SELECT * FROM village", "SELECT * FROM stock", "SELECT * FROM visit", "SELECT * FROM delivery_order", "SELECT * FROM settings", "SELECT * FROM agent_log"]);
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
  const vname = (id: number) => rows.find((r) => r.village.id === id)?.village.name.replace(/ \(.*\)$/, "") ?? (id === 0 ? "Province" : `#${id}`);

  const askBriefing = async () => {
    setBriefingBusy(true);
    try {
      const state = {
        kpis: kpi,
        posts: rows
          .filter((r) => !r.village.hub)
          .map((r) => ({
            village: r.village.name,
            patients: r.patients,
            red: r.red,
            critical: Object.entries(r.cells).filter(([, c]) => c.min > 0 && c.have === 0).map(([item, c]) => `${item} (0 left, used ${c.used}, ${c.incoming} on the way)`),
            low: Object.entries(r.cells).filter(([, c]) => c.min > 0 && c.have > 0 && c.have < c.min).map(([item, c]) => `${item} ${c.have}/${c.min}`),
          })),
        agent_log: log.slice(0, 25).map((l) => `${l.agent}: ${l.text}`),
      };
      const r = await fetch("/api/government", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
      const d = await r.json();
      setBriefing(d.text ?? d.error ?? "No briefing");
    } finally {
      setBriefingBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#060b14] text-slate-100">
      <style>{CSS}</style>
      <header className="border-b border-emerald-900/60 bg-gradient-to-r from-emerald-950/70 via-[#060b14] to-[#060b14] px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-400">Provincial Health Office · Eastern Province · Zambia</p>
            <h1 className="mt-1 text-2xl font-bold">Supply command: stock vs. what pods are flagging</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Every village health post, every item it must hold, and what its pod actually asked for this period. The AI agents move stock before a post runs out and write down why.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`font-mono ${status === "live" ? "text-emerald-300" : "text-amber-300"}`}>● {status === "live" ? "live" : status}</span>
            <button onClick={() => conn?.reducers.setAgents({ on: !agents })} className={`rounded-lg border px-3 py-1.5 ${agents ? "border-emerald-600 bg-emerald-900/50 text-emerald-100" : "border-amber-600 bg-amber-900/40 text-amber-100"}`}>
              Agents: {agents ? "allocating automatically" : "paused, waiting for approval"}
            </button>
            <button onClick={() => conn?.reducers.allocate({})} className="rounded-lg border border-sky-600 bg-sky-900/40 px-3 py-1.5 text-sky-100 hover:bg-sky-800/50">
              Allocate now
            </button>
            <button onClick={() => conn?.reducers.setSimulation({ on: !simulate })} className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">
              {simulate ? "Pause other villages" : "Resume other villages"}
            </button>
            <button onClick={() => conn?.reducers.resetDemo({})} className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">
              Reset
            </button>
            <Link href="/globe" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">
              3D map
            </Link>
            <Link href="/patients" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">
              Patients &amp; vaccines
            </Link>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-7">
          <Kpi label="patients" value={kpi.patients} />
          <Kpi label="emergencies" value={kpi.red} tone="text-red-300" />
          <Kpi label="needs flagged" value={kpi.needs} tone="text-amber-300" />
          <Kpi label="needs met" value={kpi.needs ? `${Math.round((100 * kpi.met) / kpi.needs)}%` : "–"} tone="text-emerald-300" />
          <Kpi label="stock-outs now" value={kpi.stockouts} tone={kpi.stockouts ? "text-red-300" : "text-emerald-300"} />
          <Kpi label="restocks by agents" value={kpi.restocks} tone="text-sky-300" />
          <Kpi label="post → post" value={kpi.redistributed} tone="text-teal-300" />
        </div>
      </header>

      <main className="grid gap-4 p-6 xl:grid-cols-[1fr_26rem]">
        <section className="overflow-auto rounded-2xl border border-slate-800 bg-slate-950/60">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="sticky top-0 bg-slate-950 text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-3 py-2 text-left">Post</th>
                <th className="px-2 py-2 text-right">Pts</th>
                {STOCK_ITEMS.map((item) => (
                  <th key={item} className={`cursor-pointer px-1.5 py-2 text-center ${pickItem === item ? "text-sky-300" : ""}`} title={item} onClick={() => setPickItem(pickItem === item ? null : item)}>
                    {SHORT[item]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.village.id} className={`border-t border-slate-800/80 ${r.village.hub ? "bg-emerald-950/30" : ""}`}>
                  <td className="whitespace-nowrap px-3 py-1.5 font-medium">
                    {r.village.hub ? "🏥 " : "🏘️ "}
                    {r.village.name.replace(/ \(.*\)$/, "")}
                    {r.village.hub && <span className="ml-1 text-[10px] text-emerald-400">HUB</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">
                    {r.patients}
                    {r.red > 0 && <span className="ml-1 text-red-400">({r.red}🚨)</span>}
                  </td>
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
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-4 border-t border-slate-800 px-3 py-2 text-[11px] text-slate-400">
            <span><i className="sw out" /> none left</span>
            <span><i className="sw low" /> below what the post must hold</span>
            <span><i className="sw ok" /> enough</span>
            <span>−n used this period · +n on the way from the agents</span>
            {pickItem && <span className="text-sky-300">{pickItem} treats: {treatsWith(pickItem).join(", ") || "—"}</span>}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <section className="rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-4">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-400">Officer&apos;s briefing · Claude</p>
              <button onClick={askBriefing} disabled={briefingBusy} className="rounded-lg border border-emerald-600 bg-emerald-900/50 px-3 py-1 text-xs text-emerald-100 hover:bg-emerald-800/60 disabled:opacity-50">
                {briefingBusy ? "Writing…" : briefing ? "Refresh" : "Write the briefing"}
              </button>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-200">{briefing ?? "One paragraph: where the province stands, what the agents did, and the one decision you need to make today."}</p>
          </section>
          <section className="hud flex min-h-[28rem] flex-1 flex-col p-4">
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.25em] text-sky-300/90">
              <span className="blink mr-2 inline-block h-2 w-2 rounded-full bg-emerald-400 align-middle" />
              agent decisions // live
            </p>
            <div className="flex-1 space-y-1 overflow-auto">
              {log.map((l) => (
                <div key={String(l.id)} className={`feed ${l.agent === "Outbreak sentinel" ? "t-alert" : l.agent === "Pod" ? "t-live" : l.agent === "Immunisation planner" ? "t-vax" : l.text.startsWith("⚠") ? "t-need" : "t-agent"}`}>
                  <span className="stamp">
                    {new Date(l.at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    <br />
                    <b>{l.agent === "Supply allocator" ? "ALLOC" : l.agent === "Outbreak sentinel" ? "SENTINEL" : l.agent === "Immunisation planner" ? "VACCINE" : "POD"}</b>
                  </span>
                  <span className="msg">
                    {l.villageId ? <span className="text-slate-400">{vname(l.villageId)} · </span> : null}
                    {l.text}
                  </span>
                </div>
              ))}
              {!log.length && <p className="font-mono text-xs text-slate-500">no decisions yet…</p>}
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
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
.sw.out{background:rgba(239,68,68,.6)}.sw.low{background:rgba(251,191,36,.5)}.sw.ok{background:rgba(52,211,153,.4)}
.hud{background:linear-gradient(180deg,rgba(2,6,23,.82),rgba(2,6,23,.7));border:1px solid rgba(56,189,248,.25);border-radius:14px;position:relative;overflow:hidden}
.hud:before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 3px)}
.hud:after{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(56,189,248,.8),transparent)}
.feed{display:grid;grid-template-columns:4.2rem 1fr;gap:.5rem;align-items:start;padding:.4rem .6rem .4rem .7rem;border-left:2px solid var(--c);background:linear-gradient(90deg,color-mix(in srgb,var(--c) 14%,transparent),transparent 70%);font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e2e8f0}
.feed .stamp{color:color-mix(in srgb,var(--c) 85%,white);font-size:10px;letter-spacing:.04em;padding-top:1px}
.feed .msg{text-shadow:0 0 12px color-mix(in srgb,var(--c) 45%,transparent)}
.t-need{--c:#fbbf24}.t-alert{--c:#ef4444}.t-live{--c:#c084fc}.t-agent{--c:#2dd4bf}.t-vax{--c:#60a5fa}
.blink{animation:blink 1.2s steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}
`;
