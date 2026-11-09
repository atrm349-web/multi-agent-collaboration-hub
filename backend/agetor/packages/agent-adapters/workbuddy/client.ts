export interface WorkBuddyRunInput {
  task: string;
  workspace?: string;
  output?: "text" | "json" | "artifacts";
  idempotencyKey?: string;
  constraints?: string[];
  timeoutSeconds?: number;
}

export interface WorkBuddyRunResponse {
  run: {
    id: string;
    input: WorkBuddyRunInput;
    workspace: string;
    status: "queued" | "dispatching" | "submitted" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "uncertain";
    review: "pending" | "accepted";
    round: number;
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

export class WorkBuddyClient {
  private readonly baseUrl: string;
  private token: string | null = null;

  constructor(options: { baseUrl?: string; token?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:18492").replace(/\/+$/, "");
    if (options.token) this.token = options.token;
  }

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;

    try {
      const res = await fetch(`${this.baseUrl}/`, { method: "GET" });
      const cookie = res.headers.get("set-cookie");
      const match = cookie?.match(/agent_hub=([^;]+)/);
      if (match && match[1]) {
        this.token = match[1];
        return this.token;
      }
    } catch (e) {
      // ignore fetch error
    }

    throw new Error("AUTH_REQUIRED: Cannot connect to WorkBuddy Gateway or obtain agent_hub token at " + this.baseUrl);
  }

  async health(): Promise<{ status: string; version: string }> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/v1/health`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`WorkBuddy health check failed with status ${res.status}`);
    return await res.json() as any;
  }

  async providers(): Promise<{ providers: any[] }> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/v1/providers`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`WorkBuddy providers call failed with status ${res.status}`);
    return await res.json() as any;
  }

  async submitRun(input: WorkBuddyRunInput): Promise<WorkBuddyRunResponse> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        provider: "workbuddy",
        task: input.task,
        workspace: input.workspace,
        output: input.output ?? "text",
        idempotencyKey: input.idempotencyKey,
        constraints: input.constraints ?? [],
        timeoutSeconds: input.timeoutSeconds ?? 1800,
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WorkBuddy submit failed (${res.status}): ${text}`);
    }

    return await res.json() as WorkBuddyRunResponse;
  }

  async getRun(id: string): Promise<WorkBuddyRunResponse["run"]> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/v1/runs/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`WorkBuddy getRun failed (${res.status})`);
    return await res.json() as any;
  }

  async waitRun(id: string, timeoutSeconds = 45): Promise<WorkBuddyRunResponse["run"]> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/v1/runs/${id}/wait?timeoutSeconds=${timeoutSeconds}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`WorkBuddy waitRun failed (${res.status})`);
    return await res.json() as any;
  }

  async cancelRun(id: string): Promise<void> {
    const token = await this.ensureToken();
    await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
  }
}
