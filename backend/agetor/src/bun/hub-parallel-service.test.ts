import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HubStore } from "../../packages/core/state/store.ts";
import { HubService, resolveRepository } from "../../packages/core/hub.ts";
import { createHubHandler } from "../../packages/core/http.ts";

test("interruption recovery via HTTP endpoint frees quarantined slot and restores liveExecutionAvailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-recovery-"));
  const old = process.env.AGETOR_DATA_DIR;
  const repository = path.join(root, "source");
  await mkdir(repository);
  await mkdir(path.join(root, "state"));
  process.env.AGETOR_DATA_DIR = path.join(root, "state");

  execFileSync("/usr/bin/git", ["init", "-q", repository]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.name", "Fixture"]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repository, "README.md"), "# Initial\n");
  execFileSync("/usr/bin/git", ["-C", repository, "add", "."]);
  execFileSync("/usr/bin/git", ["-C", repository, "commit", "-qm", "initial"]);

  const db = new Database(path.join(root, "state", "hub.sqlite"));
  let now = 1_000_000;
  const clock = () => now;
  const store = new HubStore(db, clock, 1000, 1);
  let service: HubService | undefined;

  try {
    const repo = await resolveRepository({
      id: randomUUID(),
      label: "Fixture",
      path: repository,
      defaultTestProfileId: "t1",
      testProfiles: [{ id: "t1", command: ["/usr/bin/true"], timeoutMs: 1000 }],
    });

    service = new HubService(store, {
      root,
      repositories: [repo],
      maxConcurrency: 1,
      spawn: (_cmd, _args, opts) => {
        return spawn(process.execPath, ["--eval", `process.stdin.resume();`], opts);
      },
    });

    const token = "b".repeat(64);
    const handler = createHubHandler({ service, token, port: 4325 });
    const post = async (route: string, body: unknown, key = randomUUID()) =>
      handler(new Request(`http://127.0.0.1:4325/api/v1/${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      }));

    // Check meta features includes interrupted-recovery and parallel-execution
    const meta = service.meta();
    expect(meta.enabledFeatures).toContain("interrupted-recovery");
    expect(meta.enabledFeatures).toContain("parallel-execution");
    expect(meta.liveExecutionAvailable).toBe(true);

    // Create a task
    const subtaskId = randomUUID();
    const taskPayload = {
      title: "Interruption test task",
      goal: "Test crash recovery",
      repositoryId: repo.id,
      acceptanceCriteria: [{ id: "c1", description: "criterion 1" }],
      plannedSubtasks: [
        {
          id: subtaskId,
          code: "SUB-01",
          title: "Step 1",
          description: "Will crash",
          stage: "implementation",
          dependsOn: [],
          requiredCapabilities: ["stream"],
          acceptanceCriteria: [{ id: "c1", description: "criterion 1" }],
        },
      ],
    };
    const createdRes = await post("tasks", taskPayload);
    expect(createdRes.status).toBe(201);
    const taskId = (await createdRes.json()).data.id;

    // Wait until subtask run is started
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && store.list("run", taskId).length === 0) {
      await Bun.sleep(20);
    }
    const runs = store.list("run", taskId);
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    expect(["starting", "running"]).toContain(run.status);

    // The execution slot is now occupied
    expect(db.query("SELECT * FROM hub_execution_slot").all().length).toBe(1);

    // Simulate process crash / lease expiry
    now += 5000;
    const quarantined = store.reconcileExpired();
    expect(quarantined).toEqual([run.id]);

    const interruptedRun = store.get("run", run.id);
    expect(interruptedRun.status).toBe("interrupted");
    const blockedSubtask = store.get("subtask", subtaskId);
    expect(blockedSubtask.status).toBe("blocked");

    // Execution slot remains quarantined!
    expect(db.query("SELECT * FROM hub_execution_slot").all().length).toBe(1);
    expect(service.meta().liveExecutionAvailable).toBe(false);

    // Operator sends POST /api/v1/runs/:id/acknowledge
    const ackRes = await post(`runs/${run.id}/acknowledge`, {
      expectedVersion: interruptedRun.version,
      processGroupVerifiedStopped: true,
      reason: "Operator inspected process and confirmed killed",
    });
    expect(ackRes.status).toBe(200);
    const ackData = (await ackRes.json()).data;
    expect(ackData.status).toBe("acknowledged");
    expect(ackData.reconciliationNote).toBe("Operator inspected process and confirmed killed");

    // Slot is now freed!
    expect(db.query("SELECT * FROM hub_execution_slot").all().length).toBe(0);
    expect(service.meta().liveExecutionAvailable).toBe(true);
  } finally {
    await service?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
    if (old === undefined) delete process.env.AGETOR_DATA_DIR;
    else process.env.AGETOR_DATA_DIR = old;
  }
});

test("multi-concurrency executes parallel subtasks in separate worktrees simultaneously", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-parallel-"));
  const old = process.env.AGETOR_DATA_DIR;
  const repository = path.join(root, "source");
  await mkdir(repository);
  await mkdir(path.join(root, "state"));
  process.env.AGETOR_DATA_DIR = path.join(root, "state");

  execFileSync("/usr/bin/git", ["init", "-q", repository]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.name", "Fixture"]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repository, "README.md"), "# Base\n");
  execFileSync("/usr/bin/git", ["-C", repository, "add", "."]);
  execFileSync("/usr/bin/git", ["-C", repository, "commit", "-qm", "base commit"]);

  const db = new Database(path.join(root, "state", "hub.sqlite"));
  const store = new HubStore(db, Date.now, 10000, 2);
  let service: HubService | undefined;

  let maxParallelObserved = 0;
  let currentlyExecuting = 0;

  try {
    const repo = await resolveRepository({
      id: randomUUID(),
      label: "Fixture",
      path: repository,
      defaultTestProfileId: "accept",
      testProfiles: [{ id: "accept", command: ["/usr/bin/true"], timeoutMs: 1000 }],
    });

    service = new HubService(store, {
      root,
      repositories: [repo],
      maxConcurrency: 2,
      spawn: (_cmd, _args, opts) => {
        currentlyExecuting++;
        if (currentlyExecuting > maxParallelObserved) maxParallelObserved = currentlyExecuting;

        return spawn(
          process.execPath,
          [
            "--eval",
            `
            process.stdin.resume();
            process.stdin.on("end", async () => {
              // Write a unique file depending on subtask cwd
              const fs = require("node:fs");
              const path = require("node:path");
              const marker = path.join(process.cwd(), "work-" + Math.random().toString(36).slice(2) + ".txt");
              fs.writeFileSync(marker, "done\\n");
              
              console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-" + Math.random().toString(36).slice(2) }));
              console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ approved: true, findings: [] }) } }));
              console.log(JSON.stringify({ type: "turn.completed" }));
            });
          `,
          ],
          { ...opts, stdio: ["pipe", "pipe", "pipe"] }
        );
      },
      testRunner: async (_r, _cwd, p) => {
        currentlyExecuting = Math.max(0, currentlyExecuting - 1);
        return { profileId: p.id, exitCode: 0, stdout: "pass", stderr: "", timedOut: false, cancelled: false };
      },
    });

    const token = "c".repeat(64);
    const handler = createHubHandler({ service, token, port: 4326 });
    const post = async (route: string, body: unknown, key = randomUUID()) =>
      handler(new Request(`http://127.0.0.1:4326/api/v1/${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      }));

    const step1Id = randomUUID();
    const step2Id = randomUUID();
    const step3Id = randomUUID();

    // DAG:
    // SUB-01 (setup)
    // SUB-02 (branch A, depends on SUB-01)
    // SUB-03 (branch B, depends on SUB-01)
    // FINAL-REVIEW (automatically depends on SUB-02 & SUB-03)
    const payload = {
      title: "Parallel Execution Task",
      goal: "Test concurrent subtasks",
      repositoryId: repo.id,
      acceptanceCriteria: [{ id: "crit-root", description: "Root pass" }],
      plannedSubtasks: [
        {
          id: step1Id,
          code: "SUB-01",
          title: "Base Prep",
          description: "Step 1",
          stage: "implementation",
          dependsOn: [],
          requiredCapabilities: ["stream"],
          acceptanceCriteria: [{ id: "crit-1", description: "Step 1 pass" }],
        },
        {
          id: step2Id,
          code: "SUB-02",
          title: "Parallel Branch A",
          description: "Step 2A",
          stage: "implementation",
          dependsOn: [step1Id],
          requiredCapabilities: ["stream"],
          acceptanceCriteria: [{ id: "crit-2", description: "Step 2 pass" }],
        },
        {
          id: step3Id,
          code: "SUB-03",
          title: "Parallel Branch B",
          description: "Step 2B",
          stage: "implementation",
          dependsOn: [step1Id],
          requiredCapabilities: ["stream"],
          acceptanceCriteria: [{ id: "crit-3", description: "Step 3 pass" }],
        },
      ],
    };

    const createRes = await post("tasks", payload);
    expect(createRes.status).toBe(201);
    const task = (await createRes.json()).data;

    // Wait until SUB-02 and SUB-03 are both ready and executed concurrently, then reach waiting_approval
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && store.get("task", task.id).status !== "waiting_approval") {
      await Bun.sleep(50);
    }

    const finalTask = store.get("task", task.id);
    expect(finalTask.status).toBe("waiting_approval");
    expect(finalTask.error).toBeNull();

    // Verify that at least 2 subtasks were executing in parallel!
    expect(maxParallelObserved).toBeGreaterThanOrEqual(2);

    // Verify subtasks all succeeded
    const subtasks = store.list("subtask", task.id);
    const sub1 = subtasks.find((s) => s.id === step1Id)!;
    const sub2 = subtasks.find((s) => s.id === step2Id)!;
    const sub3 = subtasks.find((s) => s.id === step3Id)!;
    const finalReview = subtasks.find((s) => s.code === "FINAL-REVIEW")!;

    expect(sub1.status).toBe("succeeded");
    expect(sub2.status).toBe("succeeded");
    expect(sub3.status).toBe("succeeded");
    expect(finalReview.status).toBe("waiting_approval");

    // Approve final review
    const approvals = store.list("approval", task.id);
    expect(approvals.length).toBe(1);
    const app = approvals[0]!;
    const approveRes = await post(`approvals/${app.id}/decision`, {
      expectedVersion: app.version,
      decision: "approve",
      actionDigest: app.actionDigest,
    });
    expect(approveRes.status).toBe(200);

    const completedTask = store.get("task", task.id);
    expect(completedTask.status).toBe("succeeded");
  } finally {
    await service?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
    if (old === undefined) delete process.env.AGETOR_DATA_DIR;
    else process.env.AGETOR_DATA_DIR = old;
  }
}, 30000);
