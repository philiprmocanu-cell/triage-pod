"use client";

import { useEffect, useRef, useState } from "react";
import { Recorder } from "@/lib/audio";

// A local health worker reads one paragraph; Cartesia clones their voice and the pod speaks with
// that community's accent from then on. Only for consenting staff, never patients.
const PASSAGE: Record<string, string> = {
  es: "Buenos días. Soy promotora de salud de esta comunidad. Aquí cuidamos a las familias, a los niños y a los abuelos. Si alguien tiene calentura, tos o algún dolor, venga a vernos, que con gusto le atendemos.",
  en: "Good morning. I am a health worker in this community. We take care of families, children and grandparents here. If anyone has a fever, a cough or any pain, come and see us.",
};
const SECONDS = 12;

export default function TeachAccent({ locale, onClose }: { locale: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "recording" | "saving" | "done">("idle");
  const [left, setLeft] = useState(SECONDS);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rec = useRef(new Recorder());
  const lang = locale.split("-")[0] === "en" ? "en" : "es";

  useEffect(() => {
    fetch(`/api/clone?locale=${locale}`)
      .then((r) => r.json())
      .then((d) => setCurrent(d.voice?.name ?? null))
      .catch(() => {});
  }, [locale, state]);

  const record = async () => {
    setError("");
    try {
      await rec.current.start();
      setState("recording");
      for (let s = SECONDS; s > 0; s--) {
        setLeft(s);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const wav = await rec.current.stop();
      setState("saving");
      const form = new FormData();
      form.append("clip", wav, "voice.wav");
      form.append("locale", locale);
      form.append("name", name.trim() || "Health worker");
      const res = await fetch("/api/clone", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not learn the voice");
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };

  const reset = async () => {
    await fetch(`/api/clone?locale=${locale}`, { method: "DELETE" });
    setState("idle");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Teach the pod our accent</h2>
            <p className="text-sm text-slate-400">
              A local health worker reads the text below. The pod will speak to patients in {locale} with this voice.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="text-sm text-slate-300">
          Voice now: <span className="font-semibold">{current ?? "built-in regional voice"}</span>
          {current && (
            <button onClick={reset} className="ml-2 text-xs text-sky-400 underline">
              use built-in voice
            </button>
          )}
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Health worker's name"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          disabled={state !== "idle"}
        />
        <blockquote className="rounded-xl bg-slate-800 p-4 text-lg leading-relaxed">{PASSAGE[lang]}</blockquote>
        <p className="text-xs text-slate-500">Only with the speaker&apos;s permission. Never used on patients.</p>
        {state === "idle" && (
          <button onClick={record} className="w-full rounded-xl bg-sky-600 py-3 font-semibold hover:bg-sky-500">
            Start reading ({SECONDS} s)
          </button>
        )}
        {state === "recording" && <p className="rounded-xl bg-red-700 py-3 text-center font-semibold">Recording… {left}s</p>}
        {state === "saving" && <p className="rounded-xl bg-slate-800 py-3 text-center">Learning the voice…</p>}
        {state === "done" && <p className="rounded-xl bg-emerald-700 py-3 text-center font-semibold">Done — the pod now speaks with this voice.</p>}
        {error && <p className="text-sm text-red-300">{error}</p>}
      </div>
    </div>
  );
}
