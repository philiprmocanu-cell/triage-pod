"use client";

import Link from "next/link";
import { useState } from "react";

// The presenter's tab for Cal Hacks, Sunday 25 October 2026 (judging 10:30-12:30): the demo in the
// exact order, what to say and what to click at each step, the one-line facts with their sources
// (docs/EVIDENCE.md), the honest limits, and a reset that puts every screen back to the start.
// Plain words, no emojis: this is read out loud under pressure.

const BEFORE = [
  "Terminal 1: spacetime start. Terminal 2: npm run build:demo once, then npm run demo, and show from http://localhost:3418 (pages switch instantly; :3417 is the development server and compiles each page on first visit).",
  "Three browser windows: this tab, the screen you are showing, and /staff on a second display if you have one.",
  "Allow the microphone once, turn the laptop volume up, and run one full test visit. Then press 'Reset everything' below so the map is quiet again.",
  "Check /globe says 'SpacetimeDB live' and 'posts 40'. Leave 'Simulated visits' off: nothing on the map should be invented.",
  "Check /government says '0 pods online' before you open a pod, and '1 pod online' after: that line proves the pod is talking to the network.",
];

const STEPS = [
  {
    n: 1,
    title: "Open the map",
    href: "/globe",
    open: "Live map",
    say: "This is Eastern Province, Zambia: 40 health posts, each a dot on real satellite imagery. The medicine is in Chipata, the hub in green, and the posts around it run out. In Zambia three in ten clinics ran out of malaria drugs while the warehouse was full.",
    do: "Let the planet fly in. The map is quiet on purpose: nothing on it is pre-made. Show the three layer buttons once (Flights and routes, Hubs, All names) and leave them on.",
    check: "Top-left reads 'SpacetimeDB live' and 'posts 40'. If it says offline, run spacetime start and reload.",
  },
  {
    n: 2,
    title: "Open a pod from a village",
    href: "/globe",
    open: "Live map",
    say: "Every post has a pod: a camera, a microphone and a speaker in a box, no nurse required. Let's walk into the one in Katete, 26,000 people.",
    do: "Click the Katete dot. The panel shows what the post has on its shelf, what it asked for and what it sent. Point at the red zeros on the shelf. Click 'Open the pod here'.",
    check: "The panel says 'Asked for · 0' and a few shelf lines are red. That is the problem we are about to solve.",
  },
  {
    n: 3,
    title: "The visit",
    href: "/kiosk?village=Katete",
    open: "Katete pod",
    say: "A patient sits down. The pod looks, listens and asks in their language: history first, danger signs before anything else. It names a condition only when the evidence is strong, and orders exactly what that condition needs, nothing for a guess.",
    do: "Press Start (or Space), give a name, say 'fever and chills for three days, I sleep without a net', answer the questions. /staff on the other screen mirrors the decision path and the exact order. Say yes when it asks to save the visit.",
    check: "The closing names malaria as likely and the order shows a malaria rapid test and ACT.",
  },
  {
    n: 4,
    title: "The order appears",
    href: "/globe",
    open: "Live map",
    say: "The visit just became an order in the patient's name. Katete had no test kits, so it ships from where the stock actually is, on a real vehicle along the real road: a district pickup from Chipata, 86 km, with the road checked for flooding first. One second on this screen is one real minute.",
    do: "Switch back to the map. Watch the LIVE POD line in the feed, the +1 bubbles over Katete, the road drawn to Katete and the pickup moving along it. Click Katete again: 'Asked for' now lists the order and 'Roads planned' shows the route.",
    check: "If nothing appears within five seconds the visit was not saved: finish the visit again and say yes to saving.",
  },
  {
    n: 5,
    title: "The government view explains the allocation",
    href: "/government",
    open: "Government view",
    say: "This is what the Provincial Health Office sees: every post against every item, the satellite weather over each post, who is due a vaccine, which pods are online, and the agents' reasoning written down. The agents are paused until the office switches them on.",
    do: "Point at the red cells: that is Zambia's documented problem, empty posts beside a full hub. Read the POD line in the decisions feed out loud. Click 'Allocate now': every short post gets '+n on the way' with the reason beside it, and some stock moves post to post instead of from the hub. Click 'Write the briefing'.",
    check: "The feed shows ALLOC lines ending in 'by drone from Chipata' or '(idle stock, closer than the hub)'. The header says '1 pod online'.",
  },
  {
    n: 6,
    title: "Patients, then community",
    href: "/patients",
    open: "Patients",
    say: "The posts know their people. Each profile says which vaccine dose is due on Zambia's schedule, and one click sends it to their home. And when the pod hears sadness or loneliness it offers company: a trained neighbour from the same village. That is the Friendship Bench, which cut depression from 50% to 14% in Zimbabwe.",
    do: "Filter by 'Malaria (R21)'. Click 'Send to their home' on one child and glance at the map to see it fly. Open Community: the connector agent has paired people who asked for company with volunteers in their own village.",
    check: "Then the crisis.",
  },
  {
    n: 7,
    title: "The crisis: a rainy-season week at 26 posts",
    href: "/crisis",
    open: "Crisis",
    say: "Now the hard case. It is February: 26 posts flag needs in the same hour, malaria around Lundazi and Chama, cholera-type diarrhoea along the Luangwa, child pneumonia in Petauke, two pregnancy bleeds that need blood, a snakebite. Both Luangwa crossings are under water, the D103 is washed out, three vehicles are broken down. The planner has thirty seconds.",
    do: "Press 'Start the crisis (level 3)'. Read the timeline as it runs: planner, orders placed emergencies first, roads planned, re-check. Point at the globe: blocked legs red, the way around in green, boats and motorbikes where roads are cut, Petauke and Lundazi lending stock instead of the hub. Finish on the versus-naive bar.",
    check: "Around 80 vehicle movements instead of 800, over 100,000 km saved, every post reached by some carrier. Press 'Clear' before the next group.",
  },
  {
    n: 8,
    title: "If there is time: Routes, Tracks, Mosquitoes",
    href: "/routes",
    open: "Routes",
    say: "Routes: Zambia's real fleet and every planned road, re-checked every ten minutes against the weather. Tracks: new motorbike tracks proposed from satellite terrain where no road exists. Mosquitoes: the pod listens for the wingbeat of the malaria carrier and raises the village's malaria likelihood before anyone has a fever.",
    do: "Routes: click a road for its flood and surface reasons. Tracks: pick Jumbe. Mosquitoes: play the Anopheles clip from your phone near the laptop mic.",
    check: "Close on the one-line facts below.",
  },
];

