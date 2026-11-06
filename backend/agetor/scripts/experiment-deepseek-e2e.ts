import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { HubService, type RegisteredRepository } from "../packages/core/hub.ts";
import { HubStore } from "../packages/core/state/store.ts";
import { Database } from "bun:sqlite";
import schema from "../src/bun/migrations/083_hub_service.sql" with { type: "text" };
import { migrate } from "../src/bun/migrate.ts";

console.log("=== Starting DeepSeek Live End-to-End Experiment ===");

// 1. Setup isolated directories
const base = await mkdtemp(path.join(tmpdir(), "deepseek-e2e-"));
const root = path.join(base, "runtime");
const repoDir = path.join(base, "source-repo");
await mkdir(root, { recursive: true });
await mkdir(repoDir, { recursive: true });

process.env.AGETOR_DATA_DIR = path.join(root, "state");
await mkdir(process.env.AGETOR_DATA_DIR, { recursive: true, mode: 0o700 });

// 2. Initialize Git fixture repository
console.log("[1/5] Initializing fixture Git repository...");
execFileSync("/usr/bin/git", ["init", "-q", repoDir]);
execFileSync("/usr/bin/git", ["-C", repoDir, "config", "user.name", "DeepSeek Experimenter"]);
execFileSync("/usr/bin/git", ["-C", repoDir, "config", "user.email", "deepseek@experiment.invalid"]);

// Initial commit with a stub function and a package.json
await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "smart-car-demo", version: "1.0.0" }, null, 2));
await writeFile(path.join(repoDir, "math_utils.js"), "// Stub implementation\nfunction calculate_distortion(k1, k2, r) {\n    return 0.0;\n}\nmodule.exports = { calculate_distortion };\n");

