"use client";

import { useEffect, useRef, useState } from "react";
import { DbConnection } from "@/module_bindings";

// Community circles: people going through a hard time, paired with volunteers from their own
// village (the Friendship Bench idea: trained lay listeners, not clinics). Members come from the
// end of pod visits (the pod asks everyone if they would volunteer) or from this page. Live from
// SpacetimeDB; the connector agent makes the pairs and logs why.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";

type Member = { id: bigint; villageId: number; name: string; role: string; topic: string; matchedWith: string; joinedAt: { microsSinceUnixEpoch: bigint } };
type Village = { id: number; name: string; hub: boolean };
type LogLine = { id: bigint; agent: string; villageId: number; text: string };

export default function CommunityPage() {
  const connRef = useRef<DbConnection | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [villages, setVillages] = useState<Village[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [form, setForm] = useState({ name: "", village: "Katete", role: "volunteer", topic: "" });

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = (c: DbConnection) => {
      setMembers([...c.db.communityMember.iter()] as Member[]);
      setVillages([...c.db.village.iter()] as Village[]);
      setLog(
        [...c.db.agentLog.iter()]
          .filter((l) => l.agent === "Community connector")
          .map((l) => ({ id: l.id, agent: l.agent, villageId: l.villageId, text: l.text }))
          .sort((a, b) => Number(b.id - a.id))
          .slice(0, 20),
      );
    };
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setStatus("live");
        c.subscriptionBuilder()
          .onApplied(() => refresh(c))
          .subscribe(["SELECT * FROM community_member", "SELECT * FROM village", "SELECT * FROM agent_log"]);
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
  const byVillage = [...new Set(members.map((m) => m.villageId))].sort((a, b) => vname(a).localeCompare(vname(b)));
  const seeking = members.filter((m) => m.role === "seeking");
  const volunteers = members.filter((m) => m.role === "volunteer");
  const paired = seeking.filter((m) => m.matchedWith).length;

  const join = () => {
    if (!form.name.trim()) return;
    connRef.current?.reducers.joinCommunity({ villageName: form.village, name: form.name, role: form.role, topic: form.topic || (form.role === "volunteer" ? "happy to listen" : "going through a hard time") });
    setForm({ ...form, name: "", topic: "" });
  };

  return (
    <div className="min-h-screen bg-[#060b14] text-slate-100">
      <header className="border-b border-pink-900/50 bg-gradient-to-r from-pink-950/40 via-[#060b14] to-[#060b14] px-6 py-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-pink-300">Community circles · Eastern Province · Zambia</p>
        <h1 className="mt-1 text-2xl font-bold">Nobody goes through it alone</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          When the pod hears sadness, loss or loneliness, it offers company: a volunteer from the same village who will meet them now and then to talk, introduced by the health worker. Every adult is asked at the end of their visit whether they would volunteer. This is the Friendship Bench idea: trained neighbours, not clinics.
        </p>
        <div className="mt-4 grid max-w-xl grid-cols-3 gap-2">
          <Kpi label="asking for company" value={seeking.length} tone="text-pink-300" />
          <Kpi label="volunteers" value={volunteers.length} tone="text-emerald-300" />
          <Kpi label="pairs made" value={paired} tone="text-sky-300" />
        </div>
        <p className={`mt-2 font-mono text-xs ${status === "live" ? "text-emerald-300" : "text-amber-300"}`}>● {status}</p>
      </header>

      <main className="grid gap-4 p-6 xl:grid-cols-[1fr_24rem]">
        <section className="space-y-4">
          {byVillage.map((vid) => {
            const mine = members.filter((m) => m.villageId === vid);
            return (
              <article key={vid} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-slate-400">🏘️ {vname(vid)} circle</h2>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-pink-300">Would like company</p>
                    {mine.filter((m) => m.role === "seeking").map((m) => (
                      <Person key={String(m.id)} m={m} />
                    ))}
                    {!mine.some((m) => m.role === "seeking") && <p className="mt-1 text-xs text-slate-500">nobody waiting</p>}
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-emerald-300">Volunteers</p>
                    {mine.filter((m) => m.role === "volunteer").map((m) => (
                      <Person key={String(m.id)} m={m} />
                    ))}
                    {!mine.some((m) => m.role === "volunteer") && <p className="mt-1 text-xs text-slate-500">no volunteer yet: the connector will ask the next visitors</p>}
                  </div>
                </div>
              </article>
            );
          })}
          {!members.length && <p className="font-mono text-sm text-slate-500">{status === "offline" ? "SpacetimeDB offline — run `spacetime start`" : "no members yet"}</p>}
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-400">Join from here</p>
            <div className="mt-3 space-y-2 text-sm">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="First name" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2" />
              <select value={form.village} onChange={(e) => setForm({ ...form, village: e.target.value })} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                {villages.filter((v) => !v.hub).sort((a, b) => a.name.localeCompare(b.name)).map((v) => (
                  <option key={v.id} value={v.name.split(" ")[0]}>{v.name.replace(/ \(.*\)$/, "")}</option>
                ))}
              </select>
              <div className="flex gap-2">
                {(["volunteer", "seeking"] as const).map((r) => (
                  <button key={r} onClick={() => setForm({ ...form, role: r })} className={`flex-1 rounded-lg border px-3 py-2 ${form.role === r ? "border-emerald-500 bg-emerald-900/50 text-emerald-100" : "border-slate-700 bg-slate-900 text-slate-300"}`}>
                    {r === "volunteer" ? "I can listen" : "I'd like company"}
                  </button>
                ))}
              </div>
              <input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder={form.role === "volunteer" ? "What you can offer (optional)" : "What you're going through (optional)"} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2" />
              <button onClick={join} className="w-full rounded-lg bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-500">Join the circle</button>
              <p className="text-[11px] text-slate-500">First names only. The health worker makes every introduction in person.</p>
            </div>
          </section>
          <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-pink-300">Connector agent</p>
            <div className="mt-2 space-y-1.5">
              {log.map((l) => (
                <p key={String(l.id)} className="rounded-lg bg-slate-900/70 px-2.5 py-1.5 text-xs text-slate-200">{l.text}</p>
              ))}
              {!log.length && <p className="text-xs text-slate-500">Switch the agents on in the government view to start pairing.</p>}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function Person({ m }: { m: Member }) {
  return (
    <div className="mt-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <p className="text-sm font-medium">
        {m.name}
        {m.matchedWith && <span className="ml-2 rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] text-sky-100">meets {m.matchedWith}</span>}
      </p>
      {m.topic && <p className="text-xs text-slate-400">“{m.topic}”</p>}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
      <p className={`text-xl font-bold tabular-nums ${tone}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
    </div>
  );
}
