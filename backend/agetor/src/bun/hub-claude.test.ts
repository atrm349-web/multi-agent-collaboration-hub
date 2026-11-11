import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeClient, resolveClaudeApiKey } from "../../packages/agent-adapters/claude/client.ts";
import { ClaudeRuntime } from "../../packages/agent-adapters/claude/runtime.ts";

describe("Anthropic Claude Integration Suite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "claude-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("ClaudeClient", () => {
    it("handles key resolution gracefully", () => {
      const key = resolveClaudeApiKey();
      expect(typeof key).toBe("string");
    });

    it("rejects when no key is configured", async () => {
      const client = new ClaudeClient({ apiKey: "" });
      await expect(client.createMessage({
        messages: [{ role: "user", content: "ping" }]
      })).rejects.toThrow("AUTH_REQUIRED");
    });
  });

  describe("ClaudeRuntime", () => {
    it("instantiates cleanly and respects workspace bounds", async () => {
      const runtime = new ClaudeRuntime({ workspaceRoot: tempDir });
      expect(runtime).toBeDefined();

      // Escape attempt must fail with PERMISSION_DENIED
      await expect(runtime.start({
        cwd: path.join(tempDir, "../../../escape-dir"),
        prompt: "test",
        sandbox: "workspace-write",
        model: "claude-fixture", effort: "low",
      })).rejects.toThrow("PERMISSION_DENIED");
    });
  });
});
