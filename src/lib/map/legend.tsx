"use client";

import { FLOOD_COLOR, KIND_COLOR, KIND_WORD } from "./routes";

export function RouteLegend({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.18em] text-white/45 ${className}`}>
      {Object.entries(KIND_WORD).map(([k, w]) => (
        <span key={k} className="whitespace-nowrap text-white/70">
          <i className="mr-1.5 inline-block h-px w-4 align-middle" style={{ background: KIND_COLOR[k] }} />
          {w}
        </span>
      ))}
      <span className="whitespace-nowrap text-white/70">
        <i className="mr-1.5 inline-block h-px w-4 align-middle" style={{ background: FLOOD_COLOR }} />
        Flood
      </span>
    </div>
  );
}
