import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HubStore } from "../packages/core/state/store.ts";
import { HubService, resolveRepository } from "../packages/core/hub.ts";
import { createHubHandler } from "../packages/core/http.ts";

async function main() {
  console.log("=== STARTING DEEPSEEK LIVE PARALLEL EXECUTION EXPERIMENT ===");
  const root = await mkdtemp(path.join(tmpdir(), "hub-parallel-deepseek-e2e-"));
  const repository = path.join(root, "source");
  await mkdir(repository, { recursive: true });
  await mkdir(path.join(root, "state"), { recursive: true });
  process.env.AGETOR_DATA_DIR = path.join(root, "state");

  execFileSync("/usr/bin/git", ["init", "-q", repository]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.name", "DeepSeek Coordinator"]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.email", "deepseek@example.invalid"]);

  const circleTest = `
const assert = require("assert");
const circle = require("./circle.js");
assert.strictEqual(typeof circle.area, "function", "circle.area must be function");
assert.strictEqual(typeof circle.circumference, "function", "circle.circumference must be function");
const cArea = circle.area(3);
const cCirc = circle.circumference(3);
assert(Math.abs(cArea - Math.PI * 9) < 1e-4, "Circle area mismatch: " + cArea);
assert(Math.abs(cCirc - 2 * Math.PI * 3) < 1e-4, "Circle circumference mismatch: " + cCirc);
console.log("CIRCLE_TESTS_PASSED");
`;

  const rectTest = `
const assert = require("assert");
const rectangle = require("./rectangle.js");
assert.strictEqual(typeof rectangle.area, "function", "rectangle.area must be function");
assert.strictEqual(typeof rectangle.perimeter, "function", "rectangle.perimeter must be function");
const rArea = rectangle.area(4, 5);
const rPerim = rectangle.perimeter(4, 5);
assert.strictEqual(rArea, 20, "Rectangle area mismatch: " + rArea);
assert.strictEqual(rPerim, 18, "Rectangle perimeter mismatch: " + rPerim);
console.log("RECTANGLE_TESTS_PASSED");
`;

  const geomTest = `
const assert = require("assert");
const circle = require("./circle.js");
const rectangle = require("./rectangle.js");
assert(Math.abs(circle.area(3) - Math.PI * 9) < 1e-4);
assert.strictEqual(rectangle.area(4, 5), 20);
console.log("INTEGRATED_GEOMETRY_TESTS_PASSED");
`;

  await writeFile(path.join(repository, "test_circle.js"), circleTest);
  await writeFile(path.join(repository, "test_rect.js"), rectTest);
  await writeFile(path.join(repository, "test_geom.js"), geomTest);
  await writeFile(path.join(repository, "README.md"), "# Geometry Library\nBaseline.\n");
  execFileSync("/usr/bin/git", ["-C", repository, "add", "."]);
  execFileSync("/usr/bin/git", ["-C", repository, "commit", "-qm", "initial baseline with test fixtures"]);

  const db = new Database(path.join(root, "state", "hub.sqlite"));
  const store = new HubStore(db, Date.now, 60_000, 2);

  const nodePath = Bun.which("node") || "/usr/local/bin/node";
  const repo = await resolveRepository({
    id: randomUUID(),
    label: "geometry-core",
    path: repository,
    defaultTestProfileId: "geom-tests",
    model: "deepseek-chat",
    effort: "low",
    testProfiles: [
      {
        id: "circle-tests",
        command: [nodePath, "test_circle.js"],
        timeoutMs: 15000,
      },
      {
        id: "rect-tests",
        command: [nodePath, "test_rect.js"],
        timeoutMs: 15000,
      },
      {
        id: "geom-tests",
        command: [nodePath, "test_geom.js"],
        timeoutMs: 15000,
      },
    ],
  });

  const service = new HubService(store, {
    root,
    repositories: [repo],
    maxConcurrency: 2,
  });

  const token = "d".repeat(64);
  const handler = createHubHandler({ service, token, port: 4328 });
  const post = async (route: string, body: unknown, key = randomUUID()) => {
    const res = await handler(
      new Request(`http://127.0.0.1:4328/api/v1/${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      })
    );
    const json = await res.json();
    return { status: res.status, data: (json as any).data, error: (json as any).error };
  };

  const step1Id = randomUUID();
  const step2Id = randomUUID();

  console.log("[1/4] Creating Task with 2 Parallel Subtasks (SUB-01 and SUB-02 both ready at start)...");
  const taskRes = await post("tasks", {
    title: "Geometry Core in Parallel",
    goal: "Implement circle.js and rectangle.js in parallel, and verify with tests",
    repositoryId: repo.id,
    acceptanceCriteria: [{ id: "geom-acceptance", description: "Geometry tests pass and audit approves", testProfileId: "geom-tests" }],
    plannedSubtasks: [
      {
        id: step1Id,
        code: "SUB-01",
        title: "Implement circle.js",
        description: "Create circle.js exporting { area: (r) => Math.PI * r * r, circumference: (r) => 2 * Math.PI * r }. DO NOT edit or create any other files.",
        stage: "implementation",
        dependsOn: [],
        requiredCapabilities: ["stream"],
        acceptanceCriteria: [{ id: "c-circ", description: "Circle formulas correct", testProfileId: "circle-tests" }],
      },
      {
        id: step2Id,
        code: "SUB-02",
        title: "Implement rectangle.js",
        description: "Create rectangle.js exporting { area: (w, h) => w * h, perimeter: (w, h) => 2 * (w + h) }. DO NOT edit or create any other files.",
        stage: "implementation",
        dependsOn: [],
        requiredCapabilities: ["stream"],
        acceptanceCriteria: [{ id: "c-rect", description: "Rectangle formulas correct", testProfileId: "rect-tests" }],
      },
    ],
  });

  if (taskRes.status !== 201) {
    console.error("Failed to create task:", taskRes.error);
    process.exit(1);
  }
  const taskId = taskRes.data.id;
  console.log(`Task created: ${taskId}`);

  console.log("[2/4] Monitoring live execution...");
  let maxParallelSeen = 0;
  const startTime = Date.now();
  const timeoutMs = 150_000;

  while (Date.now() - startTime < timeoutMs) {
    const task = store.get("task", taskId);
    const subtasks = store.list("subtask", taskId);
    const runs = store.list("run", taskId);
    const activeRuns = runs.filter((r) => r.status === "starting" || r.status === "running");

    if (activeRuns.length > maxParallelSeen) {
      maxParallelSeen = activeRuns.length;
    }

    const summary = subtasks.map((s) => `${s.code}(${s.status})`).join(" | ");
    console.log(`[+${Math.round((Date.now() - startTime) / 1000)}s] Task=${task.status} (${task.progressPct}%) ActiveRuns=${activeRuns.length} [MaxParallel=${maxParallelSeen}]: ${summary}`);

    if (task.status === "waiting_approval" || task.status === "failed" || task.status === "succeeded") {
      break;
    }
    await Bun.sleep(1500);
  }

  const task = store.get("task", taskId);
  if (task.status !== "waiting_approval") {
    console.error(`Task did not reach waiting_approval: status=${task.status}, error=${JSON.stringify(task.error)}`);
    process.exit(1);
  }

  console.log(`[3/4] Parallel execution SUCCESS! Max parallel active runs observed: ${maxParallelSeen}`);
  const approvals = store.list("approval", taskId);
  console.log(`Pending approvals: ${approvals.length}`);
  const finalApproval = approvals.find((a) => a.status === "pending");
  if (!finalApproval) {
    console.error("No pending approval found!");
    process.exit(1);
  }

  console.log(`[4/4] Approving final delivery (actionDigest=${finalApproval.actionDigest.slice(0, 16)}...)...`);
  const decisionRes = await post(`approvals/${finalApproval.id}/decision`, {
    expectedVersion: finalApproval.version,
    decision: "approve",
    actionDigest: finalApproval.actionDigest,
    comment: "Verified parallel delivery by DeepSeek autonomous agents",
  });
  console.log("Decision result status:", decisionRes.status);

  const completedTask = store.get("task", taskId);
  console.log("Final task status:", completedTask.status);
  console.log("Final task progress:", completedTask.progressPct, "%");

  const artifacts = store.list("artifact", taskId);
  console.log(`Generated ${artifacts.length} immutable artifacts:`);
  for (const art of artifacts) {
    console.log(` - [${art.category}] ${art.relativePath} (sha256=${art.sha256.slice(0, 12)}..., ${art.sizeBytes} bytes)`);
  }

  await service.close();
  db.close();
  await rm(root, { recursive: true, force: true });
  console.log("=== DEEPSEEK LIVE PARALLEL EXPERIMENT COMPLETED 100% SUCCESSFULLY ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