// From docs/EVIDENCE.md, section 8. Say the source when asked.
const FACTS = [
  { fact: "In Zambia, 3 in 10 clinics ran out of malaria drugs while the warehouse was full.", source: "PLOS ONE 2016, 145 facilities" },
  { fact: "Drone delivery cut maternal deaths by about half in Rwanda.", source: "University of Pennsylvania, MSOM; Zipline's network" },
  { fact: "Community health workers referred only 55% of children with danger signs.", source: "Health Policy & Planning 2013, Malawi" },
  { fact: "AI gets the critical cases right 85 to 89% of the time; the pod adds hard rules on top.", source: "JAMA Network Open 2024; ESI triage studies 2024" },
  { fact: "A bench and a trained neighbour cut depression from 50% to 14%.", source: "JAMA 2016, Friendship Bench trial" },
  { fact: "0.32 doctors per 1,000 people in Zambia (the US has about 3.6).", source: "World Bank 2022, pulled live on /deploy" },
];

// Say these before a judge asks.
const LIMITS = [
  "Not a medical device. The pod is decision support with safety rules in code; a health worker checks every uncertain case the same day.",
  "The 40 posts are real district and health-post names in Eastern Province with approximate coordinates. Shelf counts are the demo database's seed, not a real inventory; the pattern (full hub, empty posts) is the documented one.",
  "In Zambia the pod speaks English today. Chewa/Nyanja is the next voice to add; the voice stack covers 42 languages but no African ones yet.",
  "Satellite weather is NASA POWER. Its most recent weeks are preliminary and this season read far wetter than the finished record for the same weeks last year, so the government view shows both numbers side by side and says so.",
  "The drones are not ours and do not fly in Zambia yet: Zipline flies in Rwanda, Ghana, Nigeria, Kenya and Côte d'Ivoire and is expanding across Africa under a 2026 US State Department deal; the map's drones stand for that partner. Speeds and travel times are estimates (drone 100 km/h, truck 40 km/h on roads 1.5x the straight line).",
  "The Supply simulator and Agents pages (linked from the home page, not in the tab bar) run on invented background patients and are labelled as a simulator. The map, government view, patients and community pages show only what pods and the office actually did.",
  "World Bank doctor counts can be several years old; each number on /deploy shows its year.",
];

