import Link from "next/link";
import PeopleList from "@/components/PeopleList";
import { needsByCommunity, peerGroups, readRegistry } from "@/lib/registry";
import LiveVisits from "./LiveVisits";

export const dynamic = "force-dynamic";

// Health-team view: every visit (live from SpacetimeDB, the saved file as fallback), what each
// community needs, and the peer support groups.
export default async function RegistryPage() {
  const records = (await readRegistry()).reverse();
  const needs = needsByCommunity(records);
  const groups = peerGroups(records);

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Visit registry</h1>
          <p className="text-xs text-slate-400">Health team only. Names appear only for patients who agreed to be saved. Live from SpacetimeDB; the saved file (data/registry.json) when the database is offline.</p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/patients" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Patients &amp; vaccines</Link>
          <Link href="/government" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Government view</Link>
          <Link href="/" className="rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800">Home</Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <LiveVisits fallback={records} />

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
            <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Peer groups &amp; community circles</p>
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
      <PeopleList />
      </div>
    </div>
  );
}
