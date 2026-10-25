"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// One row of tabs on every screen except the patient-facing kiosk (which stays full screen).
// One tab per real screen. The operator view (/pod), the visit registry (/registry) and the
// simulators (/dashboard, /agents, /deploy) still exist and are linked from the pages that use
// them; they are the same data as these tabs, not screens of their own.
const TABS = [
  { href: "/demo", label: "Demo", tone: "text-amber-300" },
  { href: "/kiosk?village=Katete", label: "Pod", match: "/kiosk" },
  { href: "/staff", label: "Health worker" },
  { href: "/globe", label: "Live map" },
  { href: "/routes", label: "Routes" },
  { href: "/tracks", label: "Tracks" },
  { href: "/government", label: "Government" },
  { href: "/patients", label: "Patients" },
  { href: "/community", label: "Community", tone: "text-pink-300" },
  { href: "/mosquito", label: "Mosquitoes", tone: "text-emerald-300" },
];

export default function Nav() {
  const path = usePathname();
  const kiosk = path.startsWith("/kiosk"); // patient screen: keep the tabs, but fade them until the mouse comes near
  return (
    <nav className={`sticky top-0 z-40 flex items-center gap-1 overflow-x-auto border-b border-slate-800/80 bg-[#060b14]/90 px-3 py-1.5 text-xs backdrop-blur transition-opacity ${kiosk ? "opacity-30 hover:opacity-100" : ""}`}>
      <Link href="/" className="mr-2 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.25em] text-sky-300">
        Triage Pod
      </Link>
      {TABS.map((t) => {
        const on = path === (t.match ?? t.href.split("?")[0]) || (t.href !== "/" && path.startsWith(t.match ?? t.href.split("?")[0]));
        return (
          <Link key={t.href} href={t.href} className={`whitespace-nowrap rounded-md px-2.5 py-1 ${on ? "bg-slate-800 text-white" : `${t.tone ?? "text-slate-300"} hover:bg-slate-900 hover:text-white`}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
