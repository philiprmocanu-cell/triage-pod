import Link from "next/link";

const SCREENS = [
  { href: "/globe", title: "Satellite", what: "Eastern Province on live imagery. Thin corridors for every unique run, villages on the road, trucks on the ground. Layers for routes, movers, orders, tracks.", tag: "network" },
  { href: "/kiosk?village=Katete", title: "Patient pod", what: "Camera and voice triage in the patient's language. History first, danger signs before anything else, then the exact order.", tag: "pod" },
  { href: "/staff", title: "Operator", what: "Live mirror of the visit: the decision path, confident conditions only, the order, vitals.", tag: "pod" },
  { href: "/government", title: "Network", what: "Provincial view: stock against every post, satellite weather, vaccines due, and why a shipment left.", tag: "network" },
  { href: "/patients", title: "Patients", what: "Who is due which vaccine dose on Zambia's schedule.", tag: "network" },
  { href: "/community", title: "Community", what: "People going through a hard time paired with volunteers from their own village.", tag: "network" },
  { href: "/demo", title: "Three layers", what: "Hear a mosquito, do the visit for real, and watch the order land on the map. Your pod stays blue.", tag: "demo" },
  { href: "/mosquito", title: "Mosquito", what: "A wingbeat on this device. Species, and whether it carries malaria.", tag: "listener" },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white">
      <section className="border-b border-white/10 px-8 py-20 md:px-16">
        <p className="text-[11px] uppercase tracking-[0.42em] text-white/50">Triage Pod · Eastern Province · Zambia</p>
        <h1 className="mt-6 max-w-4xl text-4xl font-light leading-[1.1] tracking-tight md:text-6xl">
          The medicine exists.
          <br />
          It is not where the patient is.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-white/60">
          In Zambia, surveys found up to three in ten health facilities out of malaria drugs while the national warehouse had stock on the shelf. A pod at the village post names the need. The network moves the medicine along the real road, around weather, to that patient.
        </p>
        <div className="mt-10 flex flex-wrap gap-8 text-[11px] uppercase tracking-[0.28em]">
          <Link href="/demo" className="border-b border-white pb-1 text-white">
            Run the three layers
          </Link>
          <Link href="/kiosk?village=Katete" className="border-b border-white/25 pb-1 text-white/70 hover:text-white">
            Start a visit
          </Link>
          <Link href="/globe" className="border-b border-white/25 pb-1 text-white/70 hover:text-white">
            Satellite
          </Link>
          <Link href="/government" className="border-b border-white/25 pb-1 text-white/70 hover:text-white">
            Network
          </Link>
        </div>
      </section>

      <section className="grid border-b border-white/10 md:grid-cols-4">
        {[
          ["01", "A patient sits down. The pod looks, listens, and asks in their language."],
          ["02", "Only confident findings become an order. Nothing for a guess."],
          ["03", "The order travels from wherever the stock is, on a real vehicle, on a real road."],
          ["04", "If rain closes the road, the planner sends a boat, a bike, or a different corridor."],
        ].map(([n, t]) => (
          <div key={n} className="border-white/10 px-8 py-8 md:border-r md:last:border-r-0">
            <p className="text-[11px] uppercase tracking-[0.28em] text-white/40">{n}</p>
            <p className="mt-3 text-sm leading-relaxed text-white/70">{t}</p>
          </div>
        ))}
      </section>

      <section className="px-8 py-12 md:px-16">
        <div className="grid gap-px bg-white/10 md:grid-cols-2 xl:grid-cols-3">
          {SCREENS.map((s) => (
            <Link key={s.href} href={s.href} className="bg-black p-8 transition hover:bg-white/[0.03]">
              <p className="text-[10px] uppercase tracking-[0.28em] text-white/35">{s.tag}</p>
              <p className="mt-3 text-lg font-light tracking-tight">{s.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-white/50">{s.what}</p>
            </Link>
          ))}
        </div>
        <p className="mt-12 text-[10px] uppercase tracking-[0.22em] text-white/30">
          Not a medical device · Jev for decisions · Grok Voice for speech · Claude for words · SpacetimeDB for the live network · Esri imagery
        </p>
      </section>
    </div>
  );
}
