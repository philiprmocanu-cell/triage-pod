import Link from "next/link";

// Front door for the demo: what the project is, the country it is built for, and every screen.
// The pod itself lives at /kiosk (patient) and /staff (health worker).

const SCREENS = [
  { href: "/kiosk?village=Katete", title: "Patient pod", what: "Camera + voice triage in the patient's language. Asks history first, confirms what the camera noticed, orders exactly what the patient needs.", tag: "pod", icon: "🩺" },
  { href: "/pod?village=Katete", title: "Pod, operator view", what: "The same visit with the camera, conversation, a typed-answer box for loud rooms, region and accent settings, and the result panel beside it.", tag: "pod", icon: "🎛️" },
  { href: "/staff", title: "Health worker screen", what: "Live mirror of the visit: decision path, confident conditions only, the exact order placed, vitals entry (oxygen, temperature, BP).", tag: "pod", icon: "🧑‍⚕️" },
  { href: "/globe", title: "Live map", what: "40 health posts as dots on a satellite globe. Nothing moves until a pod flags a need; then the order flies from wherever the stock is. Click a post for what it asked for, sent and holds.", tag: "network", icon: "🌍" },
  { href: "/government", title: "Government view", what: "Provincial Health Office: every post × every item, satellite malaria and flood risk, vaccines due, pods online, what the AI agents moved and why, and a Claude briefing ending in one decision.", tag: "network", icon: "🏛️" },
  { href: "/patients", title: "Patients & vaccines", what: "Profiles the posts keep: who is due which vaccine dose on Zambia's schedule, with the doctor's note from their last visit. One click sends the dose to their home.", tag: "network", icon: "👶" },
  { href: "/community", title: "Community circles", what: "People going through a hard time are paired with volunteers from their own village. Everyone is invited to volunteer at the end of a visit.", tag: "network", icon: "🤝" },
  { href: "/agents", title: "Agent bus (simulator)", what: "Pods report, the sentinel warns, the allocator moves stock, the router refers emergencies, the doctor queue assigns reviews. Runs on invented background patients.", tag: "network", icon: "🤖" },
  { href: "/dashboard", title: "Supply simulator", what: "A what-if sandbox: start an outbreak or a flood and watch the network re-route drones and road deliveries.", tag: "network", icon: "🛩️" },
  { href: "/deploy", title: "Where next", what: "Live World Bank numbers for 19 candidate countries and the partners to call first. Zambia is first.", tag: "plan", icon: "🗺️" },
  { href: "/registry", title: "Visit registry", what: "Every saved visit, live, with the doctor's handover note as Claude writes it.", tag: "plan", icon: "📒" },
  { href: "/demo", title: "Presenter's tab", what: "The demo in order for Sunday: what to open, say, do and see at each step, the one-line facts with sources, and the honest limits.", tag: "plan", icon: "🎤" },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-[#060b14] text-slate-100">
      <section className="relative overflow-hidden border-b border-slate-800 px-6 py-12">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,rgba(56,189,248,.18),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(52,211,153,.14),transparent_55%)]" />
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-sky-300">Triage Pod · Eastern Province · Zambia</p>
        <h1 className="mt-3 max-w-4xl text-4xl font-bold leading-tight md:text-5xl">The medicine exists. It just isn&apos;t where the patient is.</h1>
        <p className="mt-4 max-w-3xl text-lg text-slate-300">
          In Zambia, surveys found up to three in ten health facilities out of malaria drugs while the national warehouse had stock on the shelf. People die of the distance between the two. Triage Pod puts an AI nurse at the village post, and a network of agents that moves medicine to the patient the moment a need is flagged.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/kiosk?village=Katete" className="rounded-xl bg-sky-500 px-5 py-3 font-semibold text-slate-950 hover:bg-sky-400">Start a visit (Katete pod)</Link>
          <Link href="/globe" className="rounded-xl border border-slate-600 bg-slate-900/80 px-5 py-3 font-semibold hover:bg-slate-800">Open the live map</Link>
          <Link href="/government" className="rounded-xl border border-emerald-700 bg-emerald-950/60 px-5 py-3 font-semibold text-emerald-100 hover:bg-emerald-900/60">Government view</Link>
        </div>
        <div className="mt-8 grid max-w-4xl grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Fact n="1" t="A patient sits down. The pod looks, listens and asks in their language." />
          <Fact n="2" t="Only confident findings become an order: test + treatment, nothing for a guess." />
          <Fact n="3" t="The order flies from wherever the stock is, drone or truck, to their home." />
          <Fact n="4" t="Agents restock posts before they run out and tell the province why." />
        </div>
      </section>

      <section className="px-6 py-8">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {SCREENS.map((s) => (
            <Link key={s.href} href={s.href} className="group rounded-2xl border border-slate-800 bg-slate-950/60 p-5 transition hover:border-sky-700 hover:bg-slate-900/80">
              <div className="flex items-center justify-between">
                <span className="text-2xl">{s.icon}</span>
                <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${s.tag === "pod" ? "text-sky-400" : s.tag === "network" ? "text-emerald-400" : "text-slate-500"}`}>{s.tag}</span>
              </div>
              <p className="mt-3 text-lg font-semibold group-hover:text-sky-200">{s.title}</p>
              <p className="mt-1 text-sm text-slate-400">{s.what}</p>
            </Link>
          ))}
        </div>
        <p className="mt-8 font-mono text-[11px] text-slate-600">
          Built at Cal Hacks 2026 · Jev (TypeSafe) for triage decisions · Cartesia for voice · Claude for words and briefings · SpacetimeDB for the live network · globe.gl on Esri satellite imagery. Not a medical device.
        </p>
      </section>
    </div>
  );
}

function Fact({ n, t }: { n: string; t: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
      <p className="font-mono text-xs text-sky-400">{n}</p>
      <p className="mt-1 text-slate-300">{t}</p>
    </div>
  );
}