execFileSync("/usr/bin/git", ["-C", repoDir, "add", "."]);
execFileSync("/usr/bin/git", ["-C", repoDir, "commit", "-qm", "initial commit"]);
const baseCommit = execFileSync("/usr/bin/git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
console.log(` -> Base commit: ${baseCommit}`);

// 3. Define registered test profile and repository
const repoId = randomUUID();
const nodePath = "/usr/local/bin/node";
const registeredRepo: RegisteredRepository = {
  id: repoId,
  label: "Smart Car Calibration Repository",
  path: repoDir,
  baseBranch: "main",
  baseCommit,
  model: "deepseek-chat",
  effort: "low",
  defaultTestProfileId: "verify-math",
  testProfiles: [
    {
      id: "verify-math",
      command: [
        nodePath,
        "-e",
        "const { calculate_distortion } = require('./math_utils.js'); const res = calculate_distortion(0.1, 0.05, 2.0); if (Math.abs(res - 1.2) > 1e-4) throw new Error('Assertion failed: ' + res); console.log('MATH_CALIBRATION_PASSED');"
      ],
      timeoutMs: 15000,
    }
  ]
};

// 4. Initialize HubStore & HubService
console.log("[2/5] Initializing HubService with DeepSeek model...");
const db = new Database(":memory:");
migrate(db, [{ id: "083_hub_service", sql: schema }]);
const store = new HubStore(db);
const service = new HubService(store, {
  root,
  repositories: [registeredRepo]
});

// 5. Test Live DeepSeek Planning (Decompose)
console.log("[3/5] Testing DeepSeek Live Decomposition...");
const goal = "智能车标定算法：在 math_utils.js 中实现正确的畸变系数公式 calculate_distortion(k1, k2, r) = k1*(r**2) + k2*(r**4)，并使用 module.exports = { calculate_distortion } 导出，使 (0.1, 0.05, 2.0) 结果恰好为 1.2";
const draftPlan = await service.decompose({
  goal,
  repositoryId: repoId
});

console.log(` -> DeepSeek generated ${draftPlan.subtasks.length} subtasks in DAG.`);
for (const step of draftPlan.subtasks) {
  console.log(`    - [${step.code}] ${step.title} (${step.stage}), dependsOn: [${step.dependsOn.join(", ")}]`);
}

// 6. Test Task Creation
console.log("[4/5] Creating task in HubService...");
const task = await service.create({
  title: "实现智能车标定畸变计算",
  goal,
  repositoryId: repoId,
  priority: "high",
  acceptanceCriteria: [
    {
      id: "ac-calibration-math",
      description: "math_utils.js calculate_distortion(0.1, 0.05, 2.0) equals 1.2",
      testProfileId: "verify-math"
    }
  ],
  plannedSubtasks: draftPlan.subtasks.filter(s => s.code !== "FINAL-REVIEW")
});

console.log(` -> Task created: id=${task.id}, status=${task.status}, priority=${task.priority}`);

// 7. Execute Subtasks with DeepSeek Agent
console.log("[5/5] Executing subtask via DeepSeek Autonomous Agent in Worktree...");
let tickCount = 0;
const maxTicks = 120;

while (tickCount < maxTicks) {
  tickCount++;
  await service.tick();
  const currentTask = store.get("task", task.id);
  const subtasks = store.list("subtask", task.id);
  const approvals = store.list("approval", task.id);

  const subSummary = subtasks.map(s => `${s.code}(att${s.attempt}):${s.status}`).join(", ");
  console.log(` [Tick ${tickCount}] Task: ${currentTask.status} (progress: ${currentTask.progressPct}%), Subtasks: ${subSummary}`);

  if (approvals.some(a => a.status === "pending")) {
    const pendingApproval = approvals.find(a => a.status === "pending")!;
    console.log(` -> Reached human approval gate! Approval ID: ${pendingApproval.id}`);
    console.log(" -> Simulating Human Approval (Acceptance)...");
    await service.decideApproval(pendingApproval.id, {
      expectedVersion: pendingApproval.version,
      decision: "approve",
      actionDigest: pendingApproval.actionDigest,
      comment: "DeepSeek autonomous implementation approved after quality gate pass."
    });
    console.log(" -> Approval granted!");
  }

  if (currentTask.status === "succeeded") {
    console.log("=== EXPERIMENT SUCCESSFUL: Task reached 'succeeded' with 100% completion! ===");
    const artifacts = store.list("artifact", task.id);
    console.log(` -> Generated ${artifacts.length} immutable artifacts.`);
    for (const art of artifacts) {
      console.log(`    - Artifact [${art.category}]: ${art.id} (sha256=${art.sha256.slice(0, 16)}...)`);
    }
    const runs = store.list("run", task.id);
    console.log(` -> Total Agent runs recorded: ${runs.length}`);
    for (const r of runs) {
      console.log(`    - Run ${r.id} (subtask=${r.subtaskId}, attempt=${r.attempt}): status=${r.status}, exitCode=${r.exitCode}`);
    }
    break;
  }

  if (currentTask.status === "failed") {
    console.error("Task failed with error:", currentTask.error);
    const testReports = store.db.query<{data: string}, [string]>("SELECT data FROM hub_entities WHERE kind='artifact' AND task_id=? AND json_extract(data,'$.category')='test_report'").all(task.id);
    console.log(` -> Found ${testReports.length} test report artifacts:`);
    for (const r of testReports) {
      const art = JSON.parse(r.data);
      console.log(`    - Test Report [${art.name}]:`, art.content ?? art.path);
      try {
        const full = await readFile(path.join(root, art.path), "utf8");
        console.log("      Content:", full);
      } catch (e) {
        console.log("      Read error:", e);
      }
    }
    const messages = store.list("message", task.id);
    console.log(` -> Found ${messages.length} messages:`);
    for (const m of messages) {
      console.log(`    - Message [${m.kind}]: ${m.summary} -> ${m.content}`);
    }
    const runs = store.list("run", task.id);
    for (const r of runs) {
      console.log(`    - Run ${r.id} (subtask=${r.subtaskId}, attempt=${r.attempt}): status=${r.status}, error=${JSON.stringify(r.error)}`);
    }
    break;
  }

  await new Promise(r => setTimeout(r, 1000));
}

await service.close();
await rm(base, { recursive: true, force: true });
console.log("=== End-to-End DeepSeek Experiment Finished Cleanly ===");
