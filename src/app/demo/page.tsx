"use client";

import Link from "next/link";
import { useState } from "react";

// The presenter's tab: the demo in order, what to say, what to click, and a reset for everything.

const STEPS = [
  {
    n: 1,
    title: "The problem, on the map",
    href: "/globe",
    open: "Live map",
    say: "This is Eastern Province, Zambia. The medicine is in Chipata, the hub. The posts around it run out. Surveys found up to three in ten facilities out of malaria drugs while the warehouse had stock.",
    do: "Let the planet fly in. Point at the yellow +1 bubbles and the drones leaving Chipata. Scroll to zoom into the satellite imagery, drag to turn the planet.",
  },
  {
    n: 2,
    title: "A patient at the pod",
    href: "/kiosk?village=Katete",
    open: "Katete pod",
    say: "A patient sits down. The pod looks, listens and asks in their language. It asks history first, then checks what the camera noticed, and only orders for conditions it is confident about.",
    do: "Press Start, say your name, where you live, and 'fever and chills for three days, I sleep without a net'. Answer the questions. Keep /staff open on the other screen to show the decision path and the exact order.",
  },
  {
    n: 3,
    title: "The order flies to their home",
    href: "/globe",
    open: "Live map",
    say: "The moment the visit ends, the need becomes an order in the patient's name. The drone leaves wherever the stock actually is. One second here is one real minute.",
    do: "Watch the LIVE POD line appear in the feed, the +1 over Katete, the drone with its ETA tag.",
  },
  {
    n: 4,
    title: "The government view",
    href: "/government",
    open: "Government view",
    say: "This is what the Provincial Health Office sees: every post, every item, what pods used, and dozens of stock-outs. The agents are paused, waiting for approval.",
    do: "Click 'Agents: paused' to switch them on. Within ten seconds every red cell gets a '+n on the way'. Read one line of the agent log out loud. Click 'Write the briefing'.",
  },
  {
    n: 5,
    title: "Who is due what",
    href: "/patients",
    open: "Patients",
    say: "The posts know their people. Each profile says exactly which vaccine dose is due on Zambia's schedule, and the immunisation planner keeps vaccines stocked for them.",
    do: "Filter by 'Malaria (R21)'. Click 'Send to their home' on one child; switch to the map to see it fly.",
  },
  {
    n: 6,
    title: "Where it goes next",
    href: "/deploy",
    open: "Where next",
    say: "Live World Bank numbers for 19 countries and the partners to call first. Zambia is first.",
    do: "Close on the lives-per-year estimate.",
  },
];

export default function DemoPage() {
  const [resetting, setResetting] = useState("");

  const resetAll = async () => {
    setResetting("Resetting…");
    try {
      await fetch("http://127.0.0.1:3000/v1/database/podnet/call/reset_demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" });
      await fetch("/api/network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "reset" }) }).catch(() => {});
      await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) }).catch(() => {});
      setResetting("Reset done: map, government view and pod are back to the start. The visit registry was kept.");
    } catch {
      setResetting("Reset failed: is SpacetimeDB running? (spacetime start)");
    }
  };

  return (
    <div className="min-h-screen bg-[#060b14] text-slate-100">
      <header className="border-b border-amber-900/50 bg-gradient-to-r from-amber-950/40 via-[#060b14] to-[#060b14] px-6 py-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-amber-300">Demo · 3 minutes · Eastern Province, Zambia</p>
        <h1 className="mt-1 text-2xl font-bold">Run the demo</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">Six steps, in order. Each has the screen to open, one thing to say, and one thing to do. Two browser windows work best: this tab plus the screen you are showing.</p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <button onClick={resetAll} className="rounded-lg border border-amber-600 bg-amber-900/40 px-3 py-1.5 text-amber-100 hover:bg-amber-800/50">Reset everything for a fresh run</button>
          <Link href="/globe" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">Open the map</Link>
          <Link href="/staff" className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 hover:bg-slate-800">Open the health-worker screen</Link>
          {resetting && <span className="text-slate-300">{resetting}</span>}
        </div>
      </header>
      <main className="grid gap-4 p-6 lg:grid-cols-2">
        {STEPS.map((s) => (
          <section key={s.n} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-amber-300">STEP {s.n}</p>
                <h2 className="mt-1 text-lg font-semibold">{s.title}</h2>
              </div>
              <Link href={s.href} target="_blank" className="whitespace-nowrap rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-sky-400">
                Open {s.open} ↗
              </Link>
            </div>
            <p className="mt-3 text-sm"><span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Say · </span>{s.say}</p>
            <p className="mt-2 text-sm text-slate-300"><span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Do · </span>{s.do}</p>
          </section>
        ))}
      </main>
      <footer className="px-6 pb-8 text-xs text-slate-500">
        <p className="font-semibold text-slate-400">If something breaks</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Map or government view says "offline": run <code>spacetime start</code> in a terminal, then reload.</li>
          <li>Pod does not hear you: press Space (or the pod button) before speaking, or type the answer in the box.</li>
          <li>Camera says "come a little closer": sit about 50 cm away, facing it, with light on your face.</li>
          <li>Everything else: this tab's "Reset everything", then reload the screen you are showing.</li>
        </ul>
      </footer>
    </div>
  );
}
