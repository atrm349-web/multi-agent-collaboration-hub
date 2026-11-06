import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { planWithCodex, validatePlan, type PlannerOptions } from "../../packages/core/planner.ts";
import type { PlannedSubtask } from "../../packages/shared/src/types.ts";
import type { CodexRequest, CodexResult } from "../../packages/agent-adapters/codex/runtime.ts";

function step(): PlannedSubtask {
  return { id: randomUUID(),code: "SUB-01",title: "Implement",description: "Implement a bounded function",stage: "implementation",
    dependsOn: [],requiredCapabilities: ["stream"],acceptanceCriteria: [{ id: randomUUID(),description: "Approved tests exit zero" }] };
}
const options = (): PlannerOptions => ({ goal: "Build and independently test a clamp function",cwd: "/fixture/workspace",workspaceRoot: "/fixture",
  repositoryId: randomUUID(),model: "gpt-6.1-sol",effort: "high",timeoutMs: 1000 });
function fixture(result: Partial<CodexResult>, inspect?: (request: CodexRequest) => void) {
  let cancelled = 0;
  return { get cancelled() { return cancelled; },
    async start(request: CodexRequest) { inspect?.(request); return "fixture-run"; },
    async wait(): Promise<CodexResult> { return { runId: "fixture-run",status: "succeeded",sessionId: null,result: "",exitCode: 0,error: null,...result }; },
    async cancel() { cancelled++; } };
}

test("validates an unordered DAG without rewriting IDs or the input", () => {
  const first = step(); const second = { ...step(),code: "SUB-02",stage: "testing" as const,dependsOn: [first.id] };
  const original = JSON.stringify([second,first]); const validated = validatePlan([second,first]);
  expect(validated.map((item) => item.id)).toEqual([second.id,first.id]);
  validated[0]!.dependsOn.push(randomUUID());
  validated[0]!.requiredCapabilities.push("cancel");
  expect(JSON.stringify([second,first])).toBe(original);
});

test("rejects empty, oversized and non-array plans", () => {
  for (const value of [[],{},null,Array.from({ length: 101 },() => step())]) expect(() => validatePlan(value)).toThrow("INVALID_INPUT");
});

test("rejects unknown fields and invalid stage/capability values", () => {
  for (const value of [{ ...step(),command: "rm -rf /" },{ ...step(),stage: "deploy" },{ ...step(),requiredCapabilities: ["antigravity"] },
    { ...step(),dependsOn: [7] },{ ...step(),requiredCapabilities: ["stream","stream"] },{ ...step(),title: " " }]) {
    expect(() => validatePlan([value])).toThrow("INVALID_INPUT");
  }
});

test("rejects duplicate UUIDs/codes, including UUID letter case aliases", () => {
  const first = step();
  expect(() => validatePlan([first,{ ...step(),code: "SUB-02",id: first.id.toUpperCase() }])).toThrow("unique");
  expect(() => validatePlan([first,step()])).toThrow("unique");
  expect(() => validatePlan([{ ...first,id: "SUB-01" }])).toThrow("unique");
});

test("rejects missing, duplicate, self and cyclic dependencies", () => {
  const a = step(); const b = { ...step(),code: "SUB-02" };
  expect(() => validatePlan([{ ...a,dependsOn: [randomUUID()] }])).toThrow("dependency");
  expect(() => validatePlan([{ ...a,dependsOn: [a.id] }])).toThrow("self");
  expect(() => validatePlan([{ ...a,dependsOn: [b.id,b.id] },b])).toThrow("unique");
  expect(() => validatePlan([{ ...a,dependsOn: [b.id] },{ ...b,dependsOn: [a.id] }])).toThrow("cycle");
});

test("requires independent structured acceptance criteria without injected command fields", () => {
  const a = step();
  for (const value of [{ ...a,acceptanceCriteria: [] },{ ...a,acceptanceCriteria: ["test"] },
    { ...a,acceptanceCriteria: [{ id: "AC-01",description: "ok",command: "anything" }] },
    { ...a,acceptanceCriteria: [{ id: "AC-01",description: "" }] }]) expect(() => validatePlan([value])).toThrow("INVALID_INPUT");
  const b = { ...step(),code: "SUB-02",acceptanceCriteria: a.acceptanceCriteria };
  expect(() => validatePlan([a,b])).toThrow("criterion IDs");
});

test("planning uses read-only runtime and returns coordinator-owned metadata", async () => {
  const plan = [step()]; const input = options();
  const runtime = fixture({ result: JSON.stringify({ subtasks: plan }) },(request) => {
    expect(request.sandbox).toBe("read-only"); expect(request.cwd).toBe(input.cwd);
    expect(request.prompt).toContain("Do not execute commands");
    expect(request.prompt).toContain(JSON.stringify(input.goal));
  });
  const result = await planWithCodex(input,runtime);
  expect(result.repositoryId).toBe(input.repositoryId); expect(result.goal).toBe(input.goal);
  expect(result.executionMode).toBe("live"); expect(result.subtasks).toEqual(plan); expect(runtime.cancelled).toBe(1);
});

test("planning never repairs markdown, malformed JSON or injected metadata", async () => {
  for (const output of ["```json\n{}\n```",JSON.stringify({ subtasks: [step()],executionMode: "mock" }),JSON.stringify([step()])]) {
    const runtime = fixture({ result: output });
    await expect(planWithCodex(options(),runtime)).rejects.toThrow("INVALID_INPUT");
    expect(runtime.cancelled).toBe(1);
  }
});

test("runtime errors propagate without a mock or heuristic fallback", async () => {
  for (const code of ["AUTH_REQUIRED","BINARY_NOT_FOUND","TIMEOUT"]) {
    const runtime = fixture({ status: "failed",error: { code,message: "fixture",retryable: false } });
    await expect(planWithCodex(options(),runtime)).rejects.toThrow(code);
    expect(runtime.cancelled).toBe(1);
  }
});

test("rejects invalid goal or repository before starting an Agent", async () => {
  let started = false; const runtime = fixture({},() => { started = true; });
  await expect(planWithCodex({ ...options(),goal: " " },runtime)).rejects.toThrow("INVALID_INPUT");
  await expect(planWithCodex({ ...options(),repositoryId: "arbitrary-path" },runtime)).rejects.toThrow("INVALID_INPUT");
  expect(started).toBe(false);
});
