"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Msg = { id: number; t: number; from: string; fromPost?: string; to: string; kind: string; text: string };
type Snapshot = {
  bus: Msg[];
  advisories: { post: string; kind: string; text: string; until: number; source: string }[];
  referrals: { visit: string; from: string; to: string; reason: string; etaMin: number; t: number }[];
  queue: { visit: string; post: string; urgency: string; summary: string; doctor: string; status: string }[];
  agents: { name: string; messages: number }[];
  kpis: Record<string, number>;
  posts: { id: string; name: string; status: string; outbreak: string | null }[];
};

const ROLE: Record<string, string> = {
  Pod: "Each pod reports its patients (no names) to the network",
  "Outbreak sentinel": "Spots symptom clusters and puts nearby pods on watch",
  "Supply allocator": "Turns predicted shortages into drone and road deliveries",
  "Referral router": "Sends every emergency to a facility that can treat it",
  "Doctor queue": "Assigns yellow and red patients to remote doctors",
  Coordinator: "Claude writes a plain-language briefing for the health team",
};
const COLOR: Record<string, string> = {
  Pod: "bg-slate-600",
  "Outbreak sentinel": "bg-red-600",
  "Supply allocator": "bg-sky-600",
  "Referral router": "bg-amber-600",
  "Doctor queue": "bg-violet-600",
  Coordinator: "bg-emerald-600",
};

// The dispatch brain's own lines from the live network (agent_log in SpacetimeDB, or its file
// until the module has `log_agent`), shown beside the simulator so both planners are visible.
type DispatchLine = { id: number; at: string; village: string; text: string; where: "agent_log" | "file" };

// Live view of the agents coordinating the pod network: who said what to whom, and what changed.
export default function AgentsPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState("");
  const [dispatch, setDispatch] = useState<DispatchLine[]>([]);

  const load = useCallback(async () => {
    const r = await fetch("/api/agents", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    const read = () => fetch("/api/dispatch/log", { cache: "no-store" }).then((r) => r.json()).then((d: { lines?: DispatchLine[] }) => setDispatch(d.lines ?? [])).catch(() => {});
    read();
    const id = setInterval(read, 4000);
    return () => clearInterval(id);
  }, []);

  const act = async (body: object, label: string) => {
    setBusy(label);
    await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await load();
    setBusy("");
  };

  const postName = (id: string) => data?.posts.find((p) => p.id === id)?.name.replace(/ \(.*\)$/, "") ?? id;
  const target = (to: string) => (data?.posts.some((p) => p.id === to) ? `Pod ${postName(to)}` : to);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pod network · agents (simulator)</h1>
          <p className="text-xs text-slate-400">
            Every pod talks to the network; the network agents act and talk back. This tab runs on the supply simulator: 40 posts with invented background patients at 60× real time. The live network the pods write to is the map and the government view.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Pod</Link>
          <Link href="/dashboard" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Dashboard</Link>
          <Link href="/deploy" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Where to deploy</Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-2 px-6 pt-4">
        <button disabled={!!busy} onClick={() => act({ action: "outbreak", post: "katete", kind: "malaria" }, "outbreak")} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold disabled:opacity-50">
          Simulate a malaria outbreak in Katete
        </button>
        <button disabled={!!busy} onClick={() => act({ action: "approve_all" }, "approve")} className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold disabled:opacity-50">
          Approve all deliveries
        </button>
        <button disabled={!!busy} onClick={() => act({ action: "briefing" }, "briefing")} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold disabled:opacity-50">
          {busy === "briefing" ? "Coordinator is writing…" : "Ask the coordinator for a briefing"}
        </button>
        <button disabled={!!busy} onClick={() => act({ action: "reset" }, "reset")} className="rounded-lg border border-slate-700 px-3 py-2 text-sm disabled:opacity-50">
          Reset
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-3 xl:grid-cols-6">
        {data?.agents.map((a) => (
          <div key={a.name} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${COLOR[a.name]}`} />
              <p className="font-semibold">{a.name}</p>
            </div>
            <p className="mt-1 text-xs text-slate-400">{ROLE[a.name]}</p>
            <p className="mt-2 text-sm tabular-nums text-slate-300">{a.messages} messages</p>
          </div>
        ))}
      </div>

      <main className="grid gap-6 p-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <p className="mb-3 text-xs uppercase tracking-wide text-slate-400">Live messages between agents</p>
          <div className="max-h-[640px] space-y-2 overflow-y-auto pr-1">
            {data?.bus.length === 0 && <p className="text-sm text-slate-400">Waiting for the first patients…</p>}
            {data?.bus.map((m) => (
              <div key={m.id} className={`rounded-lg px-3 py-2 ${m.kind === "briefing" ? "bg-emerald-950/70" : m.kind === "alert" ? "bg-red-950/60" : "bg-slate-800/70"}`}>
                <p className="text-xs text-slate-400">
                  <span className={`mr-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${COLOR[m.from]}`}>{m.from}</span>
                  {m.fromPost ? `${postName(m.fromPost)} ` : ""}→ {target(m.to)} · {new Date(m.t).toLocaleTimeString()}
                </p>
                <p className="mt-0.5 text-sm">{m.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <Card title="Dispatch planner (live network, not the simulator)">
            {dispatch.length ? (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {dispatch.slice(0, 12).map((l) => (
                  <p key={`${l.where}-${l.id}`} className="py-1 text-sm">
                    <span className="mr-1.5 inline-block rounded bg-orange-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">Dispatch</span>
                    <span className="font-semibold">{l.village}</span>
                    <span className="block text-xs text-slate-400">{l.text}</span>
                    <span className="block text-[10px] text-slate-500">{new Date(l.at).toLocaleTimeString()} · {l.where === "agent_log" ? "agent_log" : "data/dispatch.json"}</span>
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-400">No shipments sent yet. On the government view, press Plan now, then Send all urgent or Send selected.</p>
            )}
          </Card>
          <Card title="Pods on watch (outbreak advisories)">
            {data?.advisories.length ? (
              data.advisories.map((a, i) => (
                <p key={i} className="py-1 text-sm">
                  <span className="font-semibold">{postName(a.post)}</span> · {a.kind} (cluster in {a.source})
                </p>
              ))
            ) : (
              <p className="text-sm text-slate-400">No advisories. Pods ask their normal questions.</p>
            )}
          </Card>
          <Card title="Doctor queue">
            {data?.queue.length ? (
              data.queue.slice(0, 8).map((q) => (
                <p key={q.visit} className="py-1 text-sm">
                  <span className={q.urgency === "red" ? "text-red-300" : "text-amber-300"}>{q.urgency.toUpperCase()}</span> · {q.doctor} · {postName(q.post)}
                  <span className="block text-xs text-slate-400">{q.summary}</span>
                </p>
              ))
            ) : (
              <p className="text-sm text-slate-400">No patients waiting. Finish a visit on the pod to see it arrive here.</p>
            )}
          </Card>
          <Card title="Emergency referrals">
            {data?.referrals.length ? (
              data.referrals.slice(0, 8).map((r) => (
                <p key={r.visit} className="py-1 text-sm">
                  {postName(r.from)} → <span className="font-semibold">{postName(r.to)}</span> · {r.reason} · ~{r.etaMin} min
                </p>
              ))
            ) : (
              <p className="text-sm text-slate-400">No emergencies yet.</p>
            )}
          </Card>
        </section>
      </main>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">{title}</p>
      {children}
    </div>
  );
}
