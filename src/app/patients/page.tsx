"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";
import { ageText, dueFor, nextDoses, nextFor, SCHEDULE } from "@/lib/vaccines";

// Patient profiles the posts keep: who lives where, how old, pregnant or not, and exactly which
// vaccine dose each person is due. Live from SpacetimeDB; "Send" places the delivery like a pod visit.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";

type Patient = { id: number; name: string; villageId: number; ageMonths: number; sex: string; pregnant: boolean; notes: string; vaccinesGiven: string; lastVisit: string };
type Village = { id: number; name: string; hub: boolean };
type Visit = { villageId: number; patientName: string; urgency: string; summary: string; fromPod: boolean; createdAt: { microsSinceUnixEpoch: bigint } };
type Order = { patientName: string; item: string; qty: number; status: string; mode: string; etaMinutes: number };

export default function PatientsPage() {
  const connRef = useRef<DbConnection | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [villages, setVillages] = useState<Village[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [filterItem, setFilterItem] = useState<string | null>(null);
  const [filterVillage, setFilterVillage] = useState<number | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = (c: DbConnection) => {
      setPatients([...c.db.patient.iter()] as Patient[]);
      setVillages([...c.db.village.iter()] as Village[]);
      setVisits([...c.db.visit.iter()] as Visit[]);
      setOrders([...c.db.deliveryOrder.iter()] as Order[]);
    };
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setStatus("live");
        c.subscriptionBuilder()
          .onApplied(() => refresh(c))
          .subscribe(["SELECT * FROM patient", "SELECT * FROM village", "SELECT * FROM visit", "SELECT * FROM delivery_order"]);
        timer = setInterval(() => refresh(c), 1500);
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

  const vname = (id: number) => villages.find((v) => v.id === id)?.name.replace(/ \(.*\)$/, "") ?? `#${id}`;
  const conn = connRef.current;

  // Who is due what, summed per vaccine and per village (the planner agent uses the same counts).
  const due = useMemo(() => patients.map((p) => ({ p, due: nextDoses(dueFor(p)) })), [patients]);
  const byItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const { due: d } of due) for (const x of d) m.set(x.item, (m.get(x.item) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [due]);
  const shown = due.filter(({ p, due: d }) => (!filterItem || d.some((x) => x.item === filterItem)) && (!filterVillage || p.villageId === filterVillage));
  const groups = [...new Set(shown.map((x) => x.p.villageId))].sort((a, b) => vname(a).localeCompare(vname(b)));

  return (
    <div className="min-h-screen bg-[#060b14] text-slate-100">
      <header className="border-b border-sky-900/60 bg-gradient-to-r from-sky-950/60 via-[#060b14] to-[#060b14] px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-sky-400">Patient register · Eastern Province · Zambia</p>
            <h1 className="mt-1 text-2xl font-bold">Who is due what</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Every person the posts know, with the exact vaccine dose they are due on Zambia&apos;s schedule. A pod visit by a known patient adds their due dose to the same delivery; the immunisation planner keeps each post stocked for the people who live there.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`font-mono ${status === "live" ? "text-emerald-300" : "text-amber-300"}`}>● {status}</span>
            <Link href="/government" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">Government view</Link>
            <Link href="/globe" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">3D map</Link>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => setFilterItem(null)} className={`rounded-full border px-3 py-1 text-xs ${!filterItem ? "border-sky-400 bg-sky-900/50 text-sky-100" : "border-slate-700 bg-slate-900 text-slate-300"}`}>
            All · {due.filter((x) => x.due.length).length} people due something
          </button>
          {byItem.map(([item, n]) => (
            <button key={item} onClick={() => setFilterItem(filterItem === item ? null : item)} className={`rounded-full border px-3 py-1 text-xs ${filterItem === item ? "border-sky-400 bg-sky-900/50 text-sky-100" : "border-slate-700 bg-slate-900 text-slate-300"}`}>
              {item.replace(" vaccine", "")} · {n}
            </button>
          ))}
          <select value={filterVillage ?? ""} onChange={(e) => setFilterVillage(e.target.value ? Number(e.target.value) : null)} className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-300">
            <option value="">All villages</option>
            {villages.filter((v) => !v.hub).sort((a, b) => a.name.localeCompare(b.name)).map((v) => (
              <option key={v.id} value={v.id}>{v.name.replace(/ \(.*\)$/, "")}</option>
            ))}
          </select>
        </div>
      </header>

      <main className="space-y-6 p-6">
        {groups.map((vid) => (
          <section key={vid}>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-slate-400">🏘️ {vname(vid)}</h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.filter((x) => x.p.villageId === vid).map(({ p, due: d }) => {
                const mine = visits.filter((v) => v.patientName === p.name).sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch));
                const open = orders.filter((o) => o.patientName === p.name && o.status !== "delivered");
                const upcoming = nextFor(p);
                return (
                  <article key={p.id} className={`rounded-2xl border p-4 ${d.length ? "border-sky-800/70 bg-sky-950/20" : "border-slate-800 bg-slate-950/60"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-base font-semibold">{p.name}</p>
                        <p className="text-xs text-slate-400">
                          {ageText(p.ageMonths)} · {p.sex === "f" ? "female" : "male"}
                          {p.pregnant && <span className="ml-1 rounded bg-pink-900/60 px-1.5 py-0.5 text-[10px] text-pink-100">pregnant</span>}
                          {p.ageMonths < 60 && <span className="ml-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-100">under 5</span>}
                        </p>
                      </div>
                      <span className="text-2xl">{p.ageMonths < 24 ? "👶" : p.ageMonths < 180 ? "🧒" : p.pregnant ? "🤰" : p.ageMonths > 720 ? "🧓" : "🧑"}</span>
                    </div>
                    {p.notes && <p className="mt-2 text-xs text-slate-300">{p.notes}</p>}
                    <div className="mt-3">
                      <p className="text-[10px] uppercase tracking-wide text-slate-500">Vaccines due now</p>
                      {d.length ? (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {d.map((x) => (
                            <button key={x.code} onClick={() => conn?.reducers.recordDose({ patientId: p.id, code: x.code })} title={`Mark ${x.label} as given`} className="rounded-full border border-sky-500/60 bg-sky-900/40 px-2 py-0.5 text-xs text-sky-100 hover:bg-sky-800/60">
                              {x.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-emerald-300">Up to date{upcoming ? ` · next: ${upcoming.label} at ${upcoming.months} months` : ""}</p>
                      )}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <p className="text-[11px] text-slate-500">
                        {mine.length ? `${mine.length} visit${mine.length > 1 ? "s" : ""} · last: ${mine[0].summary}` : p.lastVisit || "no visits yet"}
                      </p>
                      {d.length > 0 && (
                        <button onClick={() => conn?.reducers.orderVaccines({ patientId: p.id })} disabled={open.length > 0} className="rounded-lg border border-emerald-600 bg-emerald-900/50 px-2.5 py-1 text-xs text-emerald-100 hover:bg-emerald-800/60 disabled:opacity-50">
                          {open.length ? `${open[0].mode} · ${open[0].etaMinutes} min` : "Send to their home"}
                        </button>
                      )}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-600">Given: {p.vaccinesGiven ? p.vaccinesGiven.split(",").length : 0} of {SCHEDULE.filter((s) => !s.who).length} routine doses</p>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        {!patients.length && <p className="font-mono text-sm text-slate-500">{status === "offline" ? "SpacetimeDB offline — run `spacetime start`" : "loading profiles…"}</p>}
      </main>
    </div>
  );
}
