// The question list, without a live visit: a 1–10 score must not be followed by "worst pain
// ever", and a movement test must still be offered after the spoken questions are used up.
import { armHold, armReadingDue, painScoreFromTurns, parsePainScore, settleSeverity, stepsWithinCap } from "../src/lib/triage/questions.ts";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

check("nine", parsePainScore("nine") === 9);
check("9/10", parsePainScore("I'd say 9/10") === 9);
check("out of ten", parsePainScore("seven out of ten") === 7);

const turns = [
  { role: "pod", asks: "history:severity", text: "From 1 to 10, how strong is it right now?" },
  { role: "patient", text: "Nine." },
];
check("score from the visit", painScoreFromTurns(turns) === 9);

const high = settleSeverity(9, false);
check("9 skips worst-ever", high.known.includes("worst_headache") && high.known.includes("severe_headache"));
check("9 is severe", high.severeYes === true);
check("9 alone is not a thunderclap", high.worstYes === false && high.askSudden === true);

const thunder = settleSeverity(9, true);
check("9 plus sudden is worst-ever", thunder.worstYes === true && thunder.askSudden === false);

const mild = settleSeverity(3, false);
check("3 is not severe and not worst", mild.severeYes === false && mild.worstYes === false && mild.askSudden === false);

const pain = [
  "probe:pain_story",
  "probe:pain_with",
  "bladder_control",
  "leg_weakness",
  "test:squat",
  "test:bend",
  "pain_on_bending",
  "fever",
];
const full = stepsWithinCap(pain, 4, 4);
check("movements survive a full question budget", full.includes("test:squat") && full.includes("test:bend") && !full.includes("bladder_control"), full.join(", "));

const early = stepsWithinCap(pain, 1, 4);
check("danger questions still come before the crouch", early[0] === "probe:pain_story" && early.includes("test:squat"), early.join(", "));

const stroke = stepsWithinCap(["test:smile", "face_or_arm_weakness", "test:arm_drift", "confused_speech", "test:walk_line"], 0, 4);
check("stroke still starts with the smile", stroke[0] === "test:smile" && stroke.includes("test:arm_drift") && stroke.includes("test:walk_line"), stroke.join(", "));

const heart = stepsWithinCap(["pain_spreads", "sweating", "short_of_breath", "sudden_onset", "test:pulse"], 4, 4);
check("pulse stays for its own step, not this list", !heart.includes("test:pulse") && heart.length === 0, heart.join(", ") || "empty");

check("chest asks for the arm", armReadingDue(["cardiac"], false) === true);
check("breathing asks for the arm", armReadingDue(["breathing"], false) === true);
check("fever asks for the arm", armReadingDue(["fever"], false) === true);
check("a headache does not ask for the arm", armReadingDue(["headache"], false) === false);
check("a pulse already showing is not asked again", armReadingDue(["cardiac", "breathing"], true) === false);
check("six steady seconds is enough", armHold(6, 6) === "done" && armHold(5, 5) === "read");
check("the arm wait stops at 18 seconds", armHold(0, 18) === "give-up" && armHold(0, 8) === "read");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nquestion list ok");
