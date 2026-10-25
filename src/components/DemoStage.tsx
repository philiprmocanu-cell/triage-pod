"use client";

import { useEffect, useState } from "react";

const VILLAGE = "Katete";

const LAYERS = [
  {
    id: "hear",
    n: "01",
    title: "Hear",
    note: "A specific mosquito is drawn on the village. A weak guess is not.",
    src: `/mosquito?village=${VILLAGE}&embed=1`,
  },
  {
    id: "visit",
    n: "02",
    title: "Visit",
    note: "Say what you feel. The pod decides from that, including your name.",
    src: `/kiosk?village=${VILLAGE}&embed=1`,
  },
  {
    id: "map",
    n: "03",
    title: "Map",
    note: "Your pod stays blue. Other places keep coming in. An order flies here.",
    src: "/globe?embed=1",
  },
] as const;

type Focus = (typeof LAYERS)[number]["id"];

export default function DemoStage() {
  const [focus, setFocus] = useState<Focus>("hear");
  const [heard, setHeard] = useState<string | null>(null);
  const [order, setOrder] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const pull = async () => {
      try {
        const sight = await fetch(`/api/mosquito/sightings?village=${VILLAGE}&days=7`).then((r) => r.json());
        if (!stop) setHeard(sight.mapped ?? null);
      } catch {
        /* the panes still work */
      }
      try {
        const visits = (await fetch("/api/registry").then((r) => r.json())) as { village?: string | null; orders?: { item: string; qty: number }[]; createdAt?: string }[];
        const mine = [...(Array.isArray(visits) ? visits : [])]
          .filter((v) => (v.village ?? "").toLowerCase().startsWith(VILLAGE.toLowerCase()))
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        const last = mine.at(-1);
        const line = last?.orders?.map((o) => o.item).filter(Boolean).join(", ");
        if (!stop) setOrder(line || null);
      } catch {
        /* registry can be empty */
      }
      if (!stop) timer = window.setTimeout(pull, 3000);
    };
    void pull();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <section className="flex h-[calc(100vh-2.75rem)] flex-col bg-black text-white">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 px-6 py-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.42em] text-white/45">{VILLAGE} · three layers</p>
          <h1 className="mt-1 text-2xl font-light tracking-tight">One village, end to end</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {LAYERS.map((layer) => {
            const on = focus === layer.id;
            return (
              <button
                key={layer.id}
                type="button"
                onClick={() => setFocus(layer.id)}
                className={`px-4 py-2 text-left text-[11px] uppercase tracking-[0.22em] ${on ? "bg-white text-black" : "border border-white/25 text-white/70"}`}
              >
                {layer.n} {layer.title}
              </button>
            );
          })}
        </div>
      </header>
      <p className="border-b border-white/10 px-6 py-2 text-xs text-white/50">
        {LAYERS.find((l) => l.id === focus)?.note}
        {heard ? ` · Heard ${heard}` : ""}
        {order ? ` · Ordered ${order}` : ""}
      </p>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-6">
        {LAYERS.map((layer) => {
          const on = focus === layer.id;
          return (
            <div key={layer.id} className={`min-h-0 border-white/10 ${on ? "lg:col-span-4" : "lg:col-span-1"} ${on ? "" : "hidden lg:block"} border-l`}>
              <iframe title={layer.title} src={layer.src} className="h-full w-full bg-black" />
            </div>
          );
        })}
      </div>
    </section>
  );
}
