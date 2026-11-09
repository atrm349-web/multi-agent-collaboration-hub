// DS-02 fixture validator — offline check that the payload I will POST is
// accepted by the SAME validation the hub applies, before any real model call.
// Reproduces HubService.create()'s checks without touching a live service.
import { validatePlan } from "/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/core/planner.ts";

const IMPL_ID = "55555555-5555-4555-8555-555555555555";

// Exactly the object that drive-s1.ts will send as `plannedSubtasks`.
export const plannedSubtasks = [{
  id: IMPL_ID,
  code: "IMPL",
  title: "Implement formatAmount",
  description: "Implement src/amount.mjs exporting formatAmount(minorUnits) that returns a human-readable RMB string with two decimals.",
  stage: "implementation" as const,
  dependsOn: [],
  requiredCapabilities: ["stream" as const],
  acceptanceCriteria: [{ id: "AC-AMOUNT", description: "owner acceptance test (node owner-tests/check.mjs) exits 0", testProfileId: "acceptance" }],
}];

export const taskCriteria = [{ id: "AC-FINAL", description: "Final delivery still passes the owner acceptance test", testProfileId: "acceptance" }];

const capabilities = ["stream", "resume", "cancel", "structured-output"];
const profiles = ["acceptance"];

function hubCriteria(value: { id: string; description: string; testProfileId: string }[]) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("INVALID_INPUT: acceptance criteria required");
  const seen = new Set<string>();
  for (const c of value) {
    if (typeof c.id !== "string" || !c.id || c.id.length > 128) throw new Error(`INVALID_INPUT: criterion id ${c.id}`);
    if (typeof c.description !== "string" || !c.description.trim() || c.description.length > 2000) throw new Error(`INVALID_INPUT: criterion description ${c.id}`);
    if (seen.has(c.id)) throw new Error(`INVALID_INPUT: duplicate criterion ${c.id}`);
    if (!profiles.includes(c.testProfileId)) throw new Error(`INVALID_INPUT: unknown test profile ${c.testProfileId}`);
    seen.add(c.id);
  }
  return true;
}

const steps = validatePlan(plannedSubtasks);
console.log("validatePlan: OK ->", steps.map((s) => `${s.code}:${s.stage}`).join(", "));
if (steps.some((s) => s.code === "FINAL-REVIEW")) throw new Error("reserved code collision");
if (steps.length >= 100) throw new Error("plan too long");
if (steps.some((s) => s.stage === "analysis")) throw new Error("analysis is refused by create()");
for (const s of steps) {
  if (s.requiredCapabilities.some((c) => !capabilities.includes(c))) throw new Error(`unsupported capability in ${s.code}`);
  hubCriteria(s.acceptanceCriteria.map((c) => ({ id: c.id, description: c.description, testProfileId: c.testProfileId! })));
}
hubCriteria(taskCriteria);
console.log("hub criteria checks: OK");
console.log("auto-added FINAL-REVIEW would depend on:", steps.filter((s) => !steps.some((c) => c.dependsOn.includes(s.id))).map((s) => s.code));
console.log("FIXTURE_VALID");
