import Link from "next/link";
import { needsByCommunity, peerGroups, readRegistry } from "@/lib/registry";

export const dynamic = "force-dynamic";

const URGENCY_DOT: Record<string, string> = { red: "bg-red-500", yellow: "bg-amber-400", green: "bg-emerald-500" };

// Health-team view: every visit, what each community needs, and the peer support groups.
export default async function RegistryPage() {
  const records = (await readRegistry()).reverse();
  const needs = needsByCommunity(records);
  const groups = peerGroups(records);

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Patient registry</h1>
          <p className="text-xs text-slate-400">Health team only. Names appear only for patients who agreed to be saved.</p>
        </div>
        <Link href="/" className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800">
          Back to pod
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <p className="mb-3 text-xs uppercase tracking-wide text-slate-400">Visits ({records.length})</p>
          {records.length === 0 && <p className="text-sm text-slate-400">No visits yet.</p>}
          <div className="space-y-3">
            {records.map((r) => (
              <div key={r.id} className="rounded-xl bg-slate-800/60 p-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${URGENCY_DOT[r.urgency]}`} />
                  <span className="font-medium">{r.name ?? "Anonymous"}</span>
                  <span className="text-sm text-slate-400">
                    · {r.community ?? "unknown community"} · {r.patient ?? r.ageGroup}
                  </span>
                  <span className="ml-auto text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-sm">{r.reason}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Likely: {r.causes.map((c) => `${c.name} ${Math.round(c.probability * 100)}%`).join(" · ") || "—"}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Needs: {r.resources.slice(0, 5).map((x) => x.item).join(", ") || "—"}
                </p>
                {r.mentalHealth.category && (
                  <p className="mt-1 text-xs text-sky-300">
                    Mental health: {r.mentalHealth.category}
                    {r.mentalHealth.wantsPeerGroup ? " · wants peer group" : ""}
                  </p>
                )}
                {r.handover && <p className="mt-2 text-sm text-slate-300">{r.handover}</p>}
              </div>
            ))}
          </div>
        </section>

        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p className="mb-3 text-xs uppercase tracking-wide text-slate-400">Expected needs by community</p>
            {[...needs.entries()].map(([community, items]) => (
              <div key={community} className="mb-3">
                <p className="font-medium">{community}</p>
                {[...items.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([item, units]) => (
                    <div key={item} className="flex justify-between text-sm text-slate-300">
                      <span>{item}</span>
                      <span className="tabular-nums">{units.toFixed(1)}</span>
                    </div>
                  ))}
              </div>
            ))}
            {needs.size === 0 && <p className="text-sm text-slate-400">Nothing yet.</p>}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Peer support groups</p>
            <p className="mb-3 text-xs text-slate-500">
              Opt-in only, led by a trained lay counselor (Friendship Bench model). People at risk of suicide get urgent
              one-to-one care instead.
            </p>
            {[...groups.entries()].map(([key, members]) => (
              <div key={key} className="mb-3">
                <p className="font-medium">
                  {key} <span className="text-sm text-slate-400">({members.length})</span>
                </p>
                <p className="text-sm text-slate-300">{members.map((m) => m.name ?? "Anonymous").join(", ")}</p>
              </div>
            ))}
            {groups.size === 0 && <p className="text-sm text-slate-400">No one has asked to join a group yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
