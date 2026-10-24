"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { MapFlight, MapPost } from "@/components/SupplyMap";

const SupplyMap = dynamic(() => import("@/components/SupplyMap"), { ssr: false });

type Snapshot = {
  now: number;
  simSpeed: number;
  posts: (MapPost & { population: number; oxygen: boolean; visits24h: number; podVisits: number })[];
  skus: { id: string; label: string; kg: number; drone: boolean; critical: number }[];
  stock: Record<string, Record<string, number>>;
  forecast: Record<string, Record<string, number>>;
  shortages: { post: string; postName: string; sku: string; label: string; qty: number; need: number; have: number; hoursLeft: number }[];
  flights: (MapFlight & { items: { sku: string; qty: number }[]; kg: number; km: number; minutes: number; reason: string })[];
  cantFly: { post: string; sku: string; text: string }[];
  alerts: { post: string; text: string; level: "red" | "amber" }[];
  outbreak: { post: string; kind: string } | null;
  kpis: Record<string, number>;
};

// Live supply dashboard for the organisations running the pods: where supplies are, what the AI
// triage says each community will need in the next 48 h, and what to send where, by drone or road.
export default function Dashboard() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [outbreakPost, setOutbreakPost] = useState("katete");
  const [outbreakKind, setOutbreakKind] = useState("malaria");
  const [floodPost, setFloodPost] = useState("lundazi");

  const load = useCallback(async () => {
    const r = await fetch("/api/network", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [load]);

  const act = async (body: object) => {
    const r = await fetch("/api/network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) setData(await r.json());
  };

  if (!data) return <div className="min-h-screen bg-slate-950 p-6 text-slate-400">Loading network…</div>;

  const label = (sku: string) => data.skus.find((s) => s.id === sku)?.label ?? sku;
  const name = (id: string) => data.posts.find((p) => p.id === id)?.name ?? id;
  const proposed = data.flights.filter((f) => f.status === "proposed");
  const active = data.flights.filter((f) => f.status === "flying");
  const sel = data.posts.find((p) => p.id === selected);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Supply dashboard · Eastern Province, Zambia</h1>
          <p className="text-xs text-slate-400">
            Demand comes from AI triage at every pod. Demo network, approximate locations, running {data.simSpeed}× real time.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Pod
          </Link>
          <Link href="/registry" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Registry
          </Link>
          <Link href="/agents" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Agents
          </Link>
          <button onClick={() => act({ type: "reset" })} className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">
            Reset demo
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi label="Patients triaged (24 h)" value={data.kpis.visits24h} />
        <Kpi label="From live pods" value={data.kpis.podVisits} />
        <Kpi label="Emergencies (24 h)" value={data.kpis.redCases} tone="red" />
        <Kpi label="Shortages predicted" value={data.kpis.shortages} tone={data.kpis.shortages ? "amber" : undefined} />
        <Kpi label="Deliveries proposed" value={data.kpis.proposed} />
        <Kpi label="In the air / on road" value={data.kpis.flying} tone="sky" />
        <Kpi label="Delivered" value={data.kpis.delivered} tone="green" />
      </div>

      <main className="grid gap-6 p-6 xl:grid-cols-[1.5fr_1fr]">
        <section className="space-y-4">
          <div className="h-[520px] overflow-hidden rounded-2xl border border-slate-800">
            <SupplyMap posts={data.posts} flights={data.flights} selected={selected} onSelect={setSelected} />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
            <Legend color="#34d399" text="Stocked" />
            <Legend color="#fbbf24" text="Running low" />
            <Legend color="#ef4444" text="Out of something needed" />
            <span>— — proposed · ━ approved · 🛩️ drone · 🚚 road · 🌊 flooded</span>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Simulate an outbreak">
              <div className="flex flex-wrap gap-2">
                <Select value={outbreakPost} onChange={setOutbreakPost} options={data.posts.filter((p) => !p.hub).map((p) => [p.id, p.name])} />
                <Select value={outbreakKind} onChange={setOutbreakKind} options={[["malaria", "Malaria"], ["diarrhea", "Diarrhea"], ["respiratory", "Pneumonia"]]} />
                {data.outbreak ? (
                  <button onClick={() => act({ type: "end_outbreak" })} className="rounded-lg bg-slate-700 px-3 py-2 text-sm">
                    End outbreak
                  </button>
                ) : (
                  <button onClick={() => act({ type: "outbreak", post: outbreakPost, kind: outbreakKind })} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold">
                    Start
                  </button>
                )}
              </div>
            </Card>
            <Card title="Satellite: flooded road (simulated)">
              <div className="flex flex-wrap gap-2">
                <Select value={floodPost} onChange={setFloodPost} options={data.posts.filter((p) => !p.hub).map((p) => [p.id, p.name])} />
                <button onClick={() => act({ type: "flood", post: floodPost })} className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-semibold">
                  {data.posts.find((p) => p.id === floodPost)?.flooded ? "Road reopened" : "Road flooded"}
                </button>
              </div>
            </Card>
          </div>

          {sel && (
            <Card title={`${sel.name} · stock vs 48-hour forecast`}>
              <p className="mb-2 text-xs text-slate-400">
                Population ~{sel.population.toLocaleString()} · {sel.visits24h} patients in 24 h ({sel.podVisits} from the live pod) ·{" "}
                {sel.oxygen ? "has oxygen" : "no oxygen"}
              </p>
              <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                {data.skus.map((k) => {
                  const have = data.stock[sel.id][k.id];
                  const need = data.forecast[sel.id][k.id];
                  const pct = need > 0 ? Math.min(1, have / (need * 1.25)) : 1;
                  return (
                    <div key={k.id} className="py-1 text-sm">
                      <div className="flex justify-between">
                        <span>{k.label}</span>
                        <span className="tabular-nums text-slate-400">
                          {have} / {need.toFixed(0)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded bg-slate-800">
                        <div className={`h-1.5 rounded ${pct < 0.5 ? "bg-red-500" : pct < 1 ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${pct * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </section>

        <section className="space-y-4">
          {(data.alerts.length > 0 || data.cantFly.length > 0) && (
            <Card title="Alerts">
              {data.alerts.map((a, i) => (
                <p key={i} className={`py-1 text-sm ${a.level === "red" ? "text-red-300" : "text-amber-300"}`}>
                  {a.level === "red" ? "⚠️" : "🌊"} {a.text}
                </p>
              ))}
              {data.cantFly.map((c, i) => (
                <p key={`c${i}`} className="py-1 text-sm text-amber-300">
                  🚫 {c.text}
                </p>
              ))}
            </Card>
          )}

          <Card title={`AI allocation plan · ${proposed.length} deliveries`}>
            {proposed.length > 0 && (
              <button onClick={() => act({ type: "approve_all" })} className="mb-3 w-full rounded-xl bg-sky-600 py-2.5 font-semibold hover:bg-sky-500">
                Approve all
              </button>
            )}
            {proposed.length === 0 && <p className="text-sm text-slate-400">Every post has what it needs for the next 48 hours.</p>}
            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {proposed.map((f) => (
                <div key={f.id} className="rounded-xl bg-slate-800/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">
                      {f.mode === "drone" ? "🛩️ Drone" : "🚚 Road"} → {name(f.to)}
                    </p>
                    <button onClick={() => act({ type: "approve", id: f.id })} className="rounded-lg bg-slate-700 px-2.5 py-1 text-xs hover:bg-slate-600">
                      Approve
                    </button>
                  </div>
                  <p className="text-sm text-slate-300">{f.items.map((i) => `${i.qty} × ${label(i.sku)}`).join(", ")}</p>
                  <p className="text-xs text-slate-500">
                    {f.kg.toFixed(1)} kg · {f.km} km · ~{f.minutes} min · {f.reason}
                  </p>
                </div>
              ))}
            </div>
          </Card>

          {active.length > 0 && (
            <Card title="On the way">
              {active.map((f) => (
                <p key={f.id} className="py-1 text-sm">
                  {f.mode === "drone" ? "🛩️" : "🚚"} {name(f.to)} · {f.items.map((i) => `${i.qty} ${label(i.sku)}`).join(", ")}
                  <span className="ml-2 text-xs text-slate-500">arrives in {Math.max(0, Math.ceil(((f.arriveAt ?? 0) - Date.now()) / 1000))} s</span>
                </p>
              ))}
            </Card>
          )}

          <Card title="Predicted shortages (next 48 h)">
            {data.shortages.length === 0 && <p className="text-sm text-slate-400">None.</p>}
            {data.shortages.slice(0, 10).map((s, i) => (
              <button key={i} onClick={() => setSelected(s.post)} className="flex w-full justify-between py-1 text-left text-sm hover:text-sky-300">
                <span>
                  {s.postName} · {s.label}
                </span>
                <span className={`tabular-nums ${s.hoursLeft < 12 ? "text-red-300" : "text-amber-300"}`}>
                  {s.have === 0 ? "out" : `~${Math.max(1, Math.round(s.hoursLeft))} h left`}
                </span>
              </button>
            ))}
          </Card>
        </section>
      </main>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "red" | "amber" | "sky" | "green" }) {
  const c = { red: "text-red-300", amber: "text-amber-300", sky: "text-sky-300", green: "text-emerald-300" }[tone ?? "sky"] ?? "";
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${tone ? c : ""}`}>{value}</p>
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

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {text}
    </span>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm">
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}
