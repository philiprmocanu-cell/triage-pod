"use client";

import { useEffect, useState } from "react";
import { DbConnection } from "@/module_bindings";
import type { VisitRecord } from "@/lib/registry";

// Every saved visit, live from SpacetimeDB's visit_record table: the doctor's handover appears the
// moment Claude writes it (handover is '' until then). The server-rendered copy from
// data/registry.json is the fallback while the database is offline or has nothing yet.

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "podnet";
const URGENCY_DOT: Record<string, string> = { red: "bg-red-500", yellow: "bg-amber-400", green: "bg-emerald-500" };

type Live = VisitRecord & { pending: boolean; village: string };

function parse<T>(text: string, fallback: T): T {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function LiveVisits({ fallback }: { fallback: VisitRecord[] }) {
  const [live, setLive] = useState<Live[] | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = (c: DbConnection) => {
      const villages = new Map([...c.db.village.iter()].map((v) => [v.id, v.name.replace(/ \(.*\)$/, "")]));
      setLive(
        [...c.db.visitRecord.iter()]
          .map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            region: r.region,
            consent: r.consent,
            name: r.name || null,
            community: r.community || null,
            patient: r.patient || null,
            ageGroup: r.ageGroup,
            language: r.language,
            locale: r.locale,
            urgency: r.urgency as VisitRecord["urgency"],
            reason: r.reason,
            causes: parse<VisitRecord["causes"]>(r.causes, []),
            resources: parse<VisitRecord["resources"]>(r.resources, []),
            orders: parse<NonNullable<VisitRecord["orders"]>>(r.orders, []),
            mentalHealth: { category: r.mentalCategory || null, wantsPeerGroup: r.wantsPeerGroup, volunteer: r.volunteer },
            handover: r.handover || null,
            pending: r.handover === "",
            village: villages.get(r.villageId) ?? "",
          }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    };
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(DB_NAME)
      .onConnect((c) => {
        setStatus("live");
        c.subscriptionBuilder()
          .onApplied(() => refresh(c))
          .subscribe(["SELECT * FROM visit_record", "SELECT * FROM village"]);
        timer = setInterval(() => refresh(c), 1500);
      })
      .onConnectError(() => setStatus("offline"))
      .onDisconnect(() => setStatus("offline"))
      .build();
    return () => {
      clearInterval(timer);
      conn.disconnect();
    };
  }, []);

  const useLive = status === "live" && live !== null && live.length > 0;
  const records: Live[] = useLive ? live : fallback.map((r) => ({ ...r, pending: false, village: "" }));

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-wide text-slate-400">Visits ({records.length})</p>
        <p className={`font-mono text-[11px] ${useLive ? "text-emerald-300" : "text-slate-500"}`}>
          {useLive ? "● live from SpacetimeDB" : status === "offline" ? "● database offline, showing the saved file" : live && !live.length ? "● database has no saved visits yet, showing the saved file" : "● connecting…"}
        </p>
      </div>
      {records.length === 0 && <p className="text-sm text-slate-400">No visits yet.</p>}
      <div className="space-y-3">
        {records.map((r) => (
          <div key={r.id} className="rounded-xl bg-slate-800/60 p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${URGENCY_DOT[r.urgency]}`} />
              <span className="font-medium">{r.name ?? "Anonymous"}</span>
              <span className="text-sm text-slate-400">
                · {(r.community ?? r.village) || "unknown community"} · {r.patient ?? r.ageGroup}
              </span>
              <span className="ml-auto text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            <p className="mt-1 text-sm">{r.reason}</p>
            <p className="mt-1 text-xs text-slate-400">Likely: {r.causes.map((c) => `${c.name} ${Math.round(c.probability * 100)}%`).join(" · ") || "—"}</p>
            <p className="mt-1 text-xs text-slate-400">Needs: {r.resources.slice(0, 5).map((x) => x.item).join(", ") || "—"}</p>
            {(r.orders?.length ?? 0) > 0 && <p className="mt-1 text-xs text-sky-200">Ordered: {r.orders!.map((o) => `${o.qty}× ${o.item}`).join(", ")}</p>}
            {r.mentalHealth.category && (
              <p className="mt-1 text-xs text-sky-300">
                Mental health: {r.mentalHealth.category}
                {r.mentalHealth.wantsPeerGroup ? " · wants peer group" : ""}
              </p>
            )}
            {r.handover && <p className="mt-2 text-sm text-slate-300">{r.handover}</p>}
            {r.pending && <p className="mt-2 text-xs italic text-slate-500">Doctor&apos;s handover: Claude is writing it…</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
