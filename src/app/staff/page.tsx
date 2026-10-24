"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Conversation, ResultPanel } from "@/components/PodScreen";
import type { TraitScan } from "@/lib/triage/traits";
import type { Intake, TestResults, TriageResult, Turn } from "@/lib/triage/types";

type Live = {
  state: {
    turns: Turn[];
    result: TriageResult | null;
    tests: TestResults;
    intake: Intake;
    scan: TraitScan;
    scanMs: number | null;
    status: string;
    faceVisible: boolean;
    heartRate: number | null;
    saved: { name: string | null; community: string | null; handover: string | null } | null;
  } | null;
  vitals: { spo2?: number; tempC?: number; sys?: number; dia?: number; glucose?: number; at?: number };
  updatedAt: number;
};

// The health worker's screen for the hardware pod: everything the patient doesn't see, live,
// plus a place to type in real measurements (pulse oximeter, thermometer, BP cuff, glucometer).
export default function Staff() {
  const [live, setLive] = useState<Live | null>(null);
  const [form, setForm] = useState({ spo2: "", tempC: "", sys: "", dia: "", glucose: "" });
  const [sent, setSent] = useState("");

  useEffect(() => {
    const load = () => fetch("/api/session", { cache: "no-store" }).then((r) => r.json()).then(setLive).catch(() => {});
    load();
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, []);

  const sendVitals = async () => {
    const vitals = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)]));
    await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vitals }) });
    setSent("Saved — used from the pod's next step.");
  };

  const s = live?.state;
  const v = live?.vitals ?? {};
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Health worker screen</h1>
          <p className="text-xs text-slate-400">
            Live from the pod · {s ? `status: ${s.status}` : "waiting for the pod"} {live?.updatedAt ? `· updated ${new Date(live.updatedAt).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/kiosk" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Pod screen</Link>
          <Link href="/agents" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Agents</Link>
          <Link href="/dashboard" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Dashboard</Link>
        </div>
      </header>
      <main className="grid gap-6 p-6 md:grid-cols-[1fr_1fr]">
        <section className="space-y-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Measured vitals (type what the devices show)</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Field label="SpO₂ %" value={form.spo2} onChange={(x) => setForm({ ...form, spo2: x })} now={v.spo2} />
              <Field label="Temp °C" value={form.tempC} onChange={(x) => setForm({ ...form, tempC: x })} now={v.tempC} />
              <Field label="BP systolic" value={form.sys} onChange={(x) => setForm({ ...form, sys: x })} now={v.sys} />
              <Field label="BP diastolic" value={form.dia} onChange={(x) => setForm({ ...form, dia: x })} now={v.dia} />
              <Field label="Glucose mg/dL" value={form.glucose} onChange={(x) => setForm({ ...form, glucose: x })} now={v.glucose} />
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={sendVitals} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold hover:bg-sky-500">Save vitals</button>
              <button
                onClick={async () => {
                  await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) });
                  setForm({ spo2: "", tempC: "", sys: "", dia: "", glucose: "" });
                  setSent("Cleared for the next patient.");
                }}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm"
              >
                Clear for next patient
              </button>
              <span className="text-xs text-slate-400">{sent}</span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Camera heart rate: {s?.heartRate ? `${Math.round(s.heartRate)} bpm (estimate)` : "—"} · A pulse oximeter reading is far more reliable.
            </p>
          </div>
          {s && <Conversation turns={s.turns} />}
        </section>
        <section>
          {s ? (
            <ResultPanel result={s.result} tests={s.tests} intake={s.intake} saved={s.saved} voiceInfo="" scan={s.scan} scanMs={s.scanMs} faceVisible={s.faceVisible} />
          ) : (
            <p className="text-slate-400">Open the pod screen (/kiosk) on the pod&apos;s display to start.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function Field({ label, value, onChange, now }: { label: string; value: string; onChange: (v: string) => void; now?: number }) {
  return (
    <label className="text-xs text-slate-400">
      {label}
      <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder={now != null ? String(now) : ""} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-base text-slate-100" />
    </label>
  );
}
