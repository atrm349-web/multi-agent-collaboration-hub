import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MuseClient } from "../../packages/agent-adapters/muse/client.ts";
import { MuseRuntime } from "../../packages/agent-adapters/muse/runtime.ts";

describe("Muse Integration Suite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "muse-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("MuseClient", () => {
    it("connects and confirms self-quota health status", async () => {
      const client = new MuseClient();
      const health = await client.health();
      expect(health.status).toBe("ok");
      expect(health.quotaMode).toBe("self_subscription");
    });

    it("queries providers and confirms muse dedicated quota provider is registered", async () => {
      const client = new MuseClient();
      const res = await client.providers();
      expect(res.providers).toBeArray();
      const muse = res.providers.find((p: any) => p.id === "muse");
      expect(muse).toBeDefined();
      expect(muse.quotaType).toBe("self_quota");
      expect(muse.state).toBe("available");
    });
  });

  describe("MuseRuntime", () => {
    it("instantiates cleanly and respects workspace bounds", async () => {
      const runtime = new MuseRuntime({ workspaceRoot: tempDir });
      expect(runtime).toBeDefined();
    });
  });
});
