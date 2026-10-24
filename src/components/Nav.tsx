"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// One row of tabs on every screen except the patient-facing kiosk (which stays full screen).
const TABS = [
  { href: "/demo", label: "Demo", tone: "text-amber-300" },
  { href: "/kiosk?village=Katete", label: "Pod (patient)", match: "/kiosk" },
  { href: "/pod?village=Katete", label: "Pod (operator)", match: "/pod" },
  { href: "/staff", label: "Health worker" },
  { href: "/globe", label: "Live map" },
  { href: "/government", label: "Government" },
  { href: "/patients", label: "Patients" },
  { href: "/agents", label: "Agents" },
  { href: "/dashboard", label: "Supply sim" },
  { href: "/deploy", label: "Where next" },
  { href: "/registry", label: "Registry" },
];

export default function Nav() {
  const path = usePathname();
  if (path.startsWith("/kiosk")) return null;
  return (
    <nav className="sticky top-0 z-40 flex items-center gap-1 overflow-x-auto border-b border-slate-800/80 bg-[#060b14]/90 px-3 py-1.5 text-xs backdrop-blur">
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
