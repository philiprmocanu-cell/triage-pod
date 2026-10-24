// What the dispatch brain keeps on disk (data/dispatch.json): the last plan it made and its own
// log lines. The log is the stand-in for the `log_agent` reducer until the module has one; once
// the reducer exists the same lines go to `agent_log` as well, and the pages merge both.

import { promises as fs } from "fs";
import path from "path";
import type { DispatchPlan } from "./plan";

export type DispatchLogLine = { id: number; at: string; agent: "Dispatch planner"; villageId: number; village: string; text: string; where: "agent_log" | "file" };
export type Execution = { at: string; shipmentIds: string[]; orders: { id: number; toVillageId: number; item: string; qty: number; mode: string; via: "restock" | "report_visit" }[]; routed: number; notes: string[] };
type Store = { lastPlan: DispatchPlan | null; log: DispatchLogLine[]; executions: Execution[] };

const FILE = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "dispatch.json");
const KEEP_LOG = 120;

export async function readStore(): Promise<Store> {
  try {
    const s = JSON.parse(await fs.readFile(FILE(), "utf8")) as Partial<Store>;
    return { lastPlan: s.lastPlan ?? null, log: s.log ?? [], executions: s.executions ?? [] };
  } catch {
    return { lastPlan: null, log: [], executions: [] };
  }
}

async function writeStore(s: Store) {
  await fs.mkdir(path.dirname(FILE()), { recursive: true });
  await fs.writeFile(FILE(), JSON.stringify(s, null, 1));
}

export async function savePlan(plan: DispatchPlan) {
  const s = await readStore();
  s.lastPlan = plan;
  await writeStore(s);
}

export async function appendLog(lines: Omit<DispatchLogLine, "id" | "agent">[]) {
  const s = await readStore();
  let id = s.log.reduce((m, l) => Math.max(m, l.id), 0);
  for (const l of lines) s.log.push({ id: ++id, agent: "Dispatch planner", ...l });
  s.log = s.log.slice(-KEEP_LOG);
  await writeStore(s);
}

export async function appendExecution(e: Execution) {
  const s = await readStore();
  s.executions = [...s.executions, e].slice(-20);
  await writeStore(s);
}

export async function clearStore() {
  await writeStore({ lastPlan: null, log: [], executions: [] });
}
