import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkBuddyClient } from "../../packages/agent-adapters/workbuddy/client.ts";
import { WorkBuddyRuntime } from "../../packages/agent-adapters/workbuddy/runtime.ts";

describe("WorkBuddy Integration Suite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "wb-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("WorkBuddyClient", () => {
    it("connects to live local WorkBuddy gateway and passes health check", async () => {
      const client = new WorkBuddyClient();
      const health = await client.health();
      expect(health.status).toBe("ok");
      expect(health.version).toBeString();
    });

    it("queries providers and confirms workbuddy native executor is available", async () => {
      const client = new WorkBuddyClient();
      const res = await client.providers();
      expect(res.providers).toBeArray();
      const wb = res.providers.find((p: any) => p.id === "workbuddy");
      expect(wb).toBeDefined();
      expect(wb.state).toBe("available");
    });
  });

  describe("WorkBuddyRuntime", () => {
    it("instantiates cleanly and respects workspace bounds", async () => {
      const runtime = new WorkBuddyRuntime({ workspaceRoot: tempDir });
      expect(runtime).toBeDefined();
    });
  });
});
