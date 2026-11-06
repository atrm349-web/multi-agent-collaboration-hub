import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createHubHandler, type HTTPService, type MutationResult } from "../../packages/core/http.ts";
import type { Approval, DraftPlan, EventEnvelope, Snapshot, Task, TaskDetail } from "../../packages/shared/src/types.ts";

// Transport fixtures only: no actual Agent, database, browser, or model call is simulated as live.
const token = randomBytes(32).toString("hex");
const taskId = randomUUID(); const subtaskId = randomUUID(); const artifactId = randomUUID();
const task = { id: taskId, title: "fixture", version: 1, status: "queued", executionMode: "mock" } as Task;
function fixture() {
  let executions = 0; const scopes: string[] = []; const bodies: unknown[] = [];
  const events: EventEnvelope[] = [{ schemaVersion: "0.2", seq: 1, timestamp: new Date().toISOString(), type: "task.updated", taskId, payload: { ...task } }];
  const mutations = new Map<string, { payload: string; result: MutationResult }>();
  const service: HTTPService = {
    meta: () => ({ contractVersion: "0.2", executionMode: "mock", liveExecutionAvailable: false, enabledFeatures: [] }),
    repositories: () => ({ items: [], nextCursor: null }),
    page: (kind, query) => ({ items: kind === "task" ? [{ ...task, requestedLimit: query.limit }] : [], nextCursor: null }),
    detail: () => ({ task, subtasks: [], runs: { items: [], nextCursor: null }, validations: { items: [], nextCursor: null }, approvals: { items: [], nextCursor: null }, artifacts: { items: [], nextCursor: null } } as TaskDetail),
    snapshot: () => ({ schemaVersion: "0.2", snapshotSeq: 1, tasks: { items: [task], nextCursor: null }, agents: { items: [], nextCursor: null }, selectedTask: null } as Snapshot),
    logs: (runId, afterSeq, limit) => ({ runId, items: [], nextSeq: afterSeq, hasMore: false }),
    artifact: async () => ({ bytes: new TextEncoder().encode("<script>fixture</script>"), mimeType: "text/html", name: "fixture\r\nInjected.txt" }),
    decompose: async () => ({ id: randomUUID(), repositoryId: randomUUID(), goal: "fixture", subtasks: [], executionMode: "mock" } as DraftPlan),
    create: async (body) => { executions++; bodies.push(body); return task; },
    taskAction: async (_id, _action, body) => {
      const data = body as { expectedVersion: number };
      if (data.expectedVersion !== 1) throw new Error("CONFLICT: stale version");
      executions++; return { taskId, status: "pausing", operationId: randomUUID() };
    },
    subtaskAction: async () => ({ subtaskId, status: "retry_wait" }),
    decideApproval: async () => ({ id: randomUUID(), status: "approved" } as Approval),
    message: async () => ({ message: { id: randomUUID() }, delivery: "queued_next_turn" }),
    mutate: async (scope, key, body, operation) => {
      scopes.push(scope); const identity = `${scope}:${key}`; const payload = JSON.stringify(body);
      const prior = mutations.get(identity);
      if (prior) {
        if (prior.payload !== payload) throw new Error("CONFLICT: key payload changed");
        return prior.result;
      }
      const result = await operation(); mutations.set(identity, { payload, result }); return result;
    },
    events: (after, scope) => events.filter((event) => event.seq > after && (!scope || !event.taskId || scope === event.taskId)),
    watermark: () => events.at(-1)?.seq ?? 0,
  };
  return { service, scopes, bodies, events, count: () => executions,
    handler: createHubHandler({ service, token, allowedOrigins: ["http://127.0.0.1:4320"], pollMs: 5 }) };
}
function request(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1:4321${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers)) },
  });
}
const post = (data: unknown, key = randomUUID()): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(data) });

