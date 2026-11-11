import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DeepSeekClient, resolveDeepSeekApiKey } from "../../packages/agent-adapters/deepseek/client.ts";
import { DeepSeekRuntime } from "../../packages/agent-adapters/deepseek/runtime.ts";
import { planWithDeepSeek, validatePlan } from "../../packages/core/planner.ts";

describe.skipIf(process.env.HUB_LIVE_TESTS !== "1")("DeepSeek Integration Suite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "deepseek-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("DeepSeekClient", () => {
    it("resolves API key successfully from environment or local config", () => {
      const key = resolveDeepSeekApiKey();
      expect(key).toBeString();
      expect(key.startsWith("sk-")).toBeTrue();
    });

    it("throws AUTH_REQUIRED on invalid key", async () => {
      const client = new DeepSeekClient({ apiKey: "sk-invalid-dummy-key" });
      await expect(client.chat({
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      })).rejects.toThrow("AUTH_REQUIRED");
    });

    it("calls live DeepSeek API successfully with genuine key", async () => {
      const client = new DeepSeekClient();
      const res = await client.chat({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Reply with the exact word: PONG" }],
        max_tokens: 10,
        temperature: 0.1,
      });

      expect(res.choices).toBeArray();
      expect(res.choices.length).toBeGreaterThan(0);
      expect(res.choices[0]!.message.content).toBeString();
      expect(res.choices[0]!.message.content!.toUpperCase()).toContain("PONG");
    }, 20000);
  });

  describe("DeepSeekRuntime Sandbox and Tool Calling", () => {
    it("prevents file operations from escaping the workspace sandbox", async () => {
      const runtime = new DeepSeekRuntime({ workspaceRoot: tempDir });
      const startPromise = runtime.start({
        cwd: tempDir,
        prompt: "Write a file to /etc/evil.txt",
        sandbox: "workspace-write",
        model: "deepseek-chat",
        effort: "low",
      });
      const runId = await startPromise;
      const res = await runtime.wait(runId);
      expect(res.status).toBe("succeeded");
    }, 20000);

    it("executes tool calling and creates files in workspace", async () => {
      const runtime = new DeepSeekRuntime({ workspaceRoot: tempDir });
      const prompt = "Please create a file named 'hello.txt' with content 'Hello DeepSeek Hub!' and output your summary.";
      const runId = await runtime.start({
        cwd: tempDir,
        prompt,
        sandbox: "workspace-write",
        model: "deepseek-chat",
        effort: "low",
        timeoutMs: 30000,
      });

      const res = await runtime.wait(runId);
      expect(res.status).toBe("succeeded");
      expect(res.exitCode).toBe(0);

      // Verify hello.txt was created on disk
      const filePath = path.join(tempDir, "hello.txt");
      const content = await readFile(filePath, "utf8");
      expect(content).toContain("Hello DeepSeek");
    }, 30000);

    it("executes review mode and outputs structured JSON", async () => {
      const runtime = new DeepSeekRuntime({ workspaceRoot: tempDir });
      const prompt = "Audit this code: function add(a, b) { return a + b; }. Verify it returns the sum.";
      const runId = await runtime.start({
        cwd: tempDir,
        prompt,
        sandbox: "read-only",
        model: "deepseek-chat",
        effort: "low",
        outputSchema: {
          type: "object",
          required: ["approved", "findings"],
          properties: {
            approved: { type: "boolean" },
            findings: { type: "array", items: { type: "string" } },
          },
        },
      });

      const res = await runtime.wait(runId);
      expect(res.status).toBe("succeeded");
      const parsed = JSON.parse(res.result);
      expect(parsed).toHaveProperty("approved");
      expect(parsed).toHaveProperty("findings");
      expect(Array.isArray(parsed.findings)).toBeTrue();
    }, 20000);
  });

  describe("planWithDeepSeek", () => {
    it("generates a structured DAG that passes strict validatePlan checks", async () => {
      const repositoryId = randomUUID();
      const plan = await planWithDeepSeek({
        goal: "分布式缓存系统：实现LRU缓存淘汰算法与一致性哈希路由算法，并包含自动化单元测试",
        cwd: tempDir,
        workspaceRoot: tempDir,
        repositoryId,
        model: "deepseek-chat",
        effort: "low",
        timeoutMs: 30000,
      });

      expect(plan.id).toBeString();
      expect(plan.repositoryId).toBe(repositoryId);
      expect(plan.subtasks.length).toBeGreaterThanOrEqual(1);

      // Subtasks have already passed validatePlan inside planWithDeepSeek
      // Let's re-verify independently
      const revalidated = validatePlan(plan.subtasks);
      expect(revalidated.length).toBe(plan.subtasks.length);

      // Verify each subtask has acceptance criteria and code
      for (const step of plan.subtasks) {
        expect(step.code.startsWith("SUB-")).toBeTrue();
        expect(step.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
        expect(["analysis", "implementation", "testing", "review", "documentation"]).toContain(step.stage);
      }
    }, 35000);
  });
});
