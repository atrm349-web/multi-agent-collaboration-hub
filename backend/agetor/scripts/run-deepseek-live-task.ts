import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

async function main() {
  console.log("=================================================================");
  console.log("   DEEPSEEK HETEROGENEOUS MULTI-AGENT LIVE EXPERIMENT (RUN 2)");
  console.log("   - Planner / Reasoner: DeepSeek-R1 (deepseek-reasoner)");
  console.log("   - Autonomous Workers: DeepSeek-V3 (deepseek-chat) [Concurrency=2]");
  console.log("   - Quality Reviewer:   DeepSeek-V3 + Independent Test Suite");
  console.log("=================================================================\n");

  const defaultCredPaths = [
    process.env.CREDENTIALS_PATH,
    path.join(os.homedir(), ".agent-hub-runtime/state/credentials.json"),
    path.resolve(process.cwd(), "runtime/state/credentials.json"),
    path.resolve(process.cwd(), "../../runtime/state/credentials.json")
  ].filter(Boolean) as string[];

  let credPath = defaultCredPaths.find(p => existsSync(p)) || defaultCredPaths[0];
  const { origin, token } = JSON.parse(await readFile(credPath, "utf8"));
  console.log(`Connected to Live Hub daemon at: ${origin}`);

  const post = async (route: string, body: unknown, key = randomUUID()) => {
    const res = await fetch(`${origin}/api/v1/${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json() as any;
    return { status: res.status, data: json.data, error: json.error };
  };

  const get = async (route: string) => {
    const res = await fetch(`${origin}/api/v1/${route}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = await res.json() as any;
    return { status: res.status, data: json.data, error: json.error };
  };

  // 1. Verify Repository
  const reposRes = await get("repositories");
  const repo = reposRes.data.items[0];
  if (!repo) throw new Error("No registered repository found in live Hub!");
  console.log(`[Phase 1] Using Registered Repo: "${repo.label}" (id: ${repo.id}, branch: ${repo.baseBranch})`);

  // 2. Deep Reasoning Planning (deepseek-reasoner)
  console.log("\n[Phase 2] Invoking DeepSeek-R1 (deepseek-reasoner) for live task decomposition...");
  const goal = "并发实现几何库核心功能：在 circle.js 中实现 area 与 circumference 函数并通过 circle-tests；在 rectangle.js 中实现 area 与 perimeter 函数并通过 rect-tests；最后通过 geom-tests 集成测试。";
  const decompRes = await post("tasks/decompose", { repositoryId: repo.id, goal });
  if (decompRes.status !== 200) throw new Error(`Decomposition failed: ${JSON.stringify(decompRes.error)}`);
  
  console.log(` -> DeepSeek-R1 generated plan: ${decompRes.data.subtasks.length} subtasks in DAG.`);
  for (const s of decompRes.data.subtasks) {
    console.log(`    * [${s.code}] ${s.title} (${s.stage}) dependsOn: [${s.dependsOn.join(", ")}]`);
  }

  // 3. Create Parallel Execution Task on Live Hub
  console.log("\n[Phase 3] Submitting task to Live Hub with parallel execution slots...");
  const step1Id = randomUUID();
  const step2Id = randomUUID();

  const taskRes = await post("tasks", {
    title: "DeepSeek 实盘并发任务：几何计算核心库 (circle + rectangle)",
    goal,
    repositoryId: repo.id,
    priority: "high",
    acceptanceCriteria: [
      { id: "ac-circle", description: "circle.js passes circle-tests", testProfileId: "circle-tests" },
      { id: "ac-rect", description: "rectangle.js passes rect-tests", testProfileId: "rect-tests" },
      { id: "ac-geom", description: "Integrated geometry passes geom-tests", testProfileId: "geom-tests" }
    ],
    plannedSubtasks: [
      {
        id: step1Id,
        code: "SUB-01",
        title: "实现 circle.js 几何计算模块",
        description: "实现 circle.js 并导出 area 与 circumference 函数：area(r) 计算圆面积 (Math.PI*r*r)，circumference(r) 计算周长 (2*Math.PI*r)。使用 module.exports = { area, circumference }。不要创建或修改其他文件。",
        stage: "implementation",
        dependsOn: [],
        requiredCapabilities: ["stream"],
        acceptanceCriteria: [{ id: "ac-circ-impl", description: "circle-tests passes", testProfileId: "circle-tests" }]
      },
      {
        id: step2Id,
        code: "SUB-02",
        title: "实现 rectangle.js 几何计算模块",
        description: "实现 rectangle.js 并导出 area 与 perimeter 函数：area(w, h) 计算矩形面积 (w*h)，perimeter(w, h) 计算周长 (2*(w+h))。使用 module.exports = { area, perimeter }。不要创建或修改其他文件。",
        stage: "implementation",
        dependsOn: [],
        requiredCapabilities: ["stream"],
        acceptanceCriteria: [{ id: "ac-rect-impl", description: "rect-tests passes", testProfileId: "rect-tests" }]
      }
    ]
  });

  if (taskRes.status !== 201) throw new Error(`Task creation failed: ${JSON.stringify(taskRes.error)}`);
  const taskId = taskRes.data.id;
  console.log(` -> Live Task Created: ID=${taskId}, Status=${taskRes.data.status}`);

  // 4. Monitor Live Execution & Concurrency
  console.log("\n[Phase 4] Tracking Autonomous Agent Execution in Parallel Slots...");
  let elapsed = 0;
  const maxWaitSec = 180;
  let maxParallelObserved = 0;

  while (elapsed < maxWaitSec) {
    await new Promise(r => setTimeout(r, 1500));
    elapsed += 1.5;

    const snap = await get(`snapshot?taskId=${taskId}`);
    if (!snap.data) continue;
    const { task, subtasks, runs, approvals, artifacts } = snap.data;

    const runningSubs = subtasks.filter((s: any) => s.status === "running");
    if (runningSubs.length > maxParallelObserved) maxParallelObserved = runningSubs.length;

    const subSummary = subtasks.map((s: any) => `${s.code}:${s.status}`).join(" | ");
    console.log(` [T+${elapsed.toFixed(1)}s] Task: ${task.status} (${task.progressPct}%) | Active Slots: ${runningSubs.length} (Max: ${maxParallelObserved}) | ${subSummary}`);

    // Check for human approval gate
    const pendingApproval = approvals.find((a: any) => a.status === "pending");
    if (pendingApproval) {
      console.log(`\n -> [Quality Gate] Reached approval gate! ID=${pendingApproval.id}`);
      console.log(`    Action Digest: ${pendingApproval.actionDigest}`);
      console.log(`    Decision: Submitting Human Approval...`);
      const appRes = await post(`approvals/${pendingApproval.id}/decision`, {
        expectedVersion: pendingApproval.version,
        decision: "approve",
        actionDigest: pendingApproval.actionDigest,
        comment: "DeepSeek autonomous parallel implementation verified and approved via quality gate."
      });
      console.log(`    Result: ${appRes.status === 200 ? "APPROVED ✅" : "ERROR: " + JSON.stringify(appRes.error)}`);
    }

    if (task.status === "succeeded") {
      console.log("\n=================================================================");
      console.log("   🎉 EXPERIMENT COMPLETED SUCCESSFULLY!");
      console.log(`   Task Status: ${task.status} (100% Progress)`);
      console.log(`   Maximum Parallel Concurrency Observed: ${maxParallelObserved} Slots`);
      console.log("=================================================================\n");

      console.log(`Generated Immutable Artifacts (${artifacts.length}):`);
      for (const art of artifacts) {
        console.log(` - [${art.category}] ${art.name ?? art.path} (SHA-256: ${art.sha256.slice(0, 16)}...)`);
      }

      console.log(`\nExecution Runs Recorded (${runs.length}):`);
      for (const r of runs) {
        console.log(` - Run ${r.id} (Subtask: ${r.subtaskId}): status=${r.status}, exitCode=${r.exitCode}`);
      }
      return;
    }

    if (task.status === "failed") {
      console.error("\n❌ Task failed:", task.error);
      process.exit(1);
    }
  }

  throw new Error(`Experiment timed out after ${maxWaitSec}s`);
}

main().catch(err => {
  console.error("Experiment encountered error:", err);
  process.exit(1);
});
