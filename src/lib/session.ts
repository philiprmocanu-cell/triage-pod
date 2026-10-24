// The live visit, shared between the patient-facing pod screen (/kiosk) and the health worker's
// screen (/staff). One pod per server is enough for a demo; vitals typed by the health worker
// flow into the next triage step.

export type Vitals = { spo2?: number; hr?: number; tempC?: number; sys?: number; dia?: number; glucose?: number; podConnected?: boolean; finger?: boolean; presses?: number; at?: number };
type Session = { state: unknown; vitals: Vitals; updatedAt: number };

const g = globalThis as unknown as { __session?: Session };
const session = () => (g.__session ??= { state: null, vitals: {}, updatedAt: 0 });

export const getSession = () => session();
export const getVitals = () => session().vitals;
export function setState(state: unknown) {
  const s = session();
  s.state = state;
  s.updatedAt = Date.now();
}
export function setVitals(v: Vitals) {
  const s = session();
  s.vitals = { ...s.vitals, ...v, at: Date.now() };
  s.updatedAt = Date.now();
}
export function resetSession() {
  g.__session = { state: null, vitals: {}, updatedAt: Date.now() };
}
