import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Approval, DraftPlan, EventEnvelope, LogPage, Meta, Page, RepositoryRef,
  Snapshot, Task, TaskDetail } from "../shared/src/types.ts";

type Awaitable<T> = T | Promise<T>;
export type PageKind = "task" | "agent" | "run" | "validation" | "message" | "artifact" | "approval";
export interface PageQuery { taskId?: string; cursor?: string; limit?: number; status?: string }
export interface MutationResult { status: number; data: unknown }
export interface HTTPService {
  meta(): Awaitable<Meta>;
  repositories(query?: PageQuery): Awaitable<Page<RepositoryRef>>;
  page(kind: PageKind, query: PageQuery): Awaitable<Page<unknown>>;
  detail(taskId: string): Awaitable<TaskDetail>;
  snapshot(taskId?: string): Awaitable<Snapshot>;
  logs(runId: string, afterSeq: number, limit: number): Awaitable<LogPage>;
  artifact(id: string): Promise<{ bytes: Uint8Array; mimeType: string; name: string }>;
  decompose(body: unknown): Promise<DraftPlan>;
  create(body: unknown): Promise<Task>;
  taskAction(id: string, action: "pause" | "resume" | "cancel", body: unknown): Promise<unknown>;
  subtaskAction(id: string, action: "retry" | "rework", body: unknown): Promise<unknown>;
  decideApproval(id: string, body: unknown): Promise<Approval>;
  message(taskId: string, body: unknown): Promise<unknown>;
  acknowledgeInterruption(runId: string, body: unknown): Promise<unknown>;
  mutate(scope: string, key: string, body: unknown, operation: () => Promise<MutationResult>): Promise<MutationResult>;
  events(afterSeq: number, taskId?: string): EventEnvelope[];
  watermark(): number;
}
export interface HubHttpOptions {
  service: HTTPService; token: string; port?: number; allowedOrigins?: string[]; pollMs?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 256 * 1024;
const FRAME_LIMIT = 1024 * 1024;
const codes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404,
  CONFLICT: 409, UNSUPPORTED_TRANSITION: 409, UNSUPPORTED_CAPABILITY: 409, EVENT_CURSOR_EXPIRED: 409,
  PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429, AGENT_UNAVAILABLE: 503, BINARY_NOT_FOUND: 503,
  AUTH_REQUIRED: 503, SPAWN_ERROR: 503, TRANSPORT_ERROR: 503, TURN_FAILED: 503,
  MISSING_TERMINAL_EVENT: 503, TIMEOUT: 503, CANCELLED: 409, WORKTREE_CONFLICT: 409,
  DEPENDENCY_FAILED: 409, ARTIFACT_INVALID: 409, ACCEPTANCE_FAILED: 409, PROCESS_CRASHED: 500,
};
function fail(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
function integer(value: string | null, fallback: number, max: number, minimum = 0): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) fail("INVALID_INPUT", "Invalid numeric query or cursor");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > max) fail("INVALID_INPUT", "Numeric value is outside its allowed range");
  return number;
}
function query(url: URL, allowed: string[]): void {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) fail("INVALID_INPUT", "Unknown or repeated query parameter");
    seen.add(key);
  }
}
function id(value: string): string {
  if (!UUID.test(value)) fail("INVALID_INPUT", "Expected a UUID identifier");
  return value;
}
function pageQuery(url: URL, status = false): PageQuery {
  query(url, status ? ["cursor", "limit", "status"] : ["cursor", "limit"]);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > 2048)) fail("INVALID_INPUT", "Invalid page cursor");
  const filter = url.searchParams.get("status");
  if (filter !== null && !/^[a-z_]{1,40}$/.test(filter)) fail("INVALID_INPUT", "Invalid status filter");
  return { limit: integer(url.searchParams.get("limit"), 20, 100, 1),
    ...(cursor !== null ? { cursor } : {}), ...(filter !== null ? { status: filter } : {}) };
}
async function body(request: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? "")) fail("INVALID_INPUT", "Use application/json");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) fail("PAYLOAD_TOO_LARGE", "Request body exceeds the limit");
  const reader = request.body?.getReader();
  if (!reader) fail("INVALID_INPUT", "JSON body is required");
  let bytes = 0; let text = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > BODY_LIMIT) { await reader.cancel(); fail("PAYLOAD_TOO_LARGE", "Request body exceeds the limit"); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (String(error).includes("PAYLOAD_TOO_LARGE")) throw error;
    fail("INVALID_INPUT", "Unable to read a UTF-8 JSON body");
  } finally { reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("INVALID_INPUT", "Malformed JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("INVALID_INPUT", "Expected a JSON object");
  if (Object.keys(parsed).some((key) => !allowed.includes(key))) fail("INVALID_INPUT", "Unknown request field");
  return parsed as Record<string, unknown>;
}

/** Trust-boundary HTTP transport; execution and durable mutations stay in the service. */
export function createHubHandler(options: HubHttpOptions): (request: Request) => Promise<Response> {
  if (options.token.length < 32 || /\s/.test(options.token)) throw new Error("INVALID_INPUT: supply a strong, non-whitespace bearer token");
  const origins = new Set(options.allowedOrigins ?? []);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) throw new Error("INVALID_INPUT: origins must be exact HTTP origins");
  }
  const expected = Buffer.from(`Bearer ${options.token}`);
  const encoder = new TextEncoder();
  let streams = 0;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(pollMs) || pollMs < 5 || pollMs > 1000) throw new Error("INVALID_INPUT: poll interval");

  return async (request) => {
    const requestId = randomUUID(); const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff", "x-request-id": requestId });
    const json = (data: unknown, status = 200) => {
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({ data, requestId }), { status, headers });
    };
    try {
      const url = new URL(request.url);
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) fail("PERMISSION_DENIED", "Loopback host required");
      if (request.headers.has("host") && request.headers.get("host") !== url.host) fail("PERMISSION_DENIED", "Host mismatch");
      for (const key of url.searchParams.keys()) if (/token|authorization|api.?key/i.test(key)) fail("INVALID_INPUT", "Credentials in query parameters are forbidden");
      const origin = request.headers.get("origin");
      if (origin) {
        if (origin !== url.origin && !origins.has(origin)) fail("PERMISSION_DENIED", "Origin is not allowed");
        headers.set("access-control-allow-origin", origin); headers.set("vary", "origin");
      }
      if (request.method === "OPTIONS") {
        if (!origin) fail("PERMISSION_DENIED", "Preflight origin is required");
        const method = request.headers.get("access-control-request-method");
        if (!method || !["GET", "POST"].includes(method)) fail("INVALID_INPUT", "Unsupported preflight method");
        const requested = (request.headers.get("access-control-request-headers") ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean);
        if (requested.some((h) => !["authorization", "content-type", "idempotency-key", "last-event-id"].includes(h))) fail("INVALID_INPUT", "Unsupported preflight header");
        headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
        headers.set("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key, Last-Event-ID");
        return new Response(null, { status: 204, headers });
      }
      const route = url.pathname;
      if (request.method === "GET" && route === "/api/v1/health") { query(url, []); return json({ status: "ok" }); }
      const actual = Buffer.from(request.headers.get("authorization") ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("UNAUTHENTICATED", "Bearer authentication required");
      const service = options.service;
      if (request.method === "GET") {
        if (route === "/api/v1/meta") { query(url, []); return json(await service.meta()); }
        if (route === "/api/v1/repositories") return json(await service.repositories(pageQuery(url)));
        if (route === "/api/v1/tasks") return json(await service.page("task", pageQuery(url, true)));
        if (route === "/api/v1/agents") return json(await service.page("agent", pageQuery(url)));
        if (route === "/api/v1/snapshot") {
          query(url, ["taskId"]); const taskId = url.searchParams.get("taskId");
          return json(await service.snapshot(taskId === null ? undefined : id(taskId)));
        }
        const detail = route.match(/^\/api\/v1\/tasks\/([^/]+)$/);
        if (detail) { query(url, []); return json(await service.detail(id(detail[1]!))); }
        const collection = route.match(/^\/api\/v1\/tasks\/([^/]+)\/(runs|validations|messages|artifacts|approvals)$/);
        if (collection) {
          const kinds = { runs: "run", validations: "validation", messages: "message", artifacts: "artifact", approvals: "approval" } as const;
          return json(await service.page(kinds[collection[2] as keyof typeof kinds], { ...pageQuery(url, collection[2] === "approvals"), taskId: id(collection[1]!) }));
        }
        const logs = route.match(/^\/api\/v1\/runs\/([^/]+)\/logs$/);
        if (logs) {
          query(url, ["afterSeq", "limit"]);
          return json(await service.logs(id(logs[1]!), integer(url.searchParams.get("afterSeq"), 0, Number.MAX_SAFE_INTEGER), integer(url.searchParams.get("limit"), 200, 500, 1)));
        }
        const content = route.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/);
        if (content) {
          query(url, []); const artifact = await service.artifact(id(content[1]!));
          if (artifact.bytes.byteLength > 10 * 1024 * 1024) fail("PAYLOAD_TOO_LARGE", "Artifact exceeds the download limit");
          headers.set("content-type", /^[\w.+-]+\/[\w.+-]+$/.test(artifact.mimeType) ? artifact.mimeType : "application/octet-stream");
          headers.set("content-security-policy", "default-src 'none'; sandbox");
          headers.set("content-disposition", `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(artifact.name.replace(/[\r\n]/g, ""))}`);
          return new Response(new Uint8Array(artifact.bytes), { headers });
        }
        if (route === "/api/v1/events") {
          query(url, ["taskId"]);
          const taskId = url.searchParams.get("taskId"); const scope = taskId === null ? undefined : id(taskId);
          let cursor = integer(request.headers.get("last-event-id"), 0, Number.MAX_SAFE_INTEGER);
          if (cursor > service.watermark()) fail("EVENT_CURSOR_EXPIRED", "Event cursor is ahead of stored state");
          if (streams >= 16) fail("RATE_LIMITED", "Too many event subscriptions");
          let batch = service.events(cursor, scope);
          headers.set("content-type", "text/event-stream; charset=utf-8"); headers.set("cache-control", "no-cache, no-transform");
          headers.set("x-accel-buffering", "no");
          let timer: ReturnType<typeof setInterval> | undefined; let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
          let closed = false; let lastSend = Date.now(); let stalledAt: number | null = null;
          const cleanup = () => { if (closed) return; closed = true; streams--; clearInterval(timer); request.signal.removeEventListener("abort", abort); };
          const abort = () => { cleanup(); try { controller?.close(); } catch { /* Already cancelled by reader. */ } };
          const stream = new ReadableStream<Uint8Array>({
            start(target) {
              controller = target; streams++;
              request.signal.addEventListener("abort", abort, { once: true });
              target.enqueue(encoder.encode(": connected\n\n"));
              const poll = () => {
                if (closed) return;
                if ((target.desiredSize ?? 0) <= 0) {
                  stalledAt ??= Date.now();
                  if (Date.now() - stalledAt > 30_000) { cleanup(); target.error(new Error("Slow event consumer")); }
                  return;
                }
                stalledAt = null;
                try {
                  if (!batch.length) batch = service.events(cursor, scope);
                  const frames: string[] = []; let bytes = 0;
                  while (batch.length) {
                    const event = batch[0]!;
                    if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error("Invalid event sequence");
                    if (event.seq <= cursor) { batch.shift(); continue; }
                    const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
                    const size = encoder.encode(frame).byteLength;
                    if (size > FRAME_LIMIT) throw new Error("Event frame exceeds limit");
                    if (bytes && bytes + size > FRAME_LIMIT) break;
                    frames.push(frame); bytes += size; cursor = event.seq; batch.shift();
                  }
                  if (frames.length) { target.enqueue(encoder.encode(frames.join(""))); lastSend = Date.now(); }
                  else if (Date.now() - lastSend >= 15_000) { target.enqueue(encoder.encode(": heartbeat\n\n")); lastSend = Date.now(); }
                } catch { cleanup(); target.error(new Error("Event stream unavailable; refresh snapshot before reconnecting")); }
              };
              timer = setInterval(poll, pollMs);
              if (request.signal.aborted) abort();
            },
            cancel() { cleanup(); },
          });
          return new Response(stream, { headers });
        }
      }
      if (request.method === "POST") {
        query(url, []);
        const key = request.headers.get("idempotency-key");
        if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) fail("INVALID_INPUT", "Idempotency-Key is required");
        let operation: ((data: unknown) => Promise<MutationResult>) | undefined; let fields: string[] = [];
        if (route === "/api/v1/tasks/decompose") { fields = ["goal", "repositoryId"]; operation = async (data) => ({ status: 200, data: await service.decompose(data) }); }
        else if (route === "/api/v1/tasks") { fields = ["title", "goal", "repositoryId", "acceptanceCriteria", "priority", "plannedSubtasks"]; operation = async (data) => ({ status: 201, data: await service.create(data) }); }
        else {
          const task = route.match(/^\/api\/v1\/tasks\/([^/]+)\/(pause|resume|cancel)$/);
          const subtask = route.match(/^\/api\/v1\/subtasks\/([^/]+)\/(retry|rework)$/);
          const approval = route.match(/^\/api\/v1\/approvals\/([^/]+)\/decision$/);
          const message = route.match(/^\/api\/v1\/tasks\/([^/]+)\/messages$/);
          const runAck = route.match(/^\/api\/v1\/runs\/([^/]+)\/(acknowledge|interruption-ack)$/);
          if (task) { const taskId = id(task[1]!); const action = task[2] as "pause" | "resume" | "cancel"; fields = action === "cancel" ? ["expectedVersion", "reason"] : ["expectedVersion"]; operation = async (data) => ({ status: 202, data: await service.taskAction(taskId, action, data) }); }
          else if (subtask) { const subtaskId = id(subtask[1]!); const action = subtask[2] as "retry" | "rework"; fields = action === "rework" ? ["expectedVersion", "reason", "artifactRefs"] : ["expectedVersion", "reason"]; operation = async (data) => ({ status: 202, data: await service.subtaskAction(subtaskId, action, data) }); }
          else if (approval) { const approvalId = id(approval[1]!); fields = ["expectedVersion", "decision", "actionDigest", "comment"]; operation = async (data) => ({ status: 200, data: await service.decideApproval(approvalId, data) }); }
          else if (message) { const taskId = id(message[1]!); fields = ["toSubtaskId", "content", "artifactRefs"]; operation = async (data) => ({ status: 201, data: await service.message(taskId, data) }); }
          else if (runAck) { const runId = id(runAck[1]!); fields = ["expectedVersion", "processGroupVerifiedStopped", "reason"]; operation = async (data) => ({ status: 200, data: await service.acknowledgeInterruption(runId, data) }); }
        }
        if (operation) {
          const data = await body(request, fields); const execute = operation;
          const result = await service.mutate(`POST ${route}`, key, data, () => execute(data));
          return json(result.data, result.status);
        }
      }
      fail("NOT_FOUND", "Unknown API endpoint");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const matched = message.match(/^([A-Z_]+):\s*([\s\S]*)$/);
      const code = matched?.[1] && Object.hasOwn(codes, matched[1]) ? matched[1] : "PROCESS_CRASHED";
      const status = codes[code] ?? 500;
      const safeMessage = status >= 500 ? "Backend operation unavailable; inspect local diagnostics" : (matched?.[2] || "Request rejected").slice(0, 400);
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({ error: { code, message: safeMessage, retryable: code === "RATE_LIMITED" || code === "AGENT_UNAVAILABLE" }, requestId }), { status, headers });
    }
  };
}

export function startHubHttp(options: HubHttpOptions) {
  return Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 4321, idleTimeout: 120, maxRequestBodySize: BODY_LIMIT,
    fetch: createHubHandler(options) });
}
