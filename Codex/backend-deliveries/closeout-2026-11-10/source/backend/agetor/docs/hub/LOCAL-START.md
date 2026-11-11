# Local Hub v0.2 (macOS MVP)

This entry reuses Agetor's SQLite and controlled Codex adapter. Do not launch the original multi-harness desktop entry as a substitute.

Prerequisites: Bun, Git, official Codex CLI already logged in. No API key or vendor fallback. Execution concurrency is one (8 GB Mac). Windows execution is refused until verified.

Create an owner-managed JSON file outside Agent workspaces:

```json
{
  "root": "/absolute/path/outside-any-git-checkout/hub-runtime",
  "port": 4321,
  "frontendDir": ".//apps/web/public",
  "repositories": [{
    "id": "33333333-3333-4333-8333-333333333333",
    "label": "Your repository",
    "path": "/absolute/path/to/existing-git-repository",
    "defaultTestProfileId": "acceptance",
    "model": "gpt-6.1-sol",
    "effort": "high",
    "testProfiles": [{
      "id": "acceptance",
      "command": ["/absolute/path/to/python3", "-I", "-B", "-c", "YOUR_OWNER_REVIEWED_ASSERTIONS"],
      "timeoutMs": 15000
    }]
  }]
}
```

Use an actual fixed assertion command, not a placeholder or unconditional success command. Owner-reviewed inline assertions or protected external scripts are preferred; tests stored in Agent-writable source can themselves be edited and are not an independent acceptance oracle. `readPaths`, if needed for a trusted test interpreter/script, grants read access and must be minimal. Scratch output must use `.hub-test`; source mutations during tests fail acceptance. Test subprocesses have no model credentials or network access.

Run `bun scripts/start-hub.ts /absolute/path/config.json` from the backend directory. Open the printed loopback URL. A per-launch random token is saved only in runtime `state/credentials.json` with mode0600 and provided to the local UI through a CSP nonce bootstrap. It is never printed or put in a URL. Ctrl-C stops owned work and server; it does not push changes or publish.

`state/` and `workspaces/` are disjoint. Each task uses an independent bare mirror and coordinator Worktrees; Agent cwd is an ordinary code copy without `.git`. Original source repo is unchanged. Current limits: 100 total steps including mandatory final review, 2 attempts per step, 4 MiB/file, 32 MiB/500-file snapshot, 100 delivered changed files per step. `node_modules`, `.venv`, `__pycache__` and `.hub-test` are excluded. Symlinks, hardlinks and special files are refused.

The live frontend is a frozen in-memory adaptation of the exact Antigravity source snapshot. Original HTML/JS/CSS remain untouched; changed anchors cause startup failure requiring a reviewed patch. API only exposes `/api/v1` registered repositories and test profiles; it never accepts an arbitrary command/path.

Lifecycle: plan -> DAG -> isolated execution -> capture/hash artifacts -> registered tests -> independent reviewer session -> final human approval -> succeeded. A model's success text never finalizes a Task. Final approval binds current run/session, criteria, artifact hashes, digest, version and expiry; content changes invalidate approval. Human rejection stays waiting for explicit rework. Automatic analysis-stage execution is currently refused: planning handles analysis, and a separate acceptance policy would be required for executable analysis steps.

Capabilities are honest: live-context is unavailable (messages queue to the next turn). `resume` exists in the adapter, but crashed durable runs are quarantined rather than blindly resumed. Controller shutdown cancels its owned active task. A disappeared owner does not authorize killing/replaying unknown processes.

This is a local single-user MVP. Codex's model request still uses the existing subscription; shell-network blocking does not make inference offline. Complete Agent read isolation, long-run load, active-model crash takeover, Windows and other vendors remain unverified. Do not expose the listener publicly.


## 2026-11-09 hardening

The default demo now runs owner-controlled assertions from the project config/acceptance directory outside Agent workspaces. That directory is read-only in the official test sandbox. Keep config and assertions under local-owner control.

Migration 085 persists validation process ownership and distinguishes in-process API calls from process groups. After a controller crash, only the recorded process incarnation authorizes terminating the owned test group. Unknown ownership remains quarantined and appears in meta.needsAttention. The local operator reviews the workspace and process state before using the validation-acknowledge control. Interrupted tasks remain failed and require explicit retry.

Run metadata stores the actual provider/model/capabilities. Archived runs may omit these fields. WorkBuddy read-only execution remains disabled until its gateway can enforce it. Live account/gateway tests are opt-in with HUB_LIVE_TESTS=1; ordinary regressions use deterministic local fixtures.


## 2026-11-10 closeout

Default config retains Antigravity's four-slot scheduling and Codex/auto/Claude stage policy. This policy does not prove account availability. Codex alias resolves to gpt-6.1-sol; the task modal can independently select Codex for development and read-only review using the local authenticated CLI. Claude requires a valid Anthropic configuration and no longer silently falls back to DeepSeek. Auto workers are assigned explicit models in order, without automatic provider health/quota discovery.

Muse and WorkBuddy remain available as development adapters. Planning and read-only review through these gateways fail with UNSUPPORTED_CAPABILITY until an enforceable read-only policy is verified. External native execution cancellation/recovery is not certified by the local process recovery tests. DeepSeek's last real attempt on 2026-11-09 returned HTTP 402. See Codex/backend-deliveries/closeout-2026-11-10 for the current manifest and deployment evidence. Windows and long-duration stress tests remain unverified.
