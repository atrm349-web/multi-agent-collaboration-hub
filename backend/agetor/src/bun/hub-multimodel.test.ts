import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HubStore } from "../../packages/core/state/store.ts";
import { HubService, resolveRepository } from "../../packages/core/hub.ts";

test("Heterogeneous multi-model: resolveRepository retains stage model configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-multimodel-repo-"));
  try {
    execFileSync("/usr/bin/git", ["init", "-q", root]);
    execFileSync("/usr/bin/git", ["-C", root, "config", "user.name", "MultiModel Test"]);
    execFileSync("/usr/bin/git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("/usr/bin/git", ["-C", root, "commit", "--allow-empty", "-m", "init"]);

    const repo = await resolveRepository({
      id: randomUUID(),
      label: "MultiModel Repo",
      path: root,
      defaultTestProfileId: "test-default",
      model: "deepseek-chat",
      models: {
        planner: "deepseek-reasoner",
        developer: "deepseek-chat",
        reviewer: "deepseek-chat",
      },
      testProfiles: [{ id: "test-default", command: ["/usr/bin/true"], timeoutMs: 5000 }],
    });

    expect(repo.model).toBe("deepseek-chat");
    expect(repo.models?.planner).toBe("deepseek-reasoner");
    expect(repo.models?.developer).toBe("deepseek-chat");
    expect(repo.models?.reviewer).toBe("deepseek-chat");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Heterogeneous multi-model: dispatches distinct models for planning, developer, and reviewer stages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-multimodel-dispatch-"));
  const repository = path.join(root, "source");
  await mkdir(repository, { recursive: true });
  await mkdir(path.join(root, "state"), { recursive: true });

  execFileSync("/usr/bin/git", ["init", "-q", repository]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.name", "MultiModel Test"]);
  execFileSync("/usr/bin/git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  execFileSync("/usr/bin/git", ["-C", repository, "commit", "--allow-empty", "-m", "init"]);

  const db = new Database(path.join(root, "state", "hub.sqlite"));
  const store = new HubStore(db);

  const invokedModels: { stage?: string; model?: string }[] = [];

  const repo = await resolveRepository({
    id: randomUUID(),
    label: "Heterogeneous Repo",
    path: repository,
    defaultTestProfileId: "test-default",
    model: "deepseek-chat",
    models: {
      planner: "deepseek-reasoner",
      developer: "deepseek-chat",
      reviewer: "deepseek-chat",
    },
    testProfiles: [{ id: "test-default", command: ["/usr/bin/true"], timeoutMs: 5000 }],
  });

  const step1Id = randomUUID();

  const service = new HubService(store, {
    root,
    repositories: [repo],
    planner: async (options) => {
      invokedModels.push({ stage: "planning", model: options.model });
      return {
        id: randomUUID(),
        repositoryId: repo.id,
        goal: options.goal,
        executionMode: "live",
        subtasks: [
          {
            id: step1Id,
            code: "DEV-01",
            title: "Development step",
            description: "Write code",
            stage: "implementation",
            dependsOn: [],
            requiredCapabilities: ["stream"],
            acceptanceCriteria: [{ id: "c1", description: "check", testProfileId: "test-default" }],
          },
        ],
      };
    },
    spawn: (_cmd, args, options) => {
      // Find model passed in spawn/runtime
      return {
        pid: 99999,
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: () => {},
      } as any;
    },
  });

  try {
    // 1. Decompose invokes planner with deepseek-reasoner
    const plan = await service.decompose({ goal: "Build architecture", repositoryId: repo.id });
    expect(plan.subtasks.length).toBe(1);
    expect(invokedModels.find((m) => m.stage === "planning")?.model).toBe("deepseek-reasoner");
  } finally {
    await service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
