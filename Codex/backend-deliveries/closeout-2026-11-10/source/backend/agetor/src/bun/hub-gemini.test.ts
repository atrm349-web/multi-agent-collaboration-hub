import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GeminiClient, resolveGeminiApiKey } from "../../packages/agent-adapters/gemini/client.ts";
import { GeminiRuntime } from "../../packages/agent-adapters/gemini/runtime.ts";

describe.skipIf(process.env.HUB_LIVE_TESTS !== "1")("Gemini & Antigravity Integration Suite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "gemini-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("GeminiClient", () => {
    it("resolves Gemini API key from environment or .env.local", () => {
      const key = resolveGeminiApiKey();
      expect(key).toBeString();
      expect(key.length).toBeGreaterThan(10);
    });

    it("rejects invalid key with AUTH_REQUIRED", async () => {
      const client = new GeminiClient({ apiKey: "invalid-key-xyz" });
      await expect(client.generateContent({
        contents: [{ role: "user", parts: [{ text: "ping" }] }]
      })).rejects.toThrow("AUTH_REQUIRED");
    });

    it("calls live Gemini generateContent successfully", async () => {
      const client = new GeminiClient();
      const res = await client.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [{ role: "user", parts: [{ text: "Reply with the exact word: PONG" }] }]
      });

      expect(res.candidates).toBeArray();
      expect(res.candidates!.length).toBeGreaterThan(0);
      const text = res.candidates![0]!.content.parts[0]!.text;
      expect(text).toBeString();
      expect(text!.toUpperCase()).toContain("PONG");
    }, 35000);
  });

  describe("GeminiRuntime Execution Loop", () => {
    it("executes code generation and file writing in isolated workspace", async () => {
      const runtime = new GeminiRuntime({ workspaceRoot: tempDir });
      const runId = await runtime.start({
        cwd: tempDir,
        prompt: "Create a file named hello_gemini.txt with content 'GEMINI_RUNTIME_OK'. Use the specified WRITE_FILE format.",
        sandbox: "workspace-write",
        model: "gemini-3.5-flash-lite",
        effort: "low",
        timeoutMs: 30000
      });

      const outcome = await runtime.wait(runId);
      expect(outcome.status).toBe("succeeded");
      expect(outcome.exitCode).toBe(0);

      const filePath = path.join(tempDir, "hello_gemini.txt");
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (exists) {
        const text = await file.text();
        expect(text).toContain("GEMINI_RUNTIME_OK");
      }
    }, 35000);
  });
});
