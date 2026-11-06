# Antigravity Frontend Delivery `F02-r2` (Revision `r2` — Rework `R1` ~ `R5` Complete)

- **Delivery ID:** `F02-r2` (`revision: "r2"`, supersedes `F02`)
- **Tasks Covered:** `F-02` (Frontend Live Execution Switching & Adaptation) & `I-01` (End-to-End Frontend + Backend Integration)
- **Cross-Review Rework Items Resolved:** `R1`, `R2`, `R3`, `R4`, `R5` (from `Codex/backend-deliveries/F02-cross-review/README.md`)
- **Original `F02` Preservation:** `Antigravity/frontend-deliveries/F02/` and `Antigravity/evidence/live-f02-i01*` remain completely untouched as historical baseline records.

---

## 1. File Hashes (SHA-256)

| File | SHA-256 |
|---|---|
| `apps/web/public/index.html` (`F02-r2/index.html`) | `66304e120a1fad26f5a79e740721a1140fa81f6c5b27d9ab6472f17ac595bde5` |
| `apps/web/public/app.js` (`F02-r2/app.js`) | `e1652a7c8a9465cb1f20434fe253b0488a051f1a9438265b42082aa162c69463` |
| `apps/web/public/styles.css` (`F02-r2/styles.css`) | `cf18944d3c0fb913ff95ace72b40acd6216662d5d5e6203933214e0c88039fbe` |
| `Antigravity/frontend-deliveries/F02-r2/app.live-native.js` | `818fcb3ac8fb44ea103d8f293b9e64f95ca3e5de6981fa41f06f4e75060eb2ea` |
| `Antigravity/frontend-deliveries/F02-r2/index.live-native.html` | `83e361e46fe0adceed36f79a47422604679828fdbb7b2199455140f75638b317` |

- **`buildFrontendAssets` Bridge Compatibility:** All 19 `replaceExact` anchors in `backend/agetor/packages/core/frontend.ts` are preserved intact (`bun test src/bun/hub-frontend.test.ts` passes 7/7 tests, 36 assertions).

---

## 2. Rework Fixes (`R1` ~ `R5`)

1. **`R2 [P1]` & `R4 [P2]` — Unified Raw Artifact Fetch Entry (`fetchArtifactRaw`) Separated from Display Formatting (`formatArtifactPreviewFromRaw`):**
   - `apiRequest(path, options)` routes `/^\/api\/v1\/artifacts\/([^/]+)\/content$/` **before** `{ data, requestId }` business API unwrapping.
   - `fetchArtifactRaw(artifactId)` carries `Authorization: Bearer ${AUTH_TOKEN}`, validates `res.ok` (rejecting error responses before any download or cache write), reads raw `Uint8Array` bytes via `res.arrayBuffer()`, preserves original `mimeType`, computes SHA-256 via `crypto.subtle.digest('SHA-256', bytes)`, and verifies equality against `Artifact.sha256` (throwing `ARTIFACT_INTEGRITY_MISMATCH` on mismatch).
   - `[data-download-artifact]` downloads `new Blob([raw.bytes], { type: raw.mimeType })` directly from `fetchArtifactRaw`, preserving exact bytes and SHA-256 for compact JSON (`{"ok":true}` -> `4062edaf...`), JSON with `"data"` keys, and binary non-UTF8 files (`bytesPreserved: true`).
   - `formatArtifactPreviewFromRaw` formats preview text only for display, preserving all keys on JSON objects containing `"data"` (`{"data":"payload","metadata":"must survive"}`), JSON string literals (`"hello-json-string"`), plain text, and rendering a safe summary (`[Binary Artifact · ... bytes]`) when non-UTF8 bytes are encountered.
2. **`R3 [P1]` — Explicit Plan Compatibility Gate (`inspectDraftPlanCompatibility`) & Transitive Dependency Preservation (`sanitizeExecutablePlan`):**
   - In Live mode, clicking `#launchTaskBtn` on a `DraftPlan` containing `stage === 'analysis'` or reserved `code === 'FINAL-REVIEW'` (or 0 executable nodes) **explicitly rejects creation (`INVALID_INPUT`)** instead of silently dropping subtasks or returning `undefined`.
   - When compressing non-executable nodes via `#compressDraftPlanBtn` or `sanitizeExecutablePlan(subtasks)`, transitive dependencies across removed nodes are preserved (`A -> B(analysis) -> C` yields `C.dependsOn = ['A']`), upstream `acceptanceCriteria` on removed `analysis` nodes are merged into downstream nodes, and the user re-previews the compressed plan before launching.
   - If all nodes in a plan are filtered out (`0` executable nodes remain), `sanitizeExecutablePlan` throws `INVALID_INPUT` instead of returning `undefined`.
3. **`R1 [P1]` & `R5 [P2]` — Honest Evidence Layering & Post-Cancel Log Contract Alignment:**
   - `Antigravity/evidence/f02-r2/controlled-chrome-f02-r2.json` and `Antigravity/evidence/f02-r2/verification-report-r2.md` explicitly classify the Chrome full-interaction suite as **"真实控制器/HTTP/Chrome，provider与planner为受控替身、testRunner替换"**, clarify that the task title is a UI fixture label while the code fixture is `src/clamp.py`, and link Codex's uninjected real CLI + formal `codex sandbox -P hub-test` evidence (`Codex/backend-deliveries/B04-B06/evidence/real-http.json`).
   - Withdrew the unverified Live `drained=true` claim (`R5`): `CodexRuntime` (`packages/agent-adapters/codex/runtime.ts:165,175`) intentionally drops stdout/stderr after `run.intent = "CANCELLED"`, so `tests/verify-live-f02-r2.ts` strictly asserts `cancelled` terminal convergence, pre-cancel log presence (`preCancelLogCount >= 1`), and `liveDrainedLogCount === 0`.
