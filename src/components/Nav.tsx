"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/globe", label: "Satellite", match: "/globe" },
  { href: "/kiosk?village=Katete", label: "Pod", match: "/kiosk" },
  { href: "/staff", label: "Operator", match: "/staff" },
  { href: "/government", label: "Network", match: "/government" },
  { href: "/demo", label: "Demo", match: "/demo" },
  { href: "/mosquito", label: "Mosquito", match: "/mosquito" },
];

export default function Nav() {
  const path = usePathname() ?? "/";
  const [embed, setEmbed] = useState(false);
  useEffect(() => {
    const on = new URLSearchParams(window.location.search).get("embed") === "1";
    setEmbed(on);
    document.body.classList.toggle("is-embed", on);
    return () => document.body.classList.remove("is-embed");
  }, [path]);
  if (embed) return null;
  const kiosk = path.startsWith("/kiosk");
  return (
    <nav className={`fixed left-0 right-0 top-0 z-[200] flex h-11 items-center gap-6 border-b border-white/10 bg-black px-5 text-[11px] uppercase tracking-[0.28em] text-white/55 ${kiosk ? "opacity-40 hover:opacity-100" : ""}`}>
      <a href="/" className="tracking-[0.42em] text-white">
        Triage Pod
      </a>
      <div className="flex items-center gap-5">
        {TABS.map((t) => {
          const base = t.match ?? t.href.split("?")[0];
          const on = path === base || path.startsWith(base);
          return (
            <a key={t.href} href={t.href} className={`pb-0.5 ${on ? "text-white" : "hover:text-white/80"}`} style={on ? { boxShadow: "inset 0 -1px 0 #fff" } : undefined}>
              {t.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
