"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DbConnection } from "@/module_bindings";
import { ageText, dueFor, nextDoses } from "@/lib/vaccines";

// Everyone the posts know, compact, for the registry page. Live from SpacetimeDB.
export default function PeopleList() {
  const [rows, setRows] = useState<{ id: number; name: string; village: string; age: string; flags: string[]; due: string[] }[]>([]);
  useEffect(() => {
    const conn = DbConnection.builder()
      .withUri(process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000")
      .withDatabaseName(process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet")
      .onConnect((c) => {
        c.subscriptionBuilder()
          .onApplied(() => {
            const villages = new Map([...c.db.village.iter()].map((v) => [v.id, v.name.replace(/ \(.*\)$/, "")]));
            setRows(
              [...c.db.patient.iter()]
                .map((p) => ({
                  id: p.id,
                  name: p.name,
                  village: villages.get(p.villageId) ?? "",
                  age: ageText(p.ageMonths),
                  flags: [p.pregnant && "pregnant", p.ageMonths < 60 && "under 5", p.notes].filter(Boolean) as string[],
                  due: nextDoses(dueFor(p)).map((d) => d.label),
                }))
                .sort((a, b) => a.village.localeCompare(b.village) || a.name.localeCompare(b.name)),
            );
          })
          .subscribe(["SELECT * FROM patient", "SELECT * FROM village"]);
      })
      .build();
    return () => conn.disconnect();
  }, []);
  if (!rows.length) return null;
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">People the posts know ({rows.length})</h2>
        <Link href="/patients" className="text-xs text-sky-300 hover:underline">Open profiles and vaccines →</Link>
      </div>
      <div className="mt-2 overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-500">
            <tr><th className="px-3 py-2 text-left">name</th><th className="px-3 py-2 text-left">village</th><th className="px-3 py-2 text-left">age</th><th className="px-3 py-2 text-left">notes</th><th className="px-3 py-2 text-left">vaccines due</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-800/70">
                <td className="px-3 py-1.5 font-medium">{r.name}</td>
                <td className="px-3 py-1.5 text-slate-300">{r.village}</td>
                <td className="px-3 py-1.5 text-slate-300">{r.age}</td>
                <td className="px-3 py-1.5 text-slate-400">{r.flags.join(" · ")}</td>
                <td className="px-3 py-1.5 text-sky-200">{r.due.join(", ") || <span className="text-emerald-300">up to date</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
