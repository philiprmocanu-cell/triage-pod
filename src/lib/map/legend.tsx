"use client";

import { FLOOD_COLOR, KIND_COLOR, KIND_WORD } from "./routes";

// The small key under the map controls: one swatch per carrier kind, red for flood risk high,
// moving dashes, dim for delivered. The same on the live map and the routes page.
export function RouteLegend({ className = "" }: { className?: string }) {
  return (
    <div className={`route-legend flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 ${className}`} data-testid="route-legend">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">routes</span>
      {Object.entries(KIND_WORD).map(([k, w]) => (
        <span key={k} className="whitespace-nowrap">
          <i className="mr-1 inline-block h-[3px] w-5 rounded-sm align-middle" style={{ background: KIND_COLOR[k] }} />
          {w}
        </span>
      ))}
      <span className="whitespace-nowrap">
        <i className="mr-1 inline-block h-[3px] w-5 rounded-sm align-middle" style={{ background: FLOOD_COLOR }} />
        Flood risk high
      </span>
      <span className="whitespace-nowrap">
        <i className="mr-1 inline-block h-[3px] w-5 align-middle" style={{ backgroundImage: "repeating-linear-gradient(90deg,#e2e8f0 0 4px,transparent 4px 7px)" }} />
        Moving
      </span>
      <span className="whitespace-nowrap">
        <i className="mr-1 inline-block h-[3px] w-5 rounded-sm align-middle opacity-30" style={{ background: "#e2e8f0" }} />
        Delivered
      </span>
      <span className="whitespace-nowrap">
        <i className="mr-1 inline-grid h-3 w-3 place-items-center rounded-full bg-teal-700 align-middle font-mono text-[8px] font-bold not-italic text-teal-50" style={{ boxShadow: "0 0 0 1.5px #99f6e4" }}>2</i>
        Stop on a multi-stop run
      </span>
    </div>
  );
}
