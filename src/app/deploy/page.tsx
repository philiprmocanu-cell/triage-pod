"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Stat = { value: number; year: string } | undefined;
type Row = {
  iso3: string;
  name: string;
  region: string;
  official: string;
  local: string;
  partners: { name: string; what: string; url: string }[];
  stats: { population?: Stat; ruralPct?: Stat; u5mr?: Stat; birthRate?: Stat; doctors?: Stat; malaria?: Stat };
};

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`);

// Where to deploy first: live World Bank numbers for candidate countries, who to partner with,
// and an impact estimate whose assumptions you can change.
export default function DeployPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [pods, setPods] = useState(50);
  const [perPod, setPerPod] = useState(5000);
  const [effect, setEffect] = useState(10);
  const [picked, setPicked] = useState("ZMB"); // Zambia first: the demo is built for it

  useEffect(() => {
    fetch("/api/deploy")
      .then((r) => r.json())
      .then((d) => {
        if (d.error && !d.countries) throw new Error(d.error);
        if (d.error) setError(d.error);
        setRows(d.countries);
        setSource(d.source);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const table = useMemo(
    () =>
      rows
        .map((r) => {
          const u5mr = r.stats.u5mr?.value ?? 0;
          const doctors = r.stats.doctors?.value ?? null;
          const rural = r.stats.ruralPct?.value ?? 50;
          const people = pods * perPod;
          const births = (people * (r.stats.birthRate?.value ?? 25)) / 1000;
          const childDeaths = (births * u5mr) / 1000;
          const saved = childDeaths * (effect / 100);
          // Need: child deaths, scarcity of doctors and how rural the country is.
          const need = u5mr * (rural / 100) * (1 / Math.max(0.03, doctors ?? 0.1));
          return { ...r, u5mr, doctors, rural, people, childDeaths, saved, need };
        })
        .sort((a, b) => b.need - a.need),
    [rows, pods, perPod, effect],
  );
  const sel = table.find((r) => r.iso3 === picked);
  const total = table.reduce((n, r) => n + r.saved, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Where to deploy first</h1>
          <p className="text-xs text-slate-400">Live statistics from the World Bank, ranked by need: child deaths × how rural × how few doctors.</p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Pod</Link>
          <Link href="/agents" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Agents</Link>
          <Link href="/dashboard" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Dashboard</Link>
        </div>
      </header>

      <section className="grid gap-4 px-6 pt-5 md:grid-cols-3">
        <Slider label="Pods deployed in each country" value={pods} min={1} max={1000} step={1} onChange={setPods} />
        <Slider label="People each pod serves" value={perPod} min={1000} max={20000} step={500} onChange={setPerPod} />
        <Slider label="Child deaths prevented (%)" value={effect} min={2} max={25} step={1} onChange={setEffect} />
      </section>
      <p className="px-6 pt-2 text-xs text-slate-500">
        Estimate = people served × birth rate × under-5 death rate × % prevented. 10% is a cautious default: community case-management programs model
        10–30% fewer child deaths, but real-world results are mixed. Adults saved (stroke, heart, maternal, mental health) are not counted.
      </p>

      {error && <p className="mx-6 mt-4 rounded-lg bg-red-950 px-4 py-2 text-sm text-red-200">Could not load World Bank data: {error}</p>}

      <main className="grid gap-6 p-6 xl:grid-cols-[1.6fr_1fr]">
        <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <p className="text-xs uppercase tracking-wide text-slate-400">Candidate countries · {pods} pods each</p>
            <p className="text-sm">
              Children&apos;s lives saved per year, all countries: <span className="text-xl font-bold text-emerald-300">~{fmt(total)}</span>
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr>
                <th className="py-2">Country</th>
                <th>Pod speaks</th>
                <th className="text-right">Child deaths /1,000 births</th>
                <th className="text-right">People per doctor</th>
                <th className="text-right">Rural</th>
                <th className="text-right">Malaria /1,000</th>
                <th className="text-right">Lives saved / yr</th>
              </tr>
            </thead>
            <tbody>
              {table.map((r) => (
                <tr key={r.iso3} onClick={() => setPicked(r.iso3)} className={`cursor-pointer border-t border-slate-800 hover:bg-slate-800/60 ${picked === r.iso3 ? "bg-slate-800" : ""}`}>
                  <td className="py-2 font-medium">
                    {r.name}
                    {r.partners.length > 0 && <span className="ml-2 rounded bg-emerald-900 px-1.5 py-0.5 text-xs text-emerald-200">partners</span>}
                  </td>
                  <td>{r.official}</td>
                  <td className="text-right tabular-nums">{r.u5mr ? r.u5mr.toFixed(0) : "—"}</td>
                  <td className="text-right tabular-nums">{r.doctors ? fmt(1000 / r.doctors) : "—"}</td>
                  <td className="text-right tabular-nums">{r.rural.toFixed(0)}%</td>
                  <td className="text-right tabular-nums">{r.stats.malaria ? r.stats.malaria.value.toFixed(0) : "—"}</td>
                  <td className="text-right font-semibold tabular-nums text-emerald-300">{fmt(r.saved)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-500">{source}. Doctor numbers can be several years old.</p>
        </section>

        {sel && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-400">{sel.region}</p>
              <p className="text-2xl font-bold">{sel.name}</p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <Fact label="Population" value={sel.stats.population ? fmt(sel.stats.population.value) : "—"} year={sel.stats.population?.year} />
                <Fact label="Rural" value={`${sel.rural.toFixed(0)}%`} year={sel.stats.ruralPct?.year} />
                <Fact label="Child deaths per 1,000 births" value={sel.u5mr ? sel.u5mr.toFixed(1) : "—"} year={sel.stats.u5mr?.year} />
                <Fact label="Doctors per 1,000 people" value={sel.doctors ? sel.doctors.toFixed(2) : "—"} year={sel.stats.doctors?.year} />
              </div>
              <div className="mt-4 rounded-xl bg-emerald-950/60 p-3 text-sm">
                With {pods} pods serving {fmt(sel.people)} people: about <b>{fmt(sel.childDeaths)}</b> child deaths a year happen in that population; preventing {effect}% means
                <b> ~{fmt(sel.saved)} children&apos;s lives a year</b>.
              </div>
              <p className="mt-3 text-sm">
                <span className="text-slate-400">Pod speaks:</span> {sel.official} ·{" "}
                <span className="text-amber-300">not yet: {sel.local}</span>
              </p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Pilot partners to contact</p>
              {sel.partners.length ? (
                sel.partners.map((p) => (
                  <div key={p.name} className="py-2">
                    <a href={p.url} target="_blank" rel="noreferrer" className="font-semibold text-sky-300 hover:underline">
                      {p.name}
                    </a>
                    <p className="text-sm text-slate-300">{p.what}</p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-400">Not researched yet for this country.</p>
              )}
              <p className="mt-2 text-xs text-slate-500">From desk research; confirm details before reaching out.</p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm">
      <span className="flex justify-between">
        <span className="text-slate-400">{label}</span>
        <span className="font-semibold tabular-nums">{value.toLocaleString()}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-2 w-full" />
    </label>
  );
}

function Fact({ label, value, year }: { label: string; value: string; year?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-lg font-semibold">
        {value} <span className="text-xs font-normal text-slate-500">{year}</span>
      </p>
    </div>
  );
}