export default function DemoPage() {
  const [resetting, setResetting] = useState("");

  const resetAll = async () => {
    setResetting("Resetting…");
    try {
      const r = await fetch("/api/government/reset", { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `reset ${r.status}`);
      await fetch("/api/network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "reset" }) }).catch(() => {});
      await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) }).catch(() => {});
      setResetting("Reset done: map, government view, patients and pod are back to the start. Saved visits were kept.");
    } catch (err) {
      setResetting(`Reset failed: ${err instanceof Error ? err.message : err}. Is SpacetimeDB running? (spacetime start)`);
    }
  };

  return (
    <div className="min-h-screen bg-[#060b14] text-slate-100">
      <header className="border-b border-amber-900/50 bg-gradient-to-r from-amber-950/40 via-[#060b14] to-[#060b14] px-6 py-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-amber-300">Demo · Cal Hacks · Sunday 25 October 2026 · judging 10:30–12:30</p>
        <h1 className="mt-1 text-2xl font-bold">Run the demo</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">Six steps in order, about three minutes. Each has the screen to open, one thing to say, one thing to do, and what you should see. The map starts quiet: everything the judges see is caused by the visit you do in front of them.</p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <button onClick={resetAll} className="rounded-lg border border-amber-600 bg-amber-900/40 px-3 py-1.5 text-amber-100 hover:bg-amber-800/50">Reset everything for a fresh run</button>
          <Link href="/globe" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">Open the map</Link>
          <Link href="/staff" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">Open the health-worker screen</Link>
          <Link href="/government" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">Open the government view</Link>
          {resetting && <span className="text-slate-300">{resetting}</span>}
        </div>
      </header>

      <main className="space-y-6 p-6">
        <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-slate-400">Before you start (10 minutes at the venue)</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-300">
            {BEFORE.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ol>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          {STEPS.map((s) => (
            <section key={s.n} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-amber-300">STEP {s.n}</p>
                  <h2 className="mt-1 text-lg font-semibold">{s.title}</h2>
                </div>
                <Link href={s.href} target="_blank" className="whitespace-nowrap rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-sky-400">
                  Open {s.open}
                </Link>
              </div>
              <p className="mt-3 text-sm"><span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Say · </span>{s.say}</p>
              <p className="mt-2 text-sm text-slate-300"><span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Do · </span>{s.do}</p>
              <p className="mt-2 text-sm text-emerald-200/90"><span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">See · </span>{s.check}</p>
            </section>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-emerald-900/60 bg-emerald-950/20 p-5">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-400">One-line facts, with sources</h2>
            <ul className="mt-2 space-y-2 text-sm">
              {FACTS.map((f) => (
                <li key={f.fact}>
                  <p className="text-slate-100">{f.fact}</p>
                  <p className="text-xs text-slate-500">{f.source}</p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">Full references in docs/EVIDENCE.md.</p>
          </section>
          <section className="rounded-2xl border border-amber-900/60 bg-amber-950/10 p-5">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-amber-300">Honest limits (say them before a judge asks)</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-300">
              {LIMITS.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        </div>
      </main>

      <footer className="px-6 pb-8 text-xs text-slate-500">
        <p className="font-semibold text-slate-400">If something breaks</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Map or government view says offline: run <code>spacetime start</code> in a terminal, then reload.</li>
          <li>Pod does not hear you: press Space (or the pod button) before speaking, or type the answer in the box on /pod.</li>
          <li>Camera says &quot;come a little closer&quot;: sit about 50 cm away, facing it, with light on your face.</li>
          <li>No order after the visit: the visit was not saved. Finish it again and say yes to saving.</li>
          <li>Satellite panel says no data: the venue blocked NASA; the page falls back to the last saved copy, otherwise skip the column.</li>
          <li>Everything else: &quot;Reset everything&quot; above, then reload the screen you are showing.</li>
        </ul>
      </footer>
    </div>
  );
}
