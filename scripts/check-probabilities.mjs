// Prints Jev's probability beside the percent the pod used to show and the percent it shows now.
// Run: node scripts/check-probabilities.mjs
// The cases are the spoken complaints in src/lib/triage/confidence.ts. This file repeats the
// arithmetic so it runs with plain node. Keep the two formulas in step.

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function conditionProbability(jev, area, saidTrigger) {
  const p = clamp01(jev);
  if (p < 0.02) return 0;
  const weight = saidTrigger ? 1 : clamp01(area);
  return Math.round(p * weight * 1000) / 1000;
}
function legacyProbability(jev, area, questionsAnswered) {
  const discount = Math.min(1, 0.35 + 0.15 * questionsAnswered);
  return Math.round(clamp01(area) * clamp01(jev) * discount * 1000) / 1000;
}

const cases = [
  { name: "Chest pain with spread and sweat", condition: "Heart attack", jev: 0.74, area: 0.92, saidTrigger: true, questionsAnswered: 3 },
  { name: "Chest pain, early, one answer", condition: "Heart attack", jev: 0.41, area: 0.88, saidTrigger: true, questionsAnswered: 1 },
  { name: "Chest pain that sounds muscular", condition: "Muscle or reflux pain", jev: 0.71, area: 0.9, saidTrigger: true, questionsAnswered: 4 },
  { name: "Vague 'I feel unwell', Jev only leans chest", condition: "Heart attack", jev: 0.4, area: 0.22, saidTrigger: false, questionsAnswered: 0 },
  { name: "Cough for two days, no danger signs", condition: "Common cold", jev: 0.66, area: 0.9, saidTrigger: true, questionsAnswered: 2 },
  { name: "Fever and chills in a malaria area", condition: "Malaria", jev: 0.58, area: 0.93, saidTrigger: true, questionsAnswered: 2 },
  { name: "Healthy person, face in frame, nothing said", condition: "Stroke", jev: 0.14, area: 0, saidTrigger: false, questionsAnswered: 0 },
];

const pct = (n) => `${Math.round(n * 100)}%`;
let drifted = 0;
console.log("condition                         Jev    old screen   now");
for (const c of cases) {
  const now = conditionProbability(c.jev, c.area, c.saidTrigger);
  const old = legacyProbability(c.jev, c.area, c.questionsAnswered);
  if (c.saidTrigger && Math.abs(now - c.jev) > 0.001) drifted++;
  console.log(
    `${c.condition.padEnd(32)} ${pct(c.jev).padStart(4)}   ${pct(old).padStart(6)}      ${pct(now).padStart(4)}   ${c.name}`,
  );
}
if (drifted) {
  console.error(`\n${drifted} case(s) changed Jev's number after the patient had already said the trigger.`);
  process.exit(1);
}
console.log("\nWhen the patient said the trigger, the percent on screen matches Jev.");
console.log("A resting face does not open stroke, so the last row stays at 0%.");
