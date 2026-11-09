import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

export interface MuseRunInput {
  task: string;
  workspace?: string;
  output?: "text" | "json" | "artifacts";
  idempotencyKey?: string;
  constraints?: string[];
  timeoutSeconds?: number;
}

export interface MuseRunResponse {
  run: {
    id: string;
    input: MuseRunInput;
    workspace: string;
    status: "queued" | "dispatching" | "submitted" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "uncertain";
    review: "pending" | "accepted";
    round: number;
    quotaType: "self_quota" | "weekly_tokens";
    result?: {
      text?: string;
      json?: Record<string, unknown>;
      artifacts: Array<{ path: string; name: string; bytes: number }>;
    };
    error?: {
      code: string;
      message: string;
    };
    createdAt: string;
    updatedAt: string;
  };
  created: boolean;
}

export class MuseClient {
  private activeRuns = new Map<string, {
    run: MuseRunResponse["run"];
    promise: Promise<MuseRunResponse["run"]>;
  }>();

  constructor(_options: { baseUrl?: string; token?: string } = {}) {}

  async health(): Promise<{ status: string; version: string; quotaMode: string }> {
    const appExists = existsSync("/Applications/Muse.app");
    return {
      status: appExists ? "ok" : "degraded",
      version: "1.3.0-muse-spark-native",
      quotaMode: "self_subscription"
    };
  }

  async providers(): Promise<{ providers: any[] }> {
    return {
      providers: [
        {
          id: "muse",
          label: "Meta Muse (Spark 1.3 桌面端真实执行 · 自带专属额度)",
          state: "available",
          capabilities: ["stream", "tools", "structured-output", "self_quota", "desktop-native"],
          quotaType: "self_quota",
          message: "Muse 桌面端（Spark 1.3）已接入，通过原生桥接调度，使用其自身独立周额度执行"
        }
      ]
    };
  }

  private runBridgeProcess(spec: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.resolve(__dirname, "muse-desktop-bridge.py");
      const child = spawn("python3", [scriptPath, JSON.stringify(spec)], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("close", (code) => {
        if (code === 0) {
          try {
            const data = JSON.parse(stdout.trim());
            resolve(data);
          } catch (e) {
            reject(new Error(`Failed to parse bridge output: ${stdout || stderr}`));
          }
        } else {
          reject(new Error(`Muse bridge exited with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on("error", (err) => {
        reject(err);
      });
    });
  }

  async submitRun(input: MuseRunInput): Promise<MuseRunResponse> {
    const runId = "muse-" + Math.random().toString(36).slice(2, 10);
    const now = new Date().toISOString();

    const runObj: MuseRunResponse["run"] = {
      id: runId,
      input,
      workspace: input.workspace ?? process.cwd(),
      status: "running",
      review: "pending",
      round: 1,
      quotaType: "self_quota",
      createdAt: now,
      updatedAt: now,
    };

    const promise = (async () => {
      try {
        const res = await this.runBridgeProcess({
          task: input.task,
          workspace: input.workspace ?? process.cwd(),
          output: input.output ?? "text",
          timeoutSeconds: input.timeoutSeconds ?? 120,
        });

        if (res.status === "completed") {
          runObj.status = "completed";
          runObj.review = "accepted";
          runObj.result = {
            text: res.reply || "",
            json: res.json ?? undefined,
            artifacts: res.artifacts || [],
          };
        } else {
          runObj.status = "failed";
          runObj.error = {
            code: "MUSE_EXECUTION_FAILED",
            message: res.error || "Unknown execution failure",
          };
        }
      } catch (err: any) {
        runObj.status = "failed";
        runObj.error = {
          code: "MUSE_BRIDGE_ERROR",
          message: err.message || String(err),
        };
      }
      runObj.updatedAt = new Date().toISOString();
      return runObj;
    })();

    this.activeRuns.set(runId, { run: runObj, promise });
    return { run: runObj, created: true };
  }

  async getRun(id: string): Promise<MuseRunResponse["run"]> {
    const item = this.activeRuns.get(id);
    if (item) return item.run;
    throw new Error(`NOT_FOUND: Muse run ${id} not found`);
  }

  async waitRun(id: string, timeoutSeconds = 60): Promise<MuseRunResponse["run"]> {
    const item = this.activeRuns.get(id);
    if (!item) throw new Error(`NOT_FOUND: Muse run ${id} not found`);

    const timeoutPromise = new Promise<MuseRunResponse["run"]>((_, reject) => {
      setTimeout(() => reject(new Error("TIMEOUT")), timeoutSeconds * 1000);
    });

    try {
      return await Promise.race([item.promise, timeoutPromise]);
    } catch (e: any) {
      if (e.message === "TIMEOUT") {
        return item.run;
      }
      throw e;
    }
  }

  async cancelRun(id: string): Promise<void> {
    const item = this.activeRuns.get(id);
    if (item && item.run.status === "running") {
      item.run.status = "cancelled";
      item.run.updatedAt = new Date().toISOString();
    }
  }
}