test("health is minimal and public; all state endpoints require the bearer", async () => {
  const { handler } = fixture();
  const health = await handler(new Request("http://127.0.0.1:4321/api/v1/health"));
  expect(health.status).toBe(200); expect((await health.json()).data).toEqual({ status: "ok" });
  for (const authorization of ["", "Bearer incorrect", `Bearer ${token}extra`]) {
    const response = await handler(request("/api/v1/tasks", { headers: { authorization } }));
    expect(response.status).toBe(401); expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  }
});

test("query credentials and non-loopback hosts are rejected without echoing secrets", async () => {
  const { handler } = fixture();
  for (const path of ["/api/v1/events?token=private-value", "/api/v1/meta?api_key=private-value"]) {
    const response = await handler(request(path));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("private-value");
  }
  expect((await handler(new Request("http://example.test/api/v1/meta", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(403);
  expect((await handler(request("/api/v1/meta", { headers: { host: "example.test" } }))).status).toBe(403);
});

test("CORS uses exact origins and preflight does not require a token", async () => {
  const { handler } = fixture();
  const good = await handler(request("/api/v1/meta", { headers: { origin: "http://127.0.0.1:4320" } }));
  expect(good.status).toBe(200); expect(good.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4320");
  const denied = await handler(request("/api/v1/meta", { headers: { origin: "http://127.0.0.1:4320.evil.test" } }));
  expect(denied.status).toBe(403); expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  const preflight = await handler(new Request("http://127.0.0.1:4321/api/v1/tasks", { method: "OPTIONS", headers: {
    origin: "http://127.0.0.1:4320", "access-control-request-method": "POST", "access-control-request-headers": "authorization,idempotency-key,content-type",
  } }));
  expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");
});

test("Page responses remain pages, with limits and server-generated request IDs", async () => {
  const { handler } = fixture(); const response = await handler(request("/api/v1/tasks?limit=3")); const json = await response.json();
  expect(json.data.items[0].requestedLimit).toBe(3); expect(json.data.nextCursor).toBeNull(); expect(json.data.tasks).toBeUndefined();
  expect(json.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(response.headers.get("x-request-id")).toBe(json.requestId);
  for (const query of ["limit=101", "limit=0", "limit=2&limit=3", "unknown=value", "cursor="]) {
    expect((await handler(request(`/api/v1/tasks?${query}`))).status).toBe(400);
  }
});

test("mutations require idempotency and reject unknown JSON fields before reaching the service", async () => {
  const f = fixture();
  const missing = await f.handler(request("/api/v1/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  expect(missing.status).toBe(400);
  const injected = await f.handler(request(`/api/v1/tasks/${taskId}/pause`, post({ expectedVersion: 1, command: "should never run" })));
  expect(injected.status).toBe(400); expect(f.scopes).toEqual([]); expect(f.count()).toBe(0);
  for (const value of [null, [], "text"]) expect((await f.handler(request("/api/v1/tasks", post(value)))).status).toBe(400);
  const malformed = await f.handler(request("/api/v1/tasks", { ...post({}), body: "{" }));
  expect(malformed.status).toBe(400);
});

test("idempotent mutation delegation retains scope and returns the original result", async () => {
  const f = fixture(); const data = { title: "fixture", goal: "goal", repositoryId: randomUUID(), acceptanceCriteria: [] }; const key = randomUUID();
  expect((await f.handler(request("/api/v1/tasks", post(data, key)))).status).toBe(201);
  expect((await f.handler(request("/api/v1/tasks", post(data, key)))).status).toBe(201);
  expect(f.count()).toBe(1); expect(f.scopes).toEqual(["POST /api/v1/tasks", "POST /api/v1/tasks"]);
  const changed = await f.handler(request("/api/v1/tasks", post({ ...data, goal: "different" }, key)));
  expect(changed.status).toBe(409); expect((await changed.json()).error.code).toBe("CONFLICT");
});

test("CAS conflict is preserved and control success is accepted asynchronously", async () => {
  const { handler } = fixture();
  const rejected = await handler(request(`/api/v1/tasks/${taskId}/pause`, post({ expectedVersion: 7 })));
  expect(rejected.status).toBe(409); expect((await rejected.json()).error.code).toBe("CONFLICT");
  const accepted = await handler(request(`/api/v1/tasks/${taskId}/pause`, post({ expectedVersion: 1 })));
  expect(accepted.status).toBe(202); expect((await accepted.json()).data.status).toBe("pausing");
});

test("body size and content type limits apply before mutation", async () => {
  const f = fixture();
  const wrong = await f.handler(request("/api/v1/tasks", { ...post({}), headers: { "content-type": "text/plain", "idempotency-key": randomUUID() } }));
  expect(wrong.status).toBe(400);
  const large = await f.handler(request("/api/v1/tasks", post({ goal: "x".repeat(256 * 1024) })));
  expect(large.status).toBe(413); expect(f.count()).toBe(0);
});

test("SSE rejects future/invalid cursors and replays sequence IDs after a snapshot", async () => {
  const f = fixture();
  expect((await f.handler(request("/api/v1/events", { headers: { "last-event-id": "2" } }))).status).toBe(409);
  expect((await f.handler(request("/api/v1/events", { headers: { "last-event-id": "-1" } }))).status).toBe(400);
  const abort = new AbortController();
  const response = await f.handler(request(`/api/v1/events?taskId=${taskId}`, { signal: abort.signal, headers: { "last-event-id": "0" } }));
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain(": connected");
  const frame = decoder.decode((await reader.read()).value);
  expect(frame).toContain("id: 1\nevent: task.updated\n"); expect(frame).toContain('"seq":1');
  f.events.push({ schemaVersion: "0.2", seq: 2, type: "run.output", taskId, timestamp: new Date().toISOString(), payload: { text: "中文\nline", logSeq: 1 } });
  const next = decoder.decode((await reader.read()).value);
  expect(next).toContain("id: 2"); expect(next).not.toContain("id: 1"); expect(next).toContain("中文");
  abort.abort(); await reader.cancel();
});

test("retention errors propagate before the SSE response and internal diagnostics stay private", async () => {
  const f = fixture(); f.service.events = () => { throw new Error("EVENT_CURSOR_EXPIRED: cursor fell outside retention"); };
  const expired = await f.handler(request("/api/v1/events"));
  expect(expired.status).toBe(409); expect((await expired.json()).error.code).toBe("EVENT_CURSOR_EXPIRED");
  f.service.meta = () => { throw new Error("SPAWN_ERROR: private-value /Users/private/auth.json"); };
  const unavailable = await f.handler(request("/api/v1/meta"));
  expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain("private-value");
});

test("subscription limits are bounded and cancelled streams release their slots", async () => {
  const { handler } = fixture(); const streams: Response[] = [];
  try {
    for (let i = 0; i < 16; i++) {
      const response = await handler(request("/api/v1/events"));
      expect(response.status).toBe(200); streams.push(response);
    }
    expect((await handler(request("/api/v1/events"))).status).toBe(429);
    await streams.shift()!.body!.cancel();
    const replacement = await handler(request("/api/v1/events"));
    expect(replacement.status).toBe(200); streams.push(replacement);
  } finally { await Promise.all(streams.map((response) => response.body!.cancel())); }
});

test("artifact references download as attachments with active-content protections", async () => {
  const f = fixture(); const response = await f.handler(request(`/api/v1/artifacts/${artifactId}/content`));
  expect(response.status).toBe(200); expect(response.headers.get("content-disposition")).toStartWith("attachment;");
  expect(response.headers.get("content-disposition")).not.toContain("\r\n");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await f.handler(request(`/api/v1/artifacts/${artifactId}/content?path=/etc/passwd`))).status).toBe(400);
  expect((await f.handler(request("/api/v1/artifacts/not-a-uuid/content"))).status).toBe(400);
});
