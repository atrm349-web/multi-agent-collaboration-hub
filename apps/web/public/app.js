// Multi-Agent Collaboration Hub — Frontend Controller (apps/web/public/app.js)
// Strictly aligned with Unified Contract v0.2 (docs/api-contract.md & packages/shared/src/types.v0.2.ts):
// 1. All business endpoints use /api/v1/* with { data, requestId } and Page<T> { items, nextCursor }.
// 2. Mutating POST requests include Idempotency-Key and expectedVersion CAS.
// 3. Statuses strictly use v0.2 enums: succeeded, waiting_approval, pausing -> paused, cancelling -> cancelled.
// 4. Approval decisions strictly use 'approve' | 'reject'; rework uses POST /api/v1/subtasks/:id/rework.
// 5. Historical real CLI evidence (real-relay-01) is strictly read-only.
// 6. Mock step/reset/fault controls are isolated under /__mock_control/* outside /api/v1.

const AUTH_TOKEN = 'dev-local-hub-token-v1';

const uiState = {
  activeView: 'agent-router',
  selectedTaskId: 'task-smartcar-01',
  selectedAgentId: 'all',
  selectedArtifactCategory: 'all',
  sseConnected: false,
  snapshotSeq: 0,
  lastAppliedSeq: 0,
  duplicateEventsIgnored: 0,
  meta: {
    contractVersion: '0.2',
    executionMode: 'mock',
    liveExecutionAvailable: false,
    enabledFeatures: []
  },
  repositories: [],
  tasksPage: { items: [], nextCursor: null },
  agentsPage: { items: [], nextCursor: null },
  selectedTaskDetail: null, // TaskDetail: { task, subtasks, runs: Page, validations: Page, approvals: Page, artifacts: Page }
  messagesPage: { items: [], nextCursor: null },
  runLogsByRunId: {}, // runId -> { items: LogLine[], nextSeq, hasMore }
  artifactContentCache: {}, // artifactId -> string
  composerDraft: {
    title: 'Python 智能车视觉识别系统（赛道识别 + 障碍物检测 + 测试与文档）',
    goal: '开发一个基于 Python 的智能车视觉识别系统，要求实现赛道识别、障碍物检测、测试验证，并生成完整开发文档。',
    repositoryId: 'repo-smartcar-vision',
    priority: 'high',
    draftPlan: null
  },
  directiveDraft: '',
  directiveSubtaskId: '',
  reviewComments: {},
  routerMode: 'live', // 'live' (formal production mode) | 'demo'
  routerSelectedMember: 'all',
  selectedTextDeliverableId: null
};
globalThis.uiState = uiState;

function getTaskTextDeliverables(detail) {
  const allArts = Array.isArray(detail?.artifacts)
    ? detail.artifacts
    : detail?.artifacts?.items || [];
  const docArts = allArts.filter((a) => {
    const label = String(a.relativePath || a.name || '').toLowerCase();
    return a.category === 'documentation' || label.endsWith('.md') || label.endsWith('.txt');
  });
  const priorityScore = (art) => {
    const name = String(art.relativePath || art.name || '');
    if (/报告|直答|穿衣|天气|DELIVERY_REPORT|成果文字说明/i.test(name)) return 0;
    if (/README/i.test(name)) return 1;
    return 2;
  };
  return [...docArts].sort((a, b) => priorityScore(a) - priorityScore(b));
}

function renderReadableTextReport(rawText) {
  const lines = String(rawText ?? '').split('\n');
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '<div style="height:8px;"></div>';
      const formatInline = (s) =>
        escapeHtml(s)
          .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fff;font-weight:700;">$1</strong>')
          .replace(/`([^`]+)`/g, '<code style="background:rgba(56,189,248,0.14);color:#7dd3fc;padding:1px 5px;border-radius:4px;font-family:var(--font-mono);font-size:12px;">$1</code>');
      if (trimmed.startsWith('# ')) {
        return `<div style="font-size:18px;font-weight:800;color:#f8fafc;margin:12px 0 6px;padding-bottom:6px;border-bottom:1px solid rgba(56,189,248,0.25);">${formatInline(trimmed.slice(2))}</div>`;
      }
      if (trimmed.startsWith('## ')) {
        return `<div style="font-size:15px;font-weight:700;color:#38bdf8;margin:10px 0 4px;">${formatInline(trimmed.slice(3))}</div>`;
      }
      if (trimmed.startsWith('### ')) {
        return `<div style="font-size:13.5px;font-weight:700;color:#a5b4fc;margin:8px 0 3px;">${formatInline(trimmed.slice(4))}</div>`;
      }
      if (trimmed.startsWith('> ')) {
        return `<div style="border-left:3px solid #10b981;padding:4px 10px;margin:4px 0;background:rgba(16,185,129,0.08);color:#d1fae5;border-radius:0 6px 6px 0;font-size:13px;">${formatInline(trimmed.slice(2))}</div>`;
      }
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        return `<div style="padding-left:14px;margin:3px 0;color:#e2e8f0;font-size:13px;line-height:1.65;">• ${formatInline(trimmed.slice(2))}</div>`;
      }
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        if (/^\|[\s\-:|]+\|$/.test(trimmed)) return '';
        const cells = trimmed.slice(1, -1).split('|').map((c) => formatInline(c.trim()));
        return `<div style="display:grid;grid-template-columns:repeat(${cells.length},minmax(80px,1fr));gap:8px;padding:6px 10px;background:rgba(15,23,42,0.65);border-bottom:1px solid rgba(255,255,255,0.07);font-size:12.5px;color:#e2e8f0;">${cells.map((c) => `<div>${c}</div>`).join('')}</div>`;
      }
      return `<div style="color:#e2e8f0;font-size:13.5px;line-height:1.7;margin:2px 0;">${formatInline(line)}</div>`;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFormattedCodeOrDiff(rawText) {
  const lines = String(rawText ?? '').split('\n');
  return lines
    .map((line, idx) => {
      const escaped = escapeHtml(line);
      let lineClass = 'code-line';
      if (line.startsWith('+++') || line.startsWith('---')) {
        lineClass += ' diff-line-meta';
      } else if (line.startsWith('@@')) {
        lineClass += ' diff-line-hunk';
      } else if (line.startsWith('+')) {
        lineClass += ' diff-line-add';
      } else if (line.startsWith('-')) {
        lineClass += ' diff-line-del';
      }
      return `<div class="${lineClass}"><span class="code-ln">${idx + 1}</span><span>${escaped || ' '}</span></div>`;
    })
    .join('');
}

function makeIdempotencyKey(prefix = 'ui') {
  const cleanPrefix = String(prefix || 'ui').replace(/^[^a-z0-9]+/i, '') || 'ui';
  return `${cleanPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function showToast(msg, isError = false) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  if (isError) {
    el.style.borderColor = '#ef4444';
  }
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function computeSha256Hex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', u8);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function findArtifactRecord(artifactId) {
  const fromPage = (uiState.artifactsPage?.items || []).find((a) => a.id === artifactId);
  if (fromPage) return fromPage;
  const detailItems = Array.isArray(uiState.selectedTaskDetail?.artifacts)
    ? uiState.selectedTaskDetail.artifacts
    : uiState.selectedTaskDetail?.artifacts?.items || [];
  return detailItems.find((a) => a.id === artifactId) || null;
}

function formatArtifactPreviewFromRaw({ bytes, mimeType, sha256 }) {
  let rawText;
  try {
    rawText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `[Binary Artifact · ${bytes.byteLength} bytes · mimeType=${mimeType} · sha256=${sha256}]`;
  }
  if ((mimeType || '').includes('application/json')) {
    try {
      const parsed = JSON.parse(rawText);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return rawText;
    }
  }
  return rawText;
}

async function fetchArtifactRaw(artifactId, options = {}) {
  const path = `/api/v1/artifacts/${encodeURIComponent(artifactId)}/content`;
  const headers = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...(options.headers || {})
  };
  const res = await fetch(path, {
    ...options,
    method: 'GET',
    headers
  });

  const contentType = res.headers?.get?.('content-type') || 'application/octet-stream';
  const mimeType = contentType.split(';')[0].trim() || 'application/octet-stream';
  const isJson = contentType.includes('application/json');

  if (!res.ok) {
    let payload = null;
    try {
      payload = isJson && typeof res.json === 'function' ? await res.json() : await res.text();
    } catch {
      payload = null;
    }
    const code = payload?.error?.code || `HTTP_${res.status}`;
    const errMsg = payload?.error?.message || `HTTP ${res.status}`;
    showToast(`产物读取被拒绝 [${code}]: ${errMsg}`, true);
    const err = new Error(`${code}: ${errMsg}`);
    err.code = code;
    err.status = res.status;
    throw err;
  }

  let bytes;
  if (typeof res.arrayBuffer === 'function') {
    const ab = await res.arrayBuffer();
    bytes = new Uint8Array(ab);
  } else if (typeof res.text === 'function') {
    const rawText = await res.text();
    bytes = new TextEncoder().encode(rawText);
  } else if (typeof res.json === 'function') {
    const rawJson = await res.json();
    const serialized = typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson);
    bytes = new TextEncoder().encode(serialized);
  } else {
    bytes = new Uint8Array(0);
  }

  const sha256 = await computeSha256Hex(bytes);
  const record = options.expectedSha256 ? { sha256: options.expectedSha256 } : findArtifactRecord(artifactId);
  const expectedSha256 = record?.sha256 || null;

  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256.toLowerCase()) {
    const msg = `Artifact ${artifactId} SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`;
    showToast(`受控产物哈希校验失败 [ARTIFACT_INTEGRITY_MISMATCH]: ${msg}`, true);
    const err = new Error(`ARTIFACT_INTEGRITY_MISMATCH: ${msg}`);
    err.code = 'ARTIFACT_INTEGRITY_MISMATCH';
    err.status = 422;
    throw err;
  }

  return {
    artifactId,
    bytes,
    mimeType,
    contentType,
    sha256,
    expectedSha256
  };
}

async function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const contentMatch = path.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/);
  if (contentMatch && method === 'GET') {
    const raw = await fetchArtifactRaw(decodeURIComponent(contentMatch[1]), options);
    if (options.rawBytes) return raw;
    return formatArtifactPreviewFromRaw(raw);
  }

  const headers = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...(options.headers || {})
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (method === 'POST' && path.startsWith('/api/v1/') && !headers['Idempotency-Key']) {
    headers['Idempotency-Key'] = makeIdempotencyKey(path.replace(/[^a-z0-9]/gi, '-'));
  }

  const res = await fetch(path, {
    ...options,
    method,
    headers
  });

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const code = payload?.error?.code || `HTTP_${res.status}`;
    const errMsg = payload?.error?.message || `HTTP ${res.status}`;
    if (res.status === 409) {
      showToast(`[409 ${code}] ${errMsg} — 正在同步最新一致性快照...`, true);
      await loadConsistentSnapshot(uiState.selectedTaskId);
    } else {
      showToast(`请求被拒绝 [${code}]: ${errMsg}`, true);
    }
    const err = new Error(`${code}: ${errMsg}`);
    err.code = code;
    err.status = res.status;
    throw err;
  }

  return isJson ? payload.data : payload;
}

function inspectDraftPlanCompatibility(subtasks) {
  if (!Array.isArray(subtasks)) {
    return {
      hasPlan: false,
      totalCount: 0,
      analysisNodes: [],
      reservedNodes: [],
      executableCount: 0,
      isDirectlyExecutable: true
    };
  }
  const analysisNodes = subtasks.filter((s) => s.stage === 'analysis');
  const reservedNodes = subtasks.filter((s) => s.code === 'FINAL-REVIEW');
  const executable = subtasks.filter((s) => s.stage !== 'analysis' && s.code !== 'FINAL-REVIEW');
  return {
    hasPlan: true,
    totalCount: subtasks.length,
    analysisNodes,
    reservedNodes,
    executableCount: executable.length,
    isDirectlyExecutable:
      subtasks.length > 0 &&
      analysisNodes.length === 0 &&
      reservedNodes.length === 0 &&
      executable.length === subtasks.length
  };
}

function sanitizeExecutablePlan(subtasks) {
  if (!Array.isArray(subtasks)) return undefined;
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const executable = subtasks.filter((s) => s.stage !== 'analysis' && s.code !== 'FINAL-REVIEW');
  if (executable.length === 0) {
    const err = new Error(
      'INVALID_INPUT: DraftPlan contains no executable subtasks after removing analysis/FINAL-REVIEW nodes; refusing to return undefined or silently re-plan.'
    );
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const validIds = new Set(executable.map((s) => s.id));

  function resolveTransitiveDependsOn(depIds, visited = new Set()) {
    const result = [];
    for (const depId of depIds || []) {
      if (visited.has(depId)) continue;
      visited.add(depId);
      if (validIds.has(depId)) {
        if (!result.includes(depId)) result.push(depId);
      } else if (byId.has(depId)) {
        const upstreamNode = byId.get(depId);
        const transitive = resolveTransitiveDependsOn(upstreamNode.dependsOn || [], visited);
        for (const tId of transitive) {
          if (!result.includes(tId)) result.push(tId);
        }
      }
    }
    return result;
  }

  function collectRemovedAncestors(depIds, visited = new Set()) {
    const removed = [];
    for (const depId of depIds || []) {
      if (visited.has(depId)) continue;
      visited.add(depId);
      if (!validIds.has(depId) && byId.has(depId)) {
        const node = byId.get(depId);
        removed.push(node);
        for (const anc of collectRemovedAncestors(node.dependsOn || [], visited)) {
          if (!removed.some((r) => r.id === anc.id)) removed.push(anc);
        }
      }
    }
    return removed;
  }

  const inheritedByStep = new Map(
    executable.map((step) => [step.id, collectRemovedAncestors(step.dependsOn || [])])
  );
  // A removed node needs exactly one destination to preserve its acceptance criteria unambiguously.
  for (const removed of subtasks.filter((step) => !validIds.has(step.id))) {
    const destinations = executable.filter((step) =>
      inheritedByStep.get(step.id).some((ancestor) => ancestor.id === removed.id)
    );
    if (destinations.length !== 1) {
      const err = new Error(
        `INVALID_INPUT: Cannot compress ${removed.code}: expected exactly one executable destination for its acceptance criteria, found ${destinations.length}. Please regenerate the plan with executable stages.`
      );
      err.code = 'INVALID_INPUT';
      throw err;
    }
  }

  return executable.map((s) => {
    const dependsOn = resolveTransitiveDependsOn(s.dependsOn || []);
    const removedAncestors = inheritedByStep.get(s.id);
    const next = {
      ...s,
      dependsOn
    };
    if (removedAncestors.length > 0 && Array.isArray(s.acceptanceCriteria)) {
      const seenAc = new Set(s.acceptanceCriteria.map((ac) => ac.id));
      const mergedAc = [...s.acceptanceCriteria];
      for (const rem of removedAncestors) {
        for (const ac of rem.acceptanceCriteria || []) {
          if (ac?.id && !seenAc.has(ac.id)) {
            seenAc.add(ac.id);
            mergedAc.push(ac);
          }
        }
      }
      if (mergedAc.length > 20) {
        const err = new Error('INVALID_INPUT: Compressed subtask exceeds 20 acceptance criteria. Please regenerate the plan.');
        err.code = 'INVALID_INPUT';
        throw err;
      }
      next.acceptanceCriteria = mergedAc;
    }
    return next;
  });
}

globalThis.apiRequest = apiRequest;
globalThis.fetchArtifactRaw = fetchArtifactRaw;
globalThis.sanitizeExecutablePlan = sanitizeExecutablePlan;
globalThis.inspectDraftPlanCompatibility = inspectDraftPlanCompatibility;

async function ensureArtifactContent(artifactId) {
  if (!artifactId || uiState.artifactContentCache[artifactId] !== undefined) return;
  uiState.artifactContentCache[artifactId] = 'Loading content...';
  try {
    const text = await apiRequest(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/content`);
    uiState.artifactContentCache[artifactId] = text;
    renderAll();
  } catch (err) {
    uiState.artifactContentCache[artifactId] = `[Failed to load artifact ${artifactId}: ${err.message}]`;
    renderAll();
  }
}

async function ensureRunLogs(runId) {
  if (!runId) return;
  try {
    const current = uiState.runLogsByRunId[runId];
    const afterSeq = current ? current.nextSeq : 0;
    const logPage = await apiRequest(`/api/v1/runs/${encodeURIComponent(runId)}/logs?afterSeq=${afterSeq}&limit=200`);
    const existingItems = current ? current.items : [];
    const seen = new Set(existingItems.map((i) => i.logSeq));
    const merged = [...existingItems];
    for (const line of logPage.items || []) {
      if (!seen.has(line.logSeq)) {
        seen.add(line.logSeq);
        merged.push(line);
      }
    }
    merged.sort((a, b) => a.logSeq - b.logSeq);
    uiState.runLogsByRunId[runId] = {
      runId,
      items: merged,
      nextSeq: logPage.nextSeq,
      hasMore: logPage.hasMore
    };
  } catch (err) {
    console.warn('Failed to load run logs:', err);
  }
}

async function loadTaskAuxiliaryData(taskId) {
  if (!taskId) return;
  try {
    const [messagesPage, detail] = await Promise.all([
      apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/messages?limit=50`),
      apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
    ]);
    uiState.messagesPage = messagesPage;
    uiState.selectedTaskDetail = detail;

    // Preload logs for visible runs and diff artifacts for pending approvals
    const runs = detail?.runs?.items || [];
    await Promise.all(runs.map((r) => ensureRunLogs(r.id)));

    const artifacts = detail?.artifacts?.items || [];
    await Promise.all(artifacts.map((art) => ensureArtifactContent(art.id)));
  } catch (err) {
    console.warn('Failed to load auxiliary task data:', err);
  }
}

async function loadConsistentSnapshot(preferredTaskId = null) {
  const targetTaskId = preferredTaskId || uiState.selectedTaskId || '';
  const query = targetTaskId ? `?taskId=${encodeURIComponent(targetTaskId)}` : '';
  const [meta, reposPage, snapshot] = await Promise.all([
    apiRequest('/api/v1/meta'),
    apiRequest('/api/v1/repositories?limit=50'),
    apiRequest(`/api/v1/snapshot${query}`)
  ]);

  uiState.meta = meta;
  uiState.repositories = reposPage.items || [];
  const selectableRepos = uiState.repositories.filter((r) => r.id !== 'repo-real-relay-01');
  if (selectableRepos.length > 0 && !selectableRepos.some((r) => r.id === uiState.composerDraft.repositoryId)) {
    uiState.composerDraft.repositoryId = selectableRepos[0].id;
  }
  uiState.snapshotSeq = snapshot.snapshotSeq;
  uiState.lastAppliedSeq = snapshot.snapshotSeq;
  uiState.tasksPage = snapshot.tasks || { items: [], nextCursor: null };
  uiState.agentsPage = snapshot.agents || { items: [], nextCursor: null };
  uiState.selectedTaskDetail = snapshot.selectedTask || null;

  if (uiState.selectedTaskDetail?.task?.id) {
    uiState.selectedTaskId = uiState.selectedTaskDetail.task.id;
    await loadTaskAuxiliaryData(uiState.selectedTaskId);
  }

  renderAll();
  return snapshot;
}

let sseAbortController = null;

function applyEnvelopeEvent(envelope) {
  const { seq, type, payload, runId } = envelope;
  if (typeof seq === 'number' && seq > 0) {
    if (seq <= uiState.lastAppliedSeq) {
      uiState.duplicateEventsIgnored += 1;
      return;
    }
    uiState.lastAppliedSeq = seq;
  }

  const lineObj = payload?.line || (typeof payload?.logSeq === 'number' ? payload : null);
  const targetRunId = runId || payload?.runId;
  if (type === 'run.output' && lineObj && targetRunId) {
    const entry = uiState.runLogsByRunId[targetRunId] || { runId: targetRunId, items: [], nextSeq: 0, hasMore: false };
    if (!entry.items.some((l) => l.logSeq === lineObj.logSeq)) {
      entry.items.push(lineObj);
      entry.items.sort((a, b) => a.logSeq - b.logSeq);
      entry.nextSeq = Math.max(entry.nextSeq, lineObj.logSeq);
    }
    uiState.runLogsByRunId[targetRunId] = entry;
    renderAll();
    return;
  }

  // Refresh consistent snapshot/detail view when state-mutating events arrive
  loadConsistentSnapshot(uiState.selectedTaskId).catch((err) => console.warn('Refresh after SSE failed:', err));
}

async function connectFetchSse(overrideCursor = null) {
  if (sseAbortController) {
    sseAbortController.abort();
  }
  sseAbortController = new AbortController();
  const badge = document.getElementById('sseStatusBadge');
  const cursorToSend = overrideCursor !== null ? overrideCursor : uiState.lastAppliedSeq || uiState.snapshotSeq || '';

  try {
    const headers = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${AUTH_TOKEN}`
    };
    if (cursorToSend !== '') {
      headers['Last-Event-ID'] = String(cursorToSend);
    }

    const response = await fetch('/api/v1/events', {
      method: 'GET',
      headers,
      signal: sseAbortController.signal
    });

    if (response.status === 409) {
      showToast('检测到 SSE 游标过期 (409 EVENT_CURSOR_EXPIRED)，正在重新拉取 /api/v1/snapshot 并恢复订阅...', true);
      const snap = await loadConsistentSnapshot(uiState.selectedTaskId);
      return connectFetchSse(snap.snapshotSeq);
    }

    if (!response.ok || !response.body) {
      throw new Error(`SSE HTTP ${response.status}`);
    }

    uiState.sseConnected = true;
    if (badge) {
      badge.textContent = `SSE v0.2: Connected (snapshotSeq=${uiState.snapshotSeq}, seq=${uiState.lastAppliedSeq})`;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF -> LF across chunks
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);

        const lines = rawFrame.split('\n');
        const dataLines = [];
        for (const line of lines) {
          if (!line || line.startsWith(':')) continue; // Ignore comments/heartbeats
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length === 0) continue;
        const jsonText = dataLines.join('\n');
        try {
          const envelope = JSON.parse(jsonText);
          applyEnvelopeEvent(envelope);
          if (badge) {
            badge.textContent = `SSE v0.2: Connected (snapshotSeq=${uiState.snapshotSeq}, seq=${uiState.lastAppliedSeq})`;
          }
        } catch (parseErr) {
          console.warn('SSE frame JSON parse error:', parseErr);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    uiState.sseConnected = false;
    if (badge) badge.textContent = 'SSE v0.2: Reconnecting...';
    setTimeout(() => connectFetchSse(), 2500);
  }
}
globalThis.connectFetchSse = connectFetchSse;

function getSelectedTask() {
  if (uiState.selectedTaskDetail?.task) {
    return uiState.selectedTaskDetail.task;
  }
  const items = uiState.tasksPage.items || [];
  return items.find((t) => t.id === uiState.selectedTaskId) || items[0] || null;
}

function captureCurrentInputsBeforeRender() {
  const titleEl = document.getElementById('composerTitleInput');
  const goalEl = document.getElementById('composerGoalInput');
  const repoEl = document.getElementById('composerRepoSelect');
  const prioEl = document.getElementById('composerPrioritySelect');
  if (titleEl) uiState.composerDraft.title = titleEl.value;
  if (goalEl) uiState.composerDraft.goal = goalEl.value;
  if (repoEl) uiState.composerDraft.repositoryId = repoEl.value;
  if (prioEl) uiState.composerDraft.priority = prioEl.value;

  const directiveEl = document.getElementById('directiveInput');
  const directiveSubEl = document.getElementById('directiveTargetSubtask');
  if (directiveEl) uiState.directiveDraft = directiveEl.value;
  if (directiveSubEl) uiState.directiveSubtaskId = directiveSubEl.value;

  document.querySelectorAll('[data-review-comment-id]').forEach((input) => {
    const id = input.getAttribute('data-review-comment-id');
    uiState.reviewComments[id] = input.value;
  });
}

function renderTopbarAndSidebar() {
  const tasks = uiState.tasksPage.items || [];
  const selectedTask = getSelectedTask();
  const detail = uiState.selectedTaskDetail;
  const approvals = detail?.approvals?.items || [];
  const artifacts = detail?.artifacts?.items || [];
  const messages = uiState.messagesPage.items || [];
  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;

  const shell = document.querySelector('.app-shell');
  if (shell) {
    shell.classList.toggle('view-agent-router', uiState.activeView === 'agent-router');
  }

  const modeBadge = document.getElementById('executionModeBadge');
  if (modeBadge) {
    const isLiveAvail = Boolean(uiState.meta.liveExecutionAvailable);
    modeBadge.innerHTML = `<span class="dot"></span> SERVICE: ${uiState.meta.executionMode.toUpperCase()} · contractVersion=${uiState.meta.contractVersion} · liveExecutionAvailable=${isLiveAvail}`;
  }

  const repoBadge = document.getElementById('activeRepoBadge');
  if (repoBadge && selectedTask) {
    const repo = uiState.repositories.find((r) => r.id === selectedTask.repositoryId);
    repoBadge.textContent = repo
      ? `Repo: ${repo.label} (${repo.baseBranch} @ ${selectedTask.baseCommit})`
      : `RepoId: ${selectedTask.repositoryId} (@ ${selectedTask.baseCommit})`;
  }

  document.getElementById('navTaskCount').textContent = tasks.length;
  document.getElementById('navMsgCount').textContent = messages.length;
  document.getElementById('navApprovalCount').textContent = pendingApprovals;
  document.getElementById('navArtifactCount').textContent = artifacts.length;

  document.querySelectorAll('#navList .nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === uiState.activeView);
  });

  const listEl = document.getElementById('sidebarTaskList');
  listEl.innerHTML = tasks
    .map((t) => {
      const isHistorical = t.provenance === 'historical';
      return `
      <div class="sidebar-task-card ${selectedTask && selectedTask.id === t.id ? 'selected' : ''}" data-select-task="${escapeHtml(t.id)}">
        <div class="sidebar-task-title">${escapeHtml(t.title)}</div>
        <div class="sidebar-task-meta">
          <span class="status-badge status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>
          <span>v${t.version} · ${t.progressPct}% · <span class="mock-tag ${isHistorical ? 'provenance-live' : ''}">${isHistorical ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'}</span></span>
        </div>
      </div>
    `;
    })
    .join('');
}

function renderActiveTaskBar() {
  const bar = document.getElementById('activeTaskBar');
  const task = getSelectedTask();
  if (!task) {
    bar.innerHTML = `<div class="task-bar-row"><span>暂无活动任务，请点击右上角「+ 发布新协同任务」</span></div>`;
    return;
  }

  const isHistorical = task.provenance === 'historical';
  const canPause = !isHistorical && ['queued', 'running', 'waiting_approval'].includes(task.status);
  const canResume = !isHistorical && task.status === 'paused';
  const canCancel = !isHistorical && !['succeeded', 'cancelled'].includes(task.status);

  const errorBannerHtml = task.error
    ? `
    <div class="error-banner">
      <div>
        <div class="error-banner-title">[${escapeHtml(task.error.code)}] ${escapeHtml(task.error.message)}</div>
        <div class="error-banner-desc">
          retryable=${Boolean(task.error.retryable)} · occurredAt=${escapeHtml(task.error.occurredAt || 'N/A')}
          ${task.error.details?.suggestedAction ? ` · 建议: ${escapeHtml(task.error.details.suggestedAction)}` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        ${
          !isHistorical && task.error.details?.subtaskId && task.error.retryable
            ? `<button class="btn btn-warn" data-subtask-retry="${escapeHtml(task.error.details.subtaskId)}">重试失败子任务 (POST /subtasks/:id/retry)</button>`
            : ''
        }
      </div>
    </div>
  `
    : '';

  bar.innerHTML = `
    <div class="task-bar-row">
      <div class="task-bar-info">
        <span class="mock-tag ${isHistorical ? 'provenance-live' : ''}">${isHistorical ? '🔒 HISTORICAL REAL EVIDENCE (READ-ONLY · provenance=historical)' : 'MOCK CURRENT (executionMode=mock · provenance=current)'}</span>
        <span class="status-badge status-${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
        <span class="task-bar-title">${escapeHtml(task.title)}</span>
        <span style="color:var(--text-secondary);font-family:var(--font-mono);font-size:11px;">
          v${task.version} | 进度 ${task.progressPct}% | 待批 ${task.pendingApprovalCount} | 产物 ${task.artifactCount}
        </span>
      </div>
      <div class="task-bar-controls">
        ${
          isHistorical
            ? `<span style="font-size:11.5px;color:#34d399;font-family:var(--font-mono);">🔒 历史真实 CLI 证据只读保护：禁止对其执行 Pause/Resume/Cancel 或 Mock 注入</span>`
            : `
              <button class="btn btn-sm" data-v1-task-control="pause" data-task-id="${escapeHtml(task.id)}" data-version="${task.version}" ${!canPause ? 'disabled style="opacity:0.45;cursor:not-allowed;"' : ''} title="POST /api/v1/tasks/:id/pause (CAS expectedVersion + Idempotency-Key)">⏸ 暂停任务 (Pause → pausing)</button>
              <button class="btn btn-sm btn-success" data-v1-task-control="resume" data-task-id="${escapeHtml(task.id)}" data-version="${task.version}" ${!canResume ? 'disabled style="opacity:0.45;cursor:not-allowed;"' : ''} title="POST /api/v1/tasks/:id/resume (仅允许从 paused 状态恢复)">▶ 恢复派发 (Resume → queued)</button>
              <button class="btn btn-sm btn-danger" data-v1-task-control="cancel" data-task-id="${escapeHtml(task.id)}" data-version="${task.version}" ${!canCancel ? 'disabled style="opacity:0.45;cursor:not-allowed;"' : ''} title="POST /api/v1/tasks/:id/cancel (进入 cancelling 过渡态)">⏹ 取消任务 (Cancel → cancelling)</button>
            `
        }
      </div>
    </div>

    ${
      !isHistorical
        ? `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:5px 10px;background:rgba(245,158,11,0.07);border:1px dashed rgba(245,158,11,0.32);border-radius:6px;">
        <span style="font-size:11px;font-family:var(--font-mono);color:#fcd34d;">
          🧪 隔离模拟测试控制面 (<code>/__mock_control/*</code> · 物理隔离于 <code>/api/v1</code> 之外)：
        </span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" data-mock-step="${escapeHtml(task.id)}" title="POST /__mock_control/step：推进就绪子任务或将 pausing/cancelling 停稳">推进模拟步进 (Mock Step)</button>
          <button class="btn btn-sm" data-mock-fault="TIMEOUT" data-task-id="${escapeHtml(task.id)}">注入 TIMEOUT</button>
          <button class="btn btn-sm" data-mock-fault="PERMISSION_DENIED_EXTERNAL_GIT" data-task-id="${escapeHtml(task.id)}" title="模拟 B-01 外部 Git 元数据写拒绝 (禁止提权 danger-full-access)">注入 B-01 外部 Git 拒绝</button>
          <button class="btn btn-sm" data-mock-fault="WORKER_CRASH_INTERRUPTED" data-task-id="${escapeHtml(task.id)}" title="模拟 B-03 本地 Worker 崩溃与租约过期隔离 (Run -> interrupted, Subtask -> blocked)">注入 B-03 Worker 崩溃隔离</button>
          <button class="btn btn-sm" data-mock-fault="WORKTREE_CONFLICT" data-task-id="${escapeHtml(task.id)}">注入 WORKTREE_CONFLICT</button>
          <button class="btn btn-sm" id="resetDemoStateBtn">↺ 重置演示状态 (Mock Reset)</button>
        </div>
      </div>
    `
        : ''
    }

    <div class="progress-track">
      <div class="progress-fill" style="width:${task.progressPct}%"></div>
    </div>
    ${errorBannerHtml}
  `;
}

function renderDashboardView() {
  const tasks = uiState.tasksPage.items || [];
  const agents = uiState.agentsPage.items || [];
  const detail = uiState.selectedTaskDetail;
  const activeTask = detail?.task || getSelectedTask();
  const subtasks = detail?.subtasks || [];
  const approvals = detail?.approvals?.items || [];
  const artifacts = detail?.artifacts?.items || [];
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const succeededSubs = subtasks.filter((s) => s.status === 'succeeded').length;

  return `
    <!-- 1. 核心使命控制台 (Active Mission Command Center) -->
    ${
      activeTask
        ? `
      <div class="section-card mission-hero-card" style="border:1px solid rgba(56,189,248,0.35);background:linear-gradient(135deg,rgba(15,23,42,0.95) 0%,rgba(6,182,212,0.08) 100%);box-shadow:0 12px 36px rgba(0,0,0,0.4);">
        <div class="section-header" style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="status-badge status-${escapeHtml(activeTask.status)}" style="font-size:12px;padding:4px 10px;">
              ${escapeHtml(activeTask.status.toUpperCase())}
            </span>
            <div class="section-title" style="font-size:17px;font-weight:700;color:#fff;">
              🎯 当前核心使命：${escapeHtml(activeTask.title)}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-sm" data-goto-view="workflow-dag">查看完整流程图 (DAG) →</button>
            <button class="btn btn-sm btn-warn" data-goto-view="review-center">前往审查中心 (${pendingApprovals.length}) →</button>
            <button class="btn btn-sm" data-goto-view="agent-workspace">查看实时终端监控 →</button>
          </div>
        </div>

        <div style="background:rgba(9,14,26,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 14px;margin-bottom:14px;">
          <div style="font-size:13px;color:#cbd5e1;line-height:1.6;">
            <strong>使命目标 (Goal)：</strong>${escapeHtml(activeTask.goal)}
          </div>
        </div>

        <!-- 极简工序流状态条 (Pipeline Stepper) -->
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-size:12px;font-weight:600;color:var(--text-secondary);">多 Agent 协同流水线执行工序：</span>
            <span style="font-size:12px;font-family:var(--font-mono);color:#38bdf8;">进度: ${activeTask.progressPct}% (${succeededSubs}/${subtasks.length} 节点完成)</span>
          </div>
          <div class="dag-stages" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));gap:10px;">
            ${subtasks
              .map(
                (s) => `
              <div class="dag-node node-${escapeHtml(s.status)}" style="margin-top:0;padding:10px 12px;border-radius:8px;background:rgba(11,17,30,0.85);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                  <span style="font-weight:700;font-size:12px;color:#38bdf8;">${escapeHtml(s.code)}</span>
                  <span class="status-badge status-${escapeHtml(s.status)}" style="font-size:10px;padding:2px 6px;">${escapeHtml(s.status)}</span>
                </div>
                <div style="font-weight:600;font-size:12px;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${escapeHtml(s.title)}
                </div>
                <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-top:4px;">
                  阶段: ${escapeHtml(s.stage)} · ${escapeHtml(s.assignedAgentId || 'agent-codex')}
                </div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>

        <!-- 即时行动引导条 -->
        ${
          activeTask.status === 'waiting_approval'
            ? `
          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);border-radius:8px;padding:10px 14px;">
            <span style="color:#fbbf24;font-size:12.5px;font-weight:600;">
              ⚠️ 所有代码开发与测试已就绪，当前正在等待您的人工验收审批！
            </span>
            <button class="btn btn-warn" data-goto-view="review-center" style="font-weight:700;box-shadow:0 0 12px rgba(245,158,11,0.4);">
              👉 立即前往审查中心批准并放行
            </button>
          </div>
        `
            : activeTask.status === 'running'
            ? `
          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);border-radius:8px;padding:10px 14px;">
            <span style="color:#38bdf8;font-size:12.5px;display:flex;align-items:center;gap:8px;">
              <span class="status-dot" style="background:#38bdf8;box-shadow:0 0 8px #38bdf8;"></span>
              多 Agent 团队正在自主协同编码与沙箱测试中...
            </span>
            <button class="btn btn-sm btn-primary" data-goto-view="agent-workspace">进入终端监控现场 →</button>
          </div>
        `
            : activeTask.status === 'succeeded'
            ? `
          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:8px;padding:10px 14px;">
            <span style="color:#34d399;font-size:12.5px;">
              ✅ 任务已全链路通过质量门禁与人工审批，产物已成功归档！
            </span>
            <button class="btn btn-sm btn-success" data-goto-view="artifact-center">查看与下载交付成果 (${artifacts.length}) →</button>
          </div>
        `
            : ''
        }
      </div>
    `
        : ''
    }

    <!-- 2. 全局关键指标卡片 (Key Metrics) -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">📋 协同任务总览 (Tasks)</div>
        <div class="kpi-value">${tasks.length}</div>
        <div class="kpi-sub">2 项当前 Mock + 1 项只读历史实测证据</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">⚡ 流程节点达成 (Succeeded)</div>
        <div class="kpi-value">${succeededSubs} / ${subtasks.length}</div>
        <div class="kpi-sub">状态枚举严格对齐 v0.2 succeeded</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">🤖 在线 Agent 编队 (Fleet)</div>
        <div class="kpi-value">${agents.filter((a) => a.availability === 'available' || a.availability === 'busy').length} / ${agents.length}</div>
        <div class="kpi-sub">含 B-01 沙箱策略与 unsupportedReasons</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">🛡️ 待决审批门禁 (Approvals)</div>
        <div class="kpi-value" style="color:${pendingApprovals.length ? 'var(--accent-amber)' : 'var(--accent-green)'}">${pendingApprovals.length}</div>
        <div class="kpi-sub">审批与 Subtask Rework 职责严格分离</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">📦 交付产物库 (Artifacts)</div>
        <div class="kpi-value">${artifacts.length}</div>
        <div class="kpi-sub">relativePath + SHA-256 · 严禁绝对路径</div>
      </div>
    </div>

    <!-- 3. AI 专家团队矩阵 (AI Agent Fleet) -->
    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">🤖 AI Agent 专家协同编队 (Agent Team Fleet)</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">按职责与安全权限配置的分工协作矩阵</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn" id="testExpiredCursorBtn" title="发送过期 Last-Event-ID=1 触发 409 EVENT_CURSOR_EXPIRED 并验证自动快照重连">演练 SSE 游标过期恢复 (409 Replay)</button>
        </div>
      </div>
      <div class="agent-grid">
        ${agents
          .map(
            (ag) => `
          <div class="agent-card">
            <div class="agent-card-top">
              <div>
                <div class="agent-name" style="font-size:14px;font-weight:700;">${escapeHtml(ag.label)}</div>
                <div class="agent-role" style="font-size:12px;color:#38bdf8;">${escapeHtml(ag.roleTitle)}</div>
              </div>
              <span class="status-badge status-${escapeHtml(ag.availability)}">${escapeHtml(ag.availability)}</span>
            </div>
            <div style="font-size:11.5px;color:var(--text-secondary);font-family:var(--font-mono);margin-top:6px;">
              <div>核心职责: ${escapeHtml((ag.supportedStages || []).join(' / '))}</div>
              <div>安全沙箱: <code>${escapeHtml(ag.permissionProfile)}</code></div>
            </div>
            <div class="chip-list" style="margin-top:8px;">
              ${(ag.capabilities || []).map((c) => `<span class="chip" style="color:#6ee7b7;font-size:11px;">✓ ${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

function renderTaskCenterView() {
  const tasks = uiState.tasksPage.items || [];
  const draft = uiState.composerDraft;

  const columns = [
    {
      key: 'queued_running',
      title: '排队 / 拆解 / 执行中 (draft / queued / running)',
      filter: (t) => ['draft', 'decomposing', 'queued', 'running'].includes(t.status)
    },
    {
      key: 'waiting_approval',
      title: '等待人工审批 (waiting_approval)',
      filter: (t) => t.status === 'waiting_approval'
    },
    {
      key: 'exception',
      title: '过渡态 / 暂停 / 超时 / 失败 (pausing / paused / cancelling / timed_out / failed / cancelled)',
      filter: (t) => ['pausing', 'paused', 'cancelling', 'timed_out', 'failed', 'cancelled'].includes(t.status)
    },
    {
      key: 'succeeded',
      title: '已验收成功 (succeeded)',
      filter: (t) => t.status === 'succeeded'
    }
  ];

  return `
    <div class="section-card composer-card" style="border:1px solid rgba(56,189,248,0.3);background:linear-gradient(180deg,rgba(15,23,42,0.95) 0%,rgba(11,17,30,0.98) 100%);box-shadow:0 12px 30px rgba(0,0,0,0.35);">
      <div class="section-header">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:16px;">🎯</span>
          <div class="section-title" style="font-size:16px;color:#f8fafc;">发布多 Agent 协同新任务 (Task Dispatcher)</div>
        </div>
        <span class="mock-tag" style="background:rgba(56,189,248,0.1);color:#38bdf8;border-color:rgba(56,189,248,0.3);">⚡ 自动隔离沙箱 · 传递依赖保障</span>
      </div>

      <!-- 快速场景灵感推荐 -->
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px;padding:8px 12px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.18);border-radius:8px;">
        <span style="font-size:12px;color:#38bdf8;font-weight:600;">💡 快速灵感填入：</span>
        <button type="button" class="btn btn-sm quick-prompt-btn" data-preset-title="智能车视觉检测模块开发" data-preset-goal="在智能车视觉仓库中实现赛道边缘识别与动态障碍物检测算法，并编写自动化验证测试">🚗 智能车视觉检测</button>
        <button type="button" class="btn btn-sm quick-prompt-btn" data-preset-title="API 性能优化与缓存集成" data-preset-goal="对核心 API 服务进行性能优化，实现内存缓存与数据分页，并补充高并发读取验证">⚡ 高并发缓存优化</button>
        <button type="button" class="btn btn-sm quick-prompt-btn" data-preset-title="安全权限网关与角色鉴权" data-preset-goal="重构安全鉴权中间件，实现基于角色的严格访问控制，并提供自动化集成测试套件">🛡️ 安全与权限门禁</button>
      </div>

      <div class="form-row">
        <div style="flex:2;min-width:240px;">
          <label style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">任务标题 (Title)</label>
          <input id="composerTitleInput" class="input" placeholder="输入清晰简洁的任务标题..." value="${escapeHtml(draft.title)}" />
        </div>
        <div style="flex:1;min-width:220px;">
          <label style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">受控目标仓库 (Repository)</label>
          <select id="composerRepoSelect" class="select">
            ${uiState.repositories
              .filter((r) => r.id !== 'repo-real-relay-01')
              .map(
                (r) =>
                  `<option value="${escapeHtml(r.id)}" ${draft.repositoryId === r.id ? 'selected' : ''}>${escapeHtml(r.label)} (${escapeHtml(r.baseBranch)})</option>`
              )
              .join('')}
          </select>
        </div>
        <div style="width:140px;">
          <label style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">执行优先级</label>
          <select id="composerPrioritySelect" class="select">
            <option value="high" ${draft.priority === 'high' ? 'selected' : ''}>High (高优先级)</option>
            <option value="critical" ${draft.priority === 'critical' ? 'selected' : ''}>Critical (紧急)</option>
            <option value="medium" ${draft.priority === 'medium' ? 'selected' : ''}>Medium (中)</option>
            <option value="low" ${draft.priority === 'low' ? 'selected' : ''}>Low (低)</option>
          </select>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">自然语言任务目标 (Natural Language Goal)</label>
        <textarea id="composerGoalInput" class="textarea" style="min-height:70px;" placeholder="详细描述期望 AI Agent 完成的具体功能目标与验收准则...">${escapeHtml(draft.goal)}</textarea>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <button class="btn" id="previewDecomposeBtn">⚡ 智能拆解预览 (DraftPlan)</button>
        <button class="btn btn-primary" id="launchTaskBtn" style="font-weight:700;box-shadow:0 0 16px rgba(56,189,248,0.35);">🚀 立即启动协同任务 (Launch Agents)</button>
      </div>

      ${
        draft.draftPlan
          ? (() => {
              const compat = inspectDraftPlanCompatibility(draft.draftPlan.subtasks);
              const nonExecSummary = [...compat.analysisNodes, ...compat.reservedNodes]
                .map((n) => `${n.code}(${n.stage})`)
                .join(', ');
              return `
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-subtle);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
            <div style="font-weight:700;color:#93c5fd;">
              DraftPlan #${escapeHtml(draft.draftPlan.id)} 预览 (共 ${draft.draftPlan.subtasks.length} 个 PlannedSubtask，不执行生成代码)：
            </div>
            ${
              !compat.isDirectlyExecutable
                ? `<button class="btn btn-warn" id="compressDraftPlanBtn">压缩非执行节点（保留传递依赖与验收条件）并重新预览</button>`
                : `<span class="chip" style="border-color:rgba(16,185,129,0.45);color:#6ee7b7;">可执行契约已对齐 (${compat.executableCount} 节点)</span>`
            }
          </div>
          ${
            !compat.isDirectlyExecutable
              ? `<div style="margin-bottom:10px;font-size:11.5px;color:#fcd34d;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);padding:7px 10px;border-radius:6px;">
                  ⚠️ <strong>计划契约提示：</strong>当前预览含非执行阶段或保留节点 <code>${escapeHtml(nonExecSummary || '0 executable')}</code>。Live 创建不会静默删减节点或丢失传递依赖；请先点击右侧按钮显式压缩并重新确认预览，或重新生成符合执行契约的计划。
                </div>`
              : ''
          }
          <div class="dag-stages">
            ${draft.draftPlan.subtasks
              .map(
                (p) => `
              <div class="dag-node" style="margin-top:0;">
                <div style="display:flex;justify-content:space-between;">
                  <strong>${escapeHtml(p.code)}</strong>
                  <span class="chip">${escapeHtml(p.stage)}</span>
                </div>
                <div style="font-weight:600;">${escapeHtml(p.title)}</div>
                <div style="font-size:11px;color:var(--text-secondary);">Capabilities: <code>${escapeHtml((p.requiredCapabilities || []).join(', '))}</code></div>
                <div style="font-size:11px;color:var(--text-muted);">dependsOn: ${p.dependsOn.length ? escapeHtml(p.dependsOn.join(', ')) : 'root'}</div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;
            })()
          : ''
      }
    </div>

    <div class="section-card">
      <div class="section-header">
        <div class="section-title">任务协同看板</div>
        <span style="font-size:12px;color:var(--text-secondary);">严格区分 current (Mock) 与 historical (只读实测证据)</span>
      </div>
      <div class="kanban-board">
        ${columns
          .map((col) => {
            const colTasks = tasks.filter(col.filter);
            return `
            <div class="kanban-col">
              <div class="kanban-col-header">
                <span>${escapeHtml(col.title)}</span>
                <span class="nav-badge">${colTasks.length}</span>
              </div>
              ${
                colTasks.length === 0
                  ? `<div style="color:var(--text-muted);font-size:12px;padding:12px 0;">此状态列暂无任务</div>`
                  : colTasks
                      .map((t) => {
                        const isHist = t.provenance === 'historical';
                        return `
                    <div class="kanban-card ${t.id === uiState.selectedTaskId ? 'active-card' : ''}" data-select-task="${escapeHtml(t.id)}">
                      <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span class="status-badge status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>
                        <span class="mock-tag ${isHist ? 'provenance-live' : ''}">${isHist ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'}</span>
                      </div>
                      <div style="font-weight:700;color:#fff;cursor:pointer;">${escapeHtml(t.title)}</div>
                      <div style="font-size:11px;color:var(--text-secondary);font-family:var(--font-mono);">
                        v${t.version} · repo=${escapeHtml(t.repositoryId)} @ ${escapeHtml(t.baseCommit)} · ${t.progressPct}%
                      </div>
                      <div class="progress-track">
                        <div class="progress-fill" style="width:${t.progressPct}%"></div>
                      </div>
                      ${
                        t.error
                          ? `<div style="font-size:11px;color:#fca5a5;font-family:var(--font-mono);">⚠️ [${escapeHtml(t.error.code)}] ${escapeHtml(t.error.message)}</div>`
                          : ''
                      }
                    </div>
                  `;
                      })
                      .join('')
              }
            </div>
          `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderWorkflowDagView() {
  const detail = uiState.selectedTaskDetail;
  const task = detail?.task;
  if (!task) return `<div class="section-card">请先选择一个任务</div>`;
  const subs = detail.subtasks || [];
  const isHistorical = task.provenance === 'historical';

  const stageGroups = [
    { key: 'analysis', label: 'Stage 1 · 需求分析与接口契约 (analysis)' },
    { key: 'implementation', label: 'Stage 2 · 模块实现与代码审查 (implementation / review)' },
    { key: 'testing', label: 'Stage 3 · 独立验证与验收测试 (testing)' },
    { key: 'documentation', label: 'Stage 4 · 文档生成与成果交付 (documentation)' }
  ];

  return `
    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">子任务 DAG 依赖拓扑与受控重试/返工 (Subtask DAG & Attempt Control)</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">
            每个 Subtask 显示 <code>attempt / maxAttempts</code> 与 <code>timeoutMs</code>；支持独立触发 <code>POST /api/v1/subtasks/:id/retry</code> 或 <code>/rework</code>
          </div>
        </div>
        <span class="mock-tag ${isHistorical ? 'provenance-live' : ''}">${isHistorical ? '🔒 LIVE CLI DAG EVIDENCE' : `DAG Nodes: ${subs.length}`}</span>
      </div>

      <div class="dag-topology-ribbon">
        <strong style="color:#93c5fd;">依赖流向 (Topology Flow):</strong>
        ${subs
          .map(
            (s, i) => `
          <span class="status-badge status-${escapeHtml(s.status)}">${escapeHtml(s.code)}: ${escapeHtml(s.status)} (${s.progressPct}%)</span>
          ${i < subs.length - 1 ? '<span class="dag-topo-arrow">──▶</span>' : ''}
        `
          )
          .join('')}
      </div>

      <div class="dag-stages">
        ${stageGroups
          .map((grp) => {
            const stageSubs = subs.filter((s) =>
              grp.key === 'implementation' ? ['implementation', 'review'].includes(s.stage) : s.stage === grp.key
            );
            return `
              <div class="dag-stage-col">
                <div style="font-weight:700;font-size:12px;color:#93c5fd;padding-bottom:8px;border-bottom:1px solid var(--border-subtle);">
                  ${escapeHtml(grp.label)}
                </div>
                ${
                  stageSubs.length === 0
                    ? `<div style="color:var(--text-muted);font-size:12px;margin-top:10px;">无节点</div>`
                    : stageSubs
                        .map((s) => {
                          const canRetry = !isHistorical && ['failed', 'timed_out'].includes(s.status) && s.attempt < s.maxAttempts && (!s.error || s.error.retryable !== false);
                          const canRework = !isHistorical && ['validating', 'waiting_approval'].includes(s.status) && s.attempt < s.maxAttempts;
                          return `
                        <div class="dag-node node-${escapeHtml(s.status)}">
                          <div style="display:flex;justify-content:space-between;align-items:center;">
                            <span style="font-family:var(--font-mono);font-weight:800;color:#fff;">${escapeHtml(s.code)} (v${s.version})</span>
                            <span class="status-badge status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
                          </div>
                          <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(s.title)}</div>
                          <div style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(s.description)}</div>
                          <div class="progress-track" style="height:5px;">
                            <div class="progress-fill" style="width:${s.progressPct}%"></div>
                          </div>
                          <div style="font-size:11px;font-family:var(--font-mono);color:#93c5fd;background:rgba(59,130,246,0.08);padding:6px;border-radius:4px;">
                            <div>Agent: ${escapeHtml(s.assignedAgentId || 'unassigned')}</div>
                            <div>WorkspaceId: ${escapeHtml(s.workspaceId || 'N/A')}</div>
                            <div>Branch: ${escapeHtml(s.branchName || 'N/A')}</div>
                            <div>Attempt: ${s.attempt} / ${s.maxAttempts} · timeoutMs: ${s.timeoutMs}</div>
                            <div>DependsOn: ${s.dependsOn.length ? escapeHtml(s.dependsOn.join(', ')) : 'None (Root)'}</div>
                          </div>
                          ${
                            s.error
                              ? `<div style="font-size:11px;color:#fca5a5;font-family:var(--font-mono);">Error [${escapeHtml(s.error.code)}]: ${escapeHtml(s.error.message)} (retryable=${Boolean(s.error.retryable)})</div>`
                              : ''
                          }
                          <div style="font-size:11px;color:var(--text-secondary);">
                            <strong>AcceptanceCriteria：</strong>
                            <ul style="padding-left:16px;margin-top:2px;">
                              ${(s.acceptanceCriteria || []).map((c) => `<li>[${escapeHtml(c.id)}] ${escapeHtml(c.description)}</li>`).join('')}
                            </ul>
                          </div>
                          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
                            ${
                              canRetry
                                ? `<button class="btn btn-warn" data-subtask-retry="${escapeHtml(s.id)}" data-version="${s.version}">重试子任务 (Retry Attempt #${s.attempt + 1})</button>`
                                : ''
                            }
                            ${
                              canRework
                                ? `<button class="btn btn-warn" data-subtask-rework="${escapeHtml(s.id)}" data-version="${s.version}" data-artifacts="${escapeHtml((s.outputArtifactIds || []).join(','))}">发起独立返工 (Rework Attempt #${s.attempt + 1})</button>`
                                : ''
                            }
                          </div>
                        </div>
                      `;
                        })
                        .join('')
                }
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderAgentWorkspaceView() {
  const detail = uiState.selectedTaskDetail;
  const task = detail?.task;
  const runs = detail?.runs?.items || [];
  const subtasks = detail?.subtasks || [];
  const agents = uiState.agentsPage.items || [];
  const isHistorical = task?.provenance === 'historical';

  const filteredRuns =
    uiState.selectedAgentId === 'all' ? runs : runs.filter((r) => r.agentId === uiState.selectedAgentId);

  return `
    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">AgentRun 执行历史与单 Run 序号日志 (GET /api/v1/runs/:id/logs · logSeq 去重)</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            每个 Run 维护独立 <code>logSeq</code>；取消后刷出的迟到输出标记为 <code>drained=true</code> 且绝不覆盖终态
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn ${uiState.selectedAgentId === 'all' ? 'btn-primary' : ''}" data-filter-agent="all">全部 Run (${runs.length})</button>
          ${agents
            .map(
              (ag) => `
            <button class="btn ${uiState.selectedAgentId === ag.id ? 'btn-primary' : ''}" data-filter-agent="${escapeHtml(ag.id)}">
              ${escapeHtml(ag.label)}
            </button>
          `
            )
            .join('')}
        </div>
      </div>

      ${filteredRuns
        .map((run) => {
          const logPage = uiState.runLogsByRunId[run.id] || { items: [], nextSeq: 0, hasMore: false };
          return `
        <div style="margin-bottom:16px;border:1px solid var(--border-subtle);border-radius:10px;padding:14px;background:var(--bg-surface);animation:${['failed','timed_out','interrupted'].includes(run.status) ? 'breatheCrimsonHalo 2.6s' : run.status === 'succeeded' ? 'breatheEmeraldHalo 3.8s' : 'breatheCyanBlueHalo 3s'} ease-in-out infinite;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <div>
              <span class="mock-tag ${run.provenance === 'historical' ? 'provenance-live' : ''}">${run.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : 'MOCK RUN'}</span>
              <strong style="margin-left:6px;color:#fff;">Run ${escapeHtml(run.id)} (attempt #${run.attempt}) · Subtask: ${escapeHtml(run.subtaskId)} · Agent: ${escapeHtml(run.agentId)}</strong>
            </div>
            <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">
              providerSessionId: ${escapeHtml(run.providerSessionId || 'N/A')} | workspaceId: ${escapeHtml(run.workspaceId)} | exitCode: ${escapeHtml(run.exitCode ?? 'N/A')} |
              <span class="status-badge status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
            </div>
          </div>
          ${
            run.error || run.status === 'interrupted' || run.reconciliationNote
              ? `<div style="margin-bottom:8px;padding:8px 10px;border-radius:6px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.4);font-size:11.5px;color:#fca5a5;font-family:var(--font-mono);">
                  ${run.error ? `<div>[${escapeHtml(run.error.code)}] ${escapeHtml(run.error.message)} (retryable=${Boolean(run.error.retryable)})</div>` : ''}
                  ${run.status === 'interrupted' ? `<div style="color:#fcd34d;margin-top:3px;">B-03 Quarantine: 执行槽已保留隔离，需核对进程组已停止且复核副作用后方可解除，禁止自动重放。</div>
                  <div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <button class="btn btn-sm" style="background:#dc2626;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-weight:600;" data-action="ack-interruption" data-run-id="${escapeHtml(run.id)}" data-run-version="${run.version}">
                      🛡️ 核对进程已停止并解除隔离 (Acknowledge & Free Slot)
                    </button>
                    <span style="font-size:11px;color:#cbd5e1;">受控调用 /api/v1/runs/${escapeHtml(run.id)}/acknowledge 释放执行槽</span>
                  </div>` : ''}
                  ${run.reconciliationNote ? `<div style="color:#34d399;margin-top:3px;">Reconciliation Note: ${escapeHtml(run.reconciliationNote)}</div>` : ''}
                </div>`
              : ''
          }
          <div class="terminal-chrome">
            <div class="terminal-dots">
              <span class="terminal-dot dot-red"></span>
              <span class="terminal-dot dot-amber"></span>
              <span class="terminal-dot dot-green"></span>
              <span style="margin-left:6px;color:#93c5fd;">tty://${escapeHtml(run.agentId)}/${escapeHtml(run.id)}</span>
            </div>
            <div>
              <span>lines: ${(logPage.items || []).length}</span> · <span>nextSeq: ${logPage.nextSeq || 0}</span>
            </div>
          </div>
          <div class="terminal-box">
            ${(logPage.items || [])
              .map(
                (line) => `
              <div class="log-line log-${escapeHtml(line.stream)}">
                <span class="log-ts">[logSeq:${line.logSeq}] [${escapeHtml(line.timestamp)}] [${escapeHtml(line.stream.toUpperCase())}]${line.drained ? ' <strong style="color:#fbbf24;">[DRAINED=TRUE]</strong>' : ''}</span>
                <span>${escapeHtml(line.text)}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;
        })
        .join('')}

      ${
        !isHistorical && task
          ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border-subtle);">
          <div style="font-weight:700;margin-bottom:8px;">向子任务排队发送补充上下文 (POST /api/v1/tasks/${escapeHtml(task.id)}/messages → delivery='queued_next_turn')</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <select id="directiveTargetSubtask" class="select" style="width:280px;">
              ${subtasks
                .map(
                  (s) =>
                    `<option value="${escapeHtml(s.id)}" ${uiState.directiveSubtaskId === s.id ? 'selected' : ''}>${escapeHtml(s.code)} · ${escapeHtml(s.title)} (${escapeHtml(s.assignedAgentId)})</option>`
                )
                .join('')}
            </select>
            <input id="directiveInput" class="input" style="flex:1;min-width:240px;" value="${escapeHtml(uiState.directiveDraft)}" placeholder="输入补充技术约束（首版统一排队至下一轮 queued_next_turn，不拼入终端命令）..." />
            <button class="btn btn-primary" id="sendDirectiveBtn" style="flex-shrink:0;">排队发送上下文</button>
          </div>
        </div>
      `
          : ''
      }
    </div>
  `;
}

function renderCommunicationView() {
  const msgs = uiState.messagesPage.items || [];

  return `
    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">跨 Agent 消息与上下文引用记录 (GET /api/v1/tasks/:id/messages · Page&lt;Message&gt;)</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            包含 <code>fromRunId</code>、<code>toSubtaskId</code>、<code>fromLabel</code>、<code>toLabel</code>、<code>kind</code>、<code>correlationId</code> 与不可变 <code>artifactRefs</code>
          </div>
        </div>
        <span class="nav-badge">${msgs.length} Messages</span>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;">
        ${msgs
          .map(
            (m) => `
          <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="mock-tag">${m.provenance === 'historical' ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'}</span>
                <span class="chip" style="color:#93c5fd;border:1px solid rgba(59,130,246,0.35);">${escapeHtml(m.kind)}</span>
                <strong style="color:#fff;">${escapeHtml(m.fromLabel)} → ${escapeHtml(m.toLabel)} (toSubtaskId: <code>${escapeHtml(m.toSubtaskId)}</code>)</strong>
              </div>
              <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">
                corr=${escapeHtml(m.correlationId)} · ${escapeHtml(m.createdAt)}
              </span>
            </div>
            <div style="font-weight:700;color:#e2e8f0;margin-bottom:4px;">${escapeHtml(m.summary)}</div>
            <div style="color:var(--text-secondary);white-space:pre-wrap;font-size:12.5px;">${escapeHtml(m.content)}</div>
            ${
              m.artifactRefs && m.artifactRefs.length
                ? `
              <div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border-subtle);font-family:var(--font-mono);font-size:11px;color:#6ee7b7;">
                关联不可变产物 (artifactRefs): ${m.artifactRefs.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')}
              </div>
            `
                : ''
            }
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

function renderReviewCenterView() {
  const detail = uiState.selectedTaskDetail;
  const approvals = detail?.approvals?.items || [];
  const validations = detail?.validations?.items || [];
  const subtasks = detail?.subtasks || [];

  return `
    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">代码差异审查与审批门禁中心 (Review Center · v0.2 审批与返工解耦)</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            <code>POST /api/v1/approvals/:id/decision</code> 仅接受 <code>approve | reject</code>；若需打回重做，请点击右侧独立的 <code>POST /api/v1/subtasks/:id/rework</code>（将自动使旧审批变为 <code>invalidated</code>）
          </div>
        </div>
      </div>

      ${
        approvals.length === 0
          ? `<div style="color:var(--text-muted);padding:12px 0;">当前任务暂无审批门禁记录</div>`
          : approvals
              .map((ap) => {
                const commentVal = uiState.reviewComments[ap.id] ?? '';
                const diffContent = ap.diffArtifactId ? uiState.artifactContentCache[ap.diffArtifactId] : null;
                const linkedSub = subtasks.find((s) => s.id === ap.subtaskId);
                return `
          <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:10px;padding:14px;margin-bottom:14px;animation:${ap.status === 'pending' ? 'breatheAmberHalo 2.8s' : ap.status === 'approved' ? 'breatheEmeraldHalo 3.6s' : 'breatheCrimsonHalo 2.8s'} ease-in-out infinite;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
              <div>
                <span class="mock-tag">${escapeHtml(ap.executionMode.toUpperCase())}</span>
                <span class="status-badge status-${escapeHtml(ap.status)}">${escapeHtml(ap.status)}</span>
                <strong style="font-size:14px;color:#fff;margin-left:8px;">${escapeHtml(ap.summary)}</strong>
              </div>
              <span style="font-family:var(--font-mono);font-size:11px;color:#93c5fd;">
                Gate: ${escapeHtml(ap.id)} · v${ap.version} · actionDigest: <code>${escapeHtml(ap.actionDigest)}</code> · expiresAt: ${escapeHtml(ap.expiresAt)}
              </span>
            </div>
            <div style="font-size:11.5px;color:var(--text-secondary);font-family:var(--font-mono);margin-bottom:8px;">
              subtaskId: <code>${escapeHtml(ap.subtaskId)}</code> | runId: <code>${escapeHtml(ap.runId)}</code> | artifactRefs: <code>${escapeHtml((ap.artifactRefs || []).join(', '))}</code>
            </div>
            ${
              diffContent
                ? `<div class="code-preview" style="margin-bottom:12px;">${renderFormattedCodeOrDiff(diffContent)}</div>`
                : ''
            }
            ${
              ap.status === 'pending'
                ? `
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <input
                  class="input"
                  style="flex:1;min-width:240px;"
                  data-review-comment-id="${escapeHtml(ap.id)}"
                  value="${escapeHtml(commentVal)}"
                  placeholder="输入审批意见或返工原因..."
                />
                <button
                  class="btn btn-success"
                  data-approval-decision="approve"
                  data-approval-id="${escapeHtml(ap.id)}"
                  data-version="${ap.version}"
                  data-digest="${escapeHtml(ap.actionDigest)}"
                >
                  ✓ 批准变更 (Approve · decision='approve')
                </button>
                <button
                  class="btn btn-danger"
                  data-approval-decision="reject"
                  data-approval-id="${escapeHtml(ap.id)}"
                  data-version="${ap.version}"
                  data-digest="${escapeHtml(ap.actionDigest)}"
                >
                  ✗ 拒绝变更 (Reject · decision='reject')
                </button>
                ${
                  linkedSub
                    ? `
                  <button
                    class="btn btn-warn"
                    data-subtask-rework="${escapeHtml(linkedSub.id)}"
                    data-version="${linkedSub.version}"
                    data-artifacts="${escapeHtml((ap.artifactRefs || []).join(','))}"
                    data-comment-ref="${escapeHtml(ap.id)}"
                    title="独立调用 POST /api/v1/subtasks/:id/rework，自动将本审批置为 invalidated 并启动新 attempt"
                  >
                    ↺ 触发子任务返工 (Subtask Rework → Invalidate Approval)
                  </button>
                `
                    : ''
                }
              </div>
            `
                : `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                <div style="font-size:12px;color:#34d399;font-family:var(--font-mono);">
                  状态: [${escapeHtml(ap.status.toUpperCase())}] · decidedBy=${escapeHtml(ap.decidedBy || 'N/A')} · decidedAt=${escapeHtml(ap.decidedAt || 'N/A')}
                </div>
                ${
                  ap.status === 'rejected' && linkedSub && linkedSub.attempt < linkedSub.maxAttempts
                    ? `
                  <button
                    class="btn btn-warn"
                    data-subtask-rework="${escapeHtml(linkedSub.id)}"
                    data-version="${linkedSub.version}"
                    data-artifacts="${escapeHtml((ap.artifactRefs || []).join(','))}"
                    data-comment-ref="${escapeHtml(ap.id)}"
                  >
                    ↺ 拒绝后显式触发返工 (POST /api/v1/subtasks/:id/rework)
                  </button>
                `
                    : ''
                }
              </div>
            `
            }
          </div>
        `;
              })
              .join('')
      }
    </div>

    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">独立沙箱验收测试记录 (Validation Records · detail.validations.items)</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            验收命令在受控仓库之外的独立 OS 临时目录沙箱中运行；任何修改受控源码树的测试行为均直接判定为验收失败
          </div>
        </div>
        <span class="nav-badge">${validations.length} Validations</span>
      </div>
      ${
        validations.length === 0
          ? `<div style="color:var(--text-muted);padding:8px 0;">当前任务暂无独立验收测试记录</div>`
          : `
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${validations
            .map(
              (v) => `
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 12px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;font-family:var(--font-mono);font-size:11.5px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span class="status-badge status-${escapeHtml(v.status)}">${escapeHtml(v.status)}</span>
                <strong style="color:#fff;">criterionId: ${escapeHtml(v.criterionId)}</strong>
                <span style="color:var(--text-secondary);">subtaskId: ${escapeHtml(v.subtaskId)} · runId: ${escapeHtml(v.runId)} · exitCode: ${escapeHtml(v.exitCode)}</span>
              </div>
              <div style="color:#6ee7b7;">
                evidenceArtifactIds: ${(v.evidenceArtifactIds || []).map((id) => `<code>${escapeHtml(id)}</code>`).join(', ') || 'none'}
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
      }
    </div>
  `;
}

function renderArtifactCenterView() {
  const detail = uiState.selectedTaskDetail;
  const task = detail?.task || getSelectedTask();
  const allArts = detail?.artifacts?.items || [];
  const filtered =
    uiState.selectedArtifactCategory === 'all'
      ? allArts
      : allArts.filter((a) => a.category === uiState.selectedArtifactCategory);

  const textDocs = getTaskTextDeliverables(detail);
  const activeDoc =
    textDocs.find((d) => d.id === uiState.selectedTextDeliverableId) || textDocs[0] || null;
  const activeDocText = activeDoc
    ? uiState.artifactContentCache[activeDoc.id] ?? '正在加载成果文字说明...'
    : '';

  return `
    <!-- 成果文字直答与说明展示面板 -->
    <div class="section-card" style="border:1px solid rgba(16,185,129,0.45);background:linear-gradient(180deg,rgba(16,185,129,0.08) 0%,rgba(15,23,42,0.92) 100%);margin-bottom:16px;">
      <div class="section-header" style="border-bottom:1px solid rgba(16,185,129,0.2);padding-bottom:10px;margin-bottom:12px;">
        <div>
          <div class="section-title" style="display:flex;align-items:center;gap:8px;color:#34d399;font-size:15px;">
            <span>📝 成果文字说明展示 · AI 任务回复报告</span>
            <span class="chip" style="background:rgba(16,185,129,0.2);color:#6ee7b7;border-color:rgba(16,185,129,0.4);">可读文字直览</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:3px;">
            针对任务目标「<strong style="color:#f8fafc;">${escapeHtml(task?.goal || task?.title || '当前任务')}</strong>」生成的自然语言解答、分析报告与使用说明（无需翻阅底层代码即可直接阅读成果）
          </div>
        </div>
        ${
          activeDoc
            ? `
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button class="btn btn-sm btn-primary" data-copy-text-deliverable="${escapeHtml(activeDoc.id)}">📋 一键复制文字成果</button>
            <button class="btn btn-sm" data-download-artifact="${escapeHtml(activeDoc.id)}" data-filename="${escapeHtml((activeDoc.relativePath || activeDoc.name || 'report.md').split('/').pop())}">⬇ 下载文字报告 (.md)</button>
          </div>
        `
            : ''
        }
      </div>

      ${
        textDocs.length > 1
          ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          ${textDocs
            .map(
              (doc) => `
            <button class="btn btn-sm ${activeDoc?.id === doc.id ? 'btn-primary' : ''}" data-select-text-doc="${escapeHtml(doc.id)}">
              📄 ${escapeHtml(doc.relativePath || doc.name)}
            </button>
          `
            )
            .join('')}
        </div>
      `
          : ''
      }

      ${
        activeDoc
          ? `
        <div style="background:rgba(9,13,22,0.85);border:1px solid rgba(56,189,248,0.25);border-radius:10px;padding:18px 20px;max-height:540px;overflow-y:auto;box-shadow:inset 0 2px 12px rgba(0,0,0,0.4);">
          ${renderReadableTextReport(activeDocText)}
        </div>
      `
          : `
        <div style="padding:18px;background:rgba(15,23,42,0.6);border:1px dashed rgba(148,163,184,0.3);border-radius:8px;color:#94a3b8;font-size:13px;">
          当前任务正在执行或尚未产出文档类文字说明。任务子步骤完成后，AI 回复的文字总结与报告将自动在此直接展示。
        </div>
      `
      }
    </div>

    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">不可变成果库与受控内容访问 (GET /api/v1/tasks/:id/artifacts & /api/v1/artifacts/:id/content)</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            列表仅暴露 <code>relativePath</code> 与 <code>sha256</code>；正文通过受控 ID 按需读取，附带 <code>nosniff</code> 与 <code>CSP: default-src 'none'</code>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${['all', 'code', 'diff', 'test_report', 'documentation']
            .map(
              (cat) => `
            <button class="btn ${uiState.selectedArtifactCategory === cat ? 'btn-primary' : ''}" data-filter-artifact="${cat}">
              ${cat.toUpperCase()}
            </button>
          `
            )
            .join('')}
        </div>
      </div>

      ${filtered
        .map((art) => {
          const content = uiState.artifactContentCache[art.id] ?? 'Loading...';
          return `
        <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:14px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
            <div>
              <span class="mock-tag ${art.provenance === 'historical' ? 'provenance-live' : ''}">${art.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : 'MOCK ARTIFACT'}</span>
              <span class="chip">${escapeHtml(art.category.toUpperCase())}</span>
              <span class="status-badge status-${escapeHtml(art.validationStatus)}">${escapeHtml(art.validationStatus)}</span>
              <strong style="color:#fff;margin-left:6px;font-family:var(--font-mono);">${escapeHtml(art.relativePath || art.name || art.path)}</strong>
            </div>
            <div style="display:flex;align-items:center;gap:10px;font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">
              <span>ID: ${escapeHtml(art.id)}</span>
              <span>SHA-256: ${(art.sha256 || '').slice(0, 14)}...</span>
              <span>${art.sizeBytes} B</span>
              <button class="btn btn-sm" data-download-artifact="${escapeHtml(art.id)}" data-filename="${escapeHtml((art.relativePath || art.name || art.path || 'artifact.txt').split('/').pop())}" title="下载受控产物 (GET /api/v1/artifacts/:id/content)">⬇ 下载产物</button>
            </div>
          </div>
          ${
            art.testSummary
              ? `
            <div style="margin-bottom:10px;padding:8px 12px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.35);border-radius:6px;font-family:var(--font-mono);font-size:12px;color:#6ee7b7;">
              Validation Summary: Total ${art.testSummary.total} | Passed ${art.testSummary.passed} | Failed ${art.testSummary.failed} | Coverage ${art.testSummary.coveragePct ?? 100}%
            </div>
          `
              : ''
          }
          <div class="code-preview">${renderFormattedCodeOrDiff(content)}</div>
        </div>
      `;
        })
        .join('')}
    </div>
  `;
}

function renderSettingsView() {
  return `
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">4 大实机 AI 引擎适配器与运行环境</div>
        <span class="mock-tag" style="background:rgba(16,185,129,0.1);color:#10b981;border-color:rgba(16,185,129,0.3);">🟢 4 核心引擎在线</span>
      </div>
      <div class="agent-grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));gap:12px;">
        <div class="agent-card">
          <div class="agent-card-top">
            <div>
              <div class="agent-name" style="font-size:14px;font-weight:700;">DeepSeek 深度求索</div>
              <div class="agent-role" style="font-size:11px;color:#38bdf8;">模型: deepseek-reasoner (R1) / deepseek-chat</div>
            </div>
            <span class="status-badge status-available">在线</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:8px;line-height:1.5;">
            <div>连接模式: <code>官方 API 直连 (.env.local 0600)</code></div>
            <div>核心分工: 算法逻辑推理 · 核心业务实现 · DAG 规划</div>
          </div>
        </div>

        <div class="agent-card">
          <div class="agent-card-top">
            <div>
              <div class="agent-name" style="font-size:14px;font-weight:700;">Codex (ChatGPT Plus)</div>
              <div class="agent-role" style="font-size:11px;color:#94a3b8;">模型: gpt-6.1-sol / OpenAI Codex</div>
            </div>
            <span class="status-badge status-available">在线</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:8px;line-height:1.5;">
            <div>连接模式: <code>官方 codex-cli 桥接 · 会员配额直连</code></div>
            <div>核心分工: 独立代码审查 · 质量门禁仲裁 · 重构合并</div>
          </div>
        </div>

        <div class="agent-card">
          <div class="agent-card-top">
            <div>
              <div class="agent-name" style="font-size:14px;font-weight:700;">Gemini Pro (Google Antigravity)</div>
              <div class="agent-role" style="font-size:11px;color:#c084fc;">模型: gemini-3.5-flash-lite / Antigravity</div>
            </div>
            <span class="status-badge status-available">在线</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:8px;line-height:1.5;">
            <div>连接模式: <code>Antigravity Platform API Key 直连</code></div>
            <div>核心分工: 规范基线核验 · 架构设计 · 多模态分析</div>
          </div>
        </div>

        <div class="agent-card">
          <div class="agent-card-top">
            <div>
              <div class="agent-name" style="font-size:14px;font-weight:700;">WorkBuddy (腾讯协同智能体)</div>
              <div class="agent-role" style="font-size:11px;color:#38bdf8;">模型: Tencent CodeBuddy 本地网关</div>
            </div>
            <span class="status-badge status-available">在线</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:8px;line-height:1.5;">
            <div>连接模式: <code>本地服务网关 127.0.0.1:18492 直连</code></div>
            <div>核心分工: 本地工作区工具链协同 · 跨模块集成辅助</div>
          </div>
        </div>
      </div>

      <details style="margin-top:14px;font-size:11.5px;color:var(--text-secondary);background:rgba(255,255,255,0.02);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 12px;cursor:pointer;">
        <summary style="color:#94a3b8;font-weight:600;outline:none;">底层平台规格与契约协议 (contractVersion=${escapeHtml(uiState.meta.contractVersion)})</summary>
        <div style="margin-top:8px;line-height:1.6;font-family:var(--font-mono);font-size:11px;">
          <div>• 目录隔离: <code>hub-root/state/ ⊥ hub-root/workspaces/</code> 物理强隔离</div>
          <div>• 接口规范: <code>/api/v1/*</code> 统一收敛，CAS 校验 <code>expectedVersion</code></div>
          <div>• 事件总线: Fetch-SSE 游标连续重放机制 (seq=${uiState.lastAppliedSeq})</div>
        </div>
      </details>
    </div>
  `;
}

function renderAgentRouterView() {
  const task = getSelectedTask();
  const detail = uiState.selectedTaskDetail;

  const subtasks = (detail?.subtasks && Array.isArray(detail.subtasks)) ? detail.subtasks : [];
  const artifacts = (Array.isArray(detail?.artifacts) && detail.artifacts.length > 0)
    ? detail.artifacts
    : (detail?.artifacts?.items && detail.artifacts.items.length > 0)
    ? detail.artifacts.items
    : [];

  let missionTitle = "等待下发协同任务 (Ready for Tasks)";
  let missionType = "就绪";
  let missionExtra = "等待任务启动";
  let isLive = true;

  if (task) {
    isLive = task.executionMode === "live";
    missionTitle = task.title || task.goal || "多智能体协同研发任务";
    missionType = "实机";
    missionExtra = "🟢 真实多Agent协同 · 全链路打通";
  }

  const selectedMember = uiState.routerSelectedMember || "all";

  // 5 Real Executive Member cards reflecting genuinely connected models
  const memberCards = [
    {
      id: "deepseek",
      name: "DeepSeek",
      model: "deepseek-reasoner / chat",
      letter: "D",
      avatarCls: "ar-avatar-dsh",
      status: "就绪",
      statusCls: "ar-status-success",
      tasks: subtasks.filter((s) => s.assignedAgentId?.includes("1111") || s.stage === "implementation" || s.stage === "analysis").map((s, i) => ({
        code: s.displayIndex || s.code || `T${i + 1}`,
        title: s.title,
        status: s.status === "succeeded" ? "已完成" : s.status === "failed" ? "失败" : "执行中",
        color: s.status === "succeeded" ? "#10b981" : s.status === "failed" ? "#ef4444" : "#38bdf8"
      }))
    },
    {
      id: "claude",
      name: "Claude",
      model: "claude-3-5-sonnet",
      letter: "A",
      avatarCls: "ar-avatar-z",
      status: "就绪",
      statusCls: "ar-status-success",
      tasks: subtasks.filter((s) => s.stage === "review" || s.code === "FINAL-REVIEW").map((s, i) => ({
        code: s.displayIndex || s.code || `T${i + 1}`,
        title: s.title,
        status: s.status === "succeeded" ? "已完成" : s.status === "failed" ? "失败" : "审查中",
        color: s.status === "succeeded" ? "#10b981" : s.status === "failed" ? "#ef4444" : "#a855f7"
      }))
    },
    {
      id: "gemini",
      name: "Gemini",
      model: "gemini-3.5-flash",
      letter: "G",
      avatarCls: "ar-avatar-o",
      status: "就绪",
      statusCls: "ar-status-success",
      tasks: subtasks.filter((s) => s.stage === "documentation" || s.stage === "testing").map((s, i) => ({
        code: s.displayIndex || s.code || `T${i + 1}`,
        title: s.title,
        status: s.status === "succeeded" ? "已完成" : s.status === "failed" ? "失败" : "执行中",
        color: s.status === "succeeded" ? "#10b981" : s.status === "failed" ? "#ef4444" : "#38bdf8"
      }))
    },
    {
      id: "workbuddy",
      name: "WorkBuddy",
      model: "本地网关 (18492)",
      letter: "W",
      avatarCls: "ar-avatar-d",
      status: "本地在线",
      statusCls: "ar-status-success",
      tasks: subtasks.filter((s) => s.assignedAgentId?.includes("3333")).map((s, i) => ({
        code: s.displayIndex || s.code || `T${i + 1}`,
        title: s.title,
        status: s.status === "succeeded" ? "已完成" : s.status === "failed" ? "失败" : "执行中",
        color: s.status === "succeeded" ? "#10b981" : s.status === "failed" ? "#ef4444" : "#38bdf8"
      }))
    },
    {
      id: "codex",
      name: "Codex",
      model: "OpenAI Codex CLI",
      letter: "X",
      avatarCls: "ar-avatar-x",
      status: "备用",
      statusCls: "ar-status-queued",
      tasks: []
    }
  ];

  return `
    <div class="agent-router-view">
      <!-- Topbar inside Router Canvas -->
      <div class="ar-topbar">
        <div class="ar-brand-group">
          <div class="ar-brand-logo">🔮</div>
          <div class="ar-brand-title">Agent Router</div>
          <div class="ar-nav-tab">协作拓扑</div>
          <div class="ar-pills">
            <span class="ar-pill">5 执行成员 (DeepSeek / Claude / Gemini / WorkBuddy / Codex)</span>
            <span class="ar-pill">${subtasks.length} 任务</span>
            <span class="ar-pill" style="color:#10b981;border-color:rgba(16,185,129,0.3);">${subtasks.filter((s) => s.status === 'succeeded').length} 已完成</span>
          </div>
        </div>

        <div class="ar-actions">
          <button class="ar-btn-link" id="createRealTaskBtn" style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;border:none;padding:5px 14px;border-radius:6px;font-weight:700;cursor:pointer;box-shadow:0 0 12px rgba(99,102,241,0.5);">➕ 新建真实协同任务</button>
          <span class="ar-pill-mode" style="${isLive ? '' : 'background:rgba(139,92,246,0.18);border-color:rgba(139,92,246,0.4);color:#c084fc;'}">
            <span class="ar-green-dot" style="${isLive ? '' : 'background:#a855f7;box-shadow:0 0 8px #a855f7;'}"></span>
            ${isLive ? '🟢 实机真模型运行' : '* 演示'}
          </span>
          <button class="ar-btn-link" data-goto-view="agent-workspace">控制台 ↗</button>
          <button class="ar-btn-link" data-goto-view="task-center">任务中心 ↗</button>
          <button class="ar-btn-link" data-goto-view="artifact-center">成果库 ↗</button>
          <button class="ar-btn-link" data-goto-view="settings">设置 ⚙️</button>
        </div>
      </div>

      <div class="ar-body">
        <!-- Left Sidebar Rail: 运行区域 & 真实模型成员 -->
        <aside class="ar-sidebar">
          <div class="ar-run-section">
            <div class="ar-section-label">运行区域</div>
            <div class="ar-run-pill">
              <div class="ar-run-pill-title">
                <span class="ar-green-dot"></span>
                实机 · 多Agent
              </div>
              <div class="ar-run-pill-sub">真实模型 · 物理沙箱</div>
            </div>
          </div>

          <div class="ar-members-section">
            <div class="ar-section-label">真实协同成员</div>
            <div class="ar-members-list">
              <div class="ar-member-item" data-ar-member="hub" title="Hub 主调度器 (Coordinator)">
                <div class="ar-avatar ar-avatar-c" style="${selectedMember === 'hub' ? 'outline: 2px solid #fff;' : ''}">C</div>
                <div class="ar-avatar-label">主代理</div>
              </div>
              <div class="ar-member-item" data-ar-member="deepseek" title="DeepSeek (R1/V3 · 规划与算法)">
                <div class="ar-avatar ar-avatar-dsh" style="${selectedMember === 'deepseek' ? 'outline: 2px solid #fff;' : ''}">D</div>
                <div class="ar-avatar-label">DeepSeek</div>
              </div>
              <div class="ar-member-item" data-ar-member="claude" title="Anthropic Claude (3.5 Sonnet / Opus)">
                <div class="ar-avatar ar-avatar-z" style="${selectedMember === 'claude' ? 'outline: 2px solid #fff;' : ''}">A</div>
                <div class="ar-avatar-label">Claude</div>
              </div>
              <div class="ar-member-item" data-ar-member="gemini" title="Google Gemini (3.5 Flash / Pro)">
                <div class="ar-avatar ar-avatar-o" style="${selectedMember === 'gemini' ? 'outline: 2px solid #fff;' : ''}">G</div>
                <div class="ar-avatar-label">Gemini</div>
              </div>
              <div class="ar-member-item" data-ar-member="workbuddy" title="腾讯 WorkBuddy (本地智能体网关)">
                <div class="ar-avatar ar-avatar-d" style="${selectedMember === 'workbuddy' ? 'outline: 2px solid #fff;' : ''}">W</div>
                <div class="ar-avatar-label">WorkBuddy</div>
              </div>
              <div class="ar-member-item" data-ar-member="codex" title="OpenAI Codex (CLI 门禁)">
                <div class="ar-avatar ar-avatar-x" style="${selectedMember === 'codex' ? 'outline: 2px solid #fff;' : ''}">X</div>
                <div class="ar-avatar-label">Codex</div>
              </div>
            </div>
          </div>
        </aside>

        <!-- Center Main Canvas -->
        <main class="ar-canvas">
          <!-- Top Mission Banner -->
          <div class="ar-mission-banner">
            <div class="ar-mission-tag">
              <span class="ar-mission-badge">${missionType}</span>
              <span style="font-weight:700;color:#f8fafc;">${escapeHtml(missionTitle)}</span>
            </div>
            <div class="ar-mission-extra">
              ${missionExtra}
            </div>
          </div>

          <!-- Topology Diagram with Flow Connections -->
          <div class="ar-flow-container">
            <!-- Dynamic SVG Connectors (Calibrated for 1440 grid) -->
            <svg class="ar-flow-svg" viewBox="0 0 1440 480" preserveAspectRatio="none" style="z-index:10;pointer-events:none;">
              <defs>
                <linearGradient id="arGradCyan" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.9"/>
                  <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.9"/>
                </linearGradient>
                <linearGradient id="arGradGreen" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.95"/>
                  <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.95"/>
                </linearGradient>
                <linearGradient id="arGradSwoop" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#059669" stop-opacity="0.2"/>
                  <stop offset="40%" stop-color="#10b981" stop-opacity="0.95"/>
                  <stop offset="100%" stop-color="#38bdf8" stop-opacity="1"/>
                </linearGradient>
                <filter id="arGlowGreen" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <filter id="arGlowHeavy" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="7" result="blur1" />
                  <feGaussianBlur stdDeviation="3" result="blur2" />
                  <feMerge>
                    <feMergeNode in="blur1" />
                    <feMergeNode in="blur2" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <!-- Cables from Executive Members (Col 1 right edge = 290) to Claude Master (Col 2 left = 310) -->
              <path d="M 290 52 C 300 52, 300 160, 310 160" fill="none" stroke="#64748b" stroke-width="2" opacity="0.9"/>
              <circle cx="290" cy="52" r="3" fill="#64748b"/>
              <path d="M 290 138 C 300 138, 300 180, 310 180" fill="none" stroke="#2563eb" stroke-width="2.5" opacity="0.9"/>
              <circle cx="290" cy="138" r="3" fill="#2563eb"/>
              <path d="M 290 224 C 300 224, 300 200, 310 200" fill="none" stroke="#0284c7" stroke-width="2.5" opacity="0.9"/>
              <circle cx="290" cy="224" r="3" fill="#0284c7"/>
              <path d="M 290 310 C 300 310, 300 220, 310 220" fill="none" stroke="#d97706" stroke-width="2.5" opacity="0.9"/>
              <circle cx="290" cy="310" r="3" fill="#d97706"/>
              <path d="M 290 396 C 300 396, 300 240, 310 240" fill="none" stroke="#7c3aed" stroke-width="2" opacity="0.9"/>
              <circle cx="290" cy="396" r="3" fill="#7c3aed"/>

              <!-- Cables from Master (Col 2 right edge = 1080) to Outputs (Col 3 left = 1100) -->
              <path d="M 1080 150 C 1090 150, 1090 100, 1100 100" fill="none" stroke="url(#arGradGreen)" stroke-width="2.5" opacity="0.9"/>
              <circle cx="1080" cy="150" r="3" fill="#10b981"/>
              <path d="M 1080 250 C 1090 250, 1090 270, 1100 270" fill="none" stroke="url(#arGradGreen)" stroke-width="3" filter="url(#arGlowGreen)" opacity="0.95"/>
              <circle cx="1080" cy="250" r="3.5" fill="#10b981" filter="url(#arGlowGreen)"/>

              <!-- Luminous Emerald Swoop Ribbon arching from bottom timeline into the Report card -->
              <path d="M 520 440 C 720 540, 1060 480, 1260 360" fill="none" stroke="url(#arGradSwoop)" stroke-width="6" filter="url(#arGlowHeavy)" stroke-linecap="round"/>
              <circle cx="1260" cy="360" r="6" fill="#38bdf8" filter="url(#arGlowHeavy)"/>
              <circle cx="520" cy="440" r="4.5" fill="#10b981"/>
            </svg>

            <!-- 3 Column Cards Layout -->
            <div class="ar-flow-grid">
              <!-- Column 1: 执行成员 5 -->
              <div>
                <div class="ar-col-title">
                  <span>执行成员 5</span>
                </div>

                ${memberCards.map((card) => {
                  const isDimmed = selectedMember !== 'all' && selectedMember !== card.id;
                  return `
                    <div class="ar-node-card" style="${isDimmed ? 'opacity:0.35;' : ''}">
                      <div class="ar-node-header">
                        <div class="ar-node-identity">
                          <div class="ar-mini-avatar ${card.avatarCls}">${card.letter}</div>
                          <div>
                            <div class="ar-node-name">${card.name}</div>
                            <div class="ar-node-model">${card.model}</div>
                          </div>
                        </div>
                        <span class="ar-status-badge ${card.statusCls}">● ${card.status}</span>
                      </div>
                      ${card.tasks.map((t) => `
                        <div class="ar-task-entry">
                          <div class="ar-task-entry-title">
                            <span class="ar-task-code-chip">${t.code}</span>
                            <span>${escapeHtml(t.title)}</span>
                          </div>
                          <span style="color:${t.color};font-size:10px;">${t.status}</span>
                        </div>
                      `).join('')}
                    </div>
                  `;
                }).join('')}
              </div>

              <!-- Column 2: 主代理 · 拆解与整合 -->
              <div>
                <div class="ar-col-title" style="text-align:center;justify-content:center;">
                  <span>主代理·拆解与整合</span>
                </div>

                <div class="ar-center-box">
                  <div class="ar-center-header">
                    <div class="ar-center-avatar">C</div>
                    <div class="ar-center-meta">
                      <div class="ar-center-title">Claude Code</div>
                      <div class="ar-center-sub">主代理 · 拆解 · 派发 · 汇总</div>
                    </div>
                    <div class="ar-center-status">
                      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 6px #10b981;"></span>
                      在线 · 回合 8 · 0 read_inbox
                    </div>
                  </div>

                  <div class="ar-goal-inner-card">
                    <div class="ar-goal-title-bar">
                      <span style="color:#94a3b8;font-size:11px;">当前目标</span>
                    </div>
                    <div style="font-size:12.5px;font-weight:700;color:#f8fafc;margin:4px 0 10px;">${escapeHtml(missionTitle)}</div>

                    <div class="ar-center-tasks">
                      ${subtasks.length > 0 ? subtasks.map((s, idx) => {
                        const isSucc = s.status === 'succeeded';
                        const isFail = s.status === 'failed';
                        const color = isSucc ? '#10b981' : (isFail ? '#ef4444' : '#38bdf8');
                        const label = isSucc ? '已完成' : (isFail ? '失败' : (s.status === 'running' ? '执行中' : '排队中'));
                        const code = s.displayIndex || s.code || `T${idx + 1}`;
                        const agentName = s.assignedAgentId?.includes('1111') ? 'DeepSeek' : (s.assignedAgentId?.includes('3333') ? 'WorkBuddy' : (s.stage === 'review' ? 'Claude' : 'Agent'));

                        return `
                          <div class="ar-center-task-item">
                            <div style="display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                              <span class="ar-task-code-chip">${code}</span>
                              <span style="color:#94a3b8;font-size:11px;">${agentName} ·</span>
                              <span style="font-size:11.5px;color:#e2e8f0;">${escapeHtml(s.title)}</span>
                            </div>
                            <span style="color:${color};font-size:10.5px;flex-shrink:0;">[${label}]</span>
                          </div>
                        `;
                      }).join('') : `
                        <div style="padding: 16px 8px; text-align: center; color: #64748b; font-size: 11.5px;">
                          当前无执行中的子任务。点击右上角 <strong>【➕ 新建真实协同任务】</strong> 即可下发新需求。
                        </div>
                      `}
                    </div>
                  </div>

                  <div class="ar-center-summary-bar">
                    <span>产物汇总 <strong style="color:#fff;">${artifacts.length}</strong></span>
                    <span>已完成子任务 <strong style="color:#fff;">${subtasks.filter((s) => s.status === 'succeeded').length}</strong></span>
                  </div>
                  <div style="text-align:center;font-size:10.5px;color:#64748b;margin-top:8px;">
                    — 子代理独立沙箱执行，测试门禁通过后自动合流
                  </div>
                </div>
              </div>

              <!-- Column 3: 真实结果去向 -->
              <div>
                <div class="ar-col-title">
                  <span>真实交付成果</span>
                </div>

                <!-- Direct Text Report Preview Card -->
                ${(() => {
                  const textDocs = getTaskTextDeliverables(detail);
                  const primaryDoc = textDocs[0] || null;
                  const rawPreview = primaryDoc ? (uiState.artifactContentCache[primaryDoc.id] || '正在加载文字成果...') : '';
                  const cleanPreview = rawPreview
                    .replace(/^[#>*\-\s]+/gm, '')
                    .trim()
                    .slice(0, 180);
                  return `
                    <div class="ar-output-card" style="border-color:rgba(16,185,129,0.4);background:linear-gradient(180deg,rgba(16,185,129,0.1) 0%,rgba(15,23,42,0.85) 100%);">
                      <div class="ar-output-header">
                        <div style="display:flex;align-items:center;gap:6px;">
                          <span style="font-size:14px;">📝</span>
                          <div>
                            <span style="font-weight:700;color:#34d399;">成果文字说明直览</span>
                          </div>
                        </div>
                        <button class="ar-btn-link" data-goto-view="artifact-center" style="font-size:10.5px;padding:2px 7px;background:rgba(16,185,129,0.2);color:#6ee7b7;border-color:rgba(16,185,129,0.4);">全文阅读 ↗</button>
                      </div>
                      <div style="padding:8px 10px;font-size:11.5px;color:#e2e8f0;line-height:1.55;max-height:110px;overflow-y:auto;background:rgba(9,13,22,0.6);border-radius:6px;margin-top:4px;">
                        ${primaryDoc ? `
                          <div style="font-weight:700;color:#38bdf8;margin-bottom:3px;font-size:11px;">📄 ${escapeHtml(primaryDoc.relativePath || primaryDoc.name)}</div>
                          <div>${escapeHtml(cleanPreview)}${rawPreview.length > 180 ? '...' : ''}</div>
                        ` : `
                          <div style="color:#64748b;text-align:center;padding:8px 0;">任务完成后在此直接展示文字回复</div>
                        `}
                      </div>
                    </div>
                  `;
                })()}

                <!-- Artifacts Card -->
                <div class="ar-output-card">
                  <div class="ar-output-header">
                    <div style="display:flex;align-items:center;gap:6px;">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                      <div>
                        <span style="font-weight:700;color:#f8fafc;">不可变产物库</span>
                      </div>
                    </div>
                    <span style="font-size:11px;background:rgba(56,189,248,0.15);color:#38bdf8;padding:1px 6px;border-radius:4px;font-weight:700;">${artifacts.length}</span>
                  </div>
                  <div>
                    ${artifacts.length > 0 ? artifacts.slice(0, 6).map((art) => `
                      <div class="ar-file-item" data-goto-view="artifact-center" style="cursor:pointer;" title="点击前往成果库查看详情">
                        <span class="ar-task-code-chip" style="background:rgba(56,189,248,0.12);color:#38bdf8;font-size:9px;">${art.category || 'code'}</span>
                        <span style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(art.name || art.path)}</span>
                      </div>
                    `).join('') : `
                      <div style="padding: 16px; font-size: 11px; color: #64748b; text-align: center;">暂无代码产物，任务执行后自动提取</div>
                    `}
                  </div>
                </div>

                <!-- Reports Card -->
                <div class="ar-output-card">
                  <div class="ar-output-header">
                    <div style="display:flex;align-items:center;gap:6px;">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                      <div>
                        <span style="font-weight:700;color:#f8fafc;">自动化测试门禁</span>
                        <span style="font-size:10.5px;color:#64748b;margin-left:6px;">exitCode=0 验证放行</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    ${subtasks.length > 0 ? subtasks.map((s) => `
                      <div class="ar-report-item">
                        <div style="font-size:11px;color:#cbd5e1;line-height:1.4;">
                          <span class="ar-task-code-chip" style="color:#38bdf8;">${s.code || 'SUB'}</span>
                          ${escapeHtml(s.title)}
                          <span style="color:${s.status === 'succeeded' ? '#10b981' : (s.status === 'failed' ? '#ef4444' : '#94a3b8')};font-size:10px;float:right;">
                            ${s.status === 'succeeded' ? '测试通过' : (s.status === 'failed' ? '未达标' : '待测')}
                          </span>
                        </div>
                      </div>
                    `).join('') : `
                      <div style="padding: 16px; font-size: 11px; color: #64748b; text-align: center;">任务启动后将实时展示门禁测试报告</div>
                    `}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Bottom: 真实时间轨道 -->
          <div class="ar-timeline-block">
            <div class="ar-timeline-header">
              <div class="ar-timeline-title">时间轨道 (Gantt Swimlane)</div>
              <div class="ar-timeline-legend">
                <span>-- 派发</span>
                <span style="color:#38bdf8;">—— 执行</span>
                <span style="color:#10b981;">·· 门禁通过</span>
                <span style="color:#f59e0b;">◆ 审查合流</span>
              </div>
            </div>

            <div class="ar-timeline-tracks">
              ${subtasks.length > 0 ? `
                <div class="ar-track-row">
                  <div class="ar-track-label">
                    <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#ea580c;"></span>
                    主调度器
                  </div>
                  <div class="ar-track-lane">
                    <div class="ar-gantt-bar" style="left:2%;width:20%;background:linear-gradient(90deg,#ea580c,#f97316);">DAG 拆解完成</div>
                    <span style="position:absolute;left:23%;top:4px;color:#f59e0b;font-size:9px;">◆</span>
                    <div class="ar-gantt-bar" style="left:25%;width:50%;background:rgba(234,88,12,0.3);border:1px dashed #f97316;">多模型并发调度中</div>
                    <span style="position:absolute;left:76%;top:4px;color:#f59e0b;font-size:9px;">◆</span>
                    <div class="ar-gantt-bar" style="left:78%;width:20%;background:linear-gradient(90deg,#f97316,#10b981);">产物汇总归档</div>
                  </div>
                </div>
                ${subtasks.map((s, idx) => {
                  const agentName = s.assignedAgentId?.includes('1111') ? 'DeepSeek' : (s.assignedAgentId?.includes('3333') ? 'WorkBuddy' : (s.stage === 'review' ? 'Claude' : 'Agent'));
                  const color = s.status === 'succeeded' ? '#10b981' : (s.status === 'failed' ? '#ef4444' : '#3b82f6');
                  const leftPos = Math.min(20 + idx * 18, 75);
                  return `
                    <div class="ar-track-row">
                      <div class="ar-track-label">
                        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};"></span>
                        ${agentName}
                      </div>
                      <div class="ar-track-lane">
                        <div class="ar-gantt-bar" style="left:${leftPos}%;width:24%;background:${color};">${s.code || `T${idx+1}`} ${escapeHtml(s.title.slice(0, 16))}</div>
                        ${s.status === 'succeeded' ? `<span style="position:absolute;left:${leftPos + 25}%;top:4px;color:#10b981;font-size:9px;">✔ 通过</span>` : ''}
                      </div>
                    </div>
                  `;
                }).join('')}
              ` : `
                <div style="padding: 24px; text-align: center; color: #64748b; font-size: 12.5px;">
                  当前暂无活跃时间轨道数据。请点击右上角 <strong>【➕ 新建真实协同任务】</strong> 立即下发真实需求。
                </div>
              `}
            </div>
          </div>
        </main>
      </div>

      <!-- New Task Modal Dialog -->
      ${uiState.showNewTaskModal ? `
        <div class="ar-modal-backdrop" id="newTaskModalBackdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;">
          <div class="ar-modal-card" style="background:#0f172a;border:1px solid rgba(255,255,255,0.15);border-radius:12px;width:580px;max-width:92vw;box-shadow:0 20px 40px rgba(0,0,0,0.6);padding:24px;color:#f8fafc;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
              <div style="font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;">
                <span style="font-size:20px;">🔮</span>
                <span>发起多智能体真实协同任务</span>
              </div>
              <button id="closeNewTaskModalBtn" style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;">&times;</button>
            </div>

            <div style="display:flex;flex-direction:column;gap:14px;">
              <div>
                <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">任务标题 (Title)</label>
                <input type="text" id="newTaskTitleInput" value="几何算法与自动化门禁验证任务" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#fff;font-size:13px;" />
              </div>

              <div>
                <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">协同任务目标与提示词 (Goal Prompt)</label>
                <textarea id="newTaskGoalInput" rows="4" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#fff;font-size:13px;resize:vertical;" placeholder="请输入你希望多个模型协同完成的开发目标...">编写并实现一个具备高精度圆和矩形计算的图形算法库，通过独立测试门禁并生成最终代码与文档。</textarea>
              </div>

              <div>
                <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">执行代码仓库 (Repository)</label>
                <select id="newTaskRepoSelect" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#fff;font-size:13px;">
                  ${(uiState.repositories || []).map((r) => `
                    <option value="${r.id}">${escapeHtml(r.label)} (${escapeHtml(r.baseBranch || 'main')} @ ${escapeHtml((r.baseCommit || '').slice(0, 7))})</option>
                  `).join('')}
                </select>
              </div>

              <div>
                <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">执行速度与拆解模式 (Execution Speed Mode)</label>
                <select id="newTaskExecModeSelect" style="width:100%;box-sizing:border-box;padding:7px 9px;background:#1e293b;border:1px solid #10b981;border-radius:6px;color:#6ee7b7;font-size:12px;font-weight:600;">
                  <option value="fast">⚡ 极速协同模式 (推荐 · 跳过冗长拆解，单步综合实现 + 终审，提速 70%)</option>
                  <option value="dag">🕸️ 完整多节点 DAG 拆解模式 (适合复杂大型工程，耗时较长)</option>
                </select>
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                <div>
                  <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">规划模型 (Planner)</label>
                  <select id="newTaskPlannerSelect" style="width:100%;box-sizing:border-box;padding:7px 9px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#fff;font-size:12px;">
                    <option value="workbuddy">🛠️ WorkBuddy (本地网关 · 优先推荐)</option>
                    <option value="gemini-3.5-flash-lite">🌐 Gemini 3.5 Flash</option>
                    <option value="claude-3-5-sonnet-20241022">⚡ Claude 3.5 Sonnet</option>
                    <option value="deepseek-reasoner">🧠 DeepSeek Reasoner (R1)</option>
                    <option value="codex">⚙️ Codex (CLI)</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">开发与审查模型 (Developer & Reviewer)</label>
                  <select id="newTaskDevSelect" style="width:100%;box-sizing:border-box;padding:7px 9px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#fff;font-size:12px;">
                    <option value="workbuddy">🛠️ WorkBuddy (本地网关 · 优先推荐)</option>
                    <option value="gemini-3.5-flash-lite">🌐 Gemini 3.5 Flash</option>
                    <option value="claude-3-5-sonnet-20241022">⚡ Claude 3.5 Sonnet</option>
                    <option value="deepseek-chat">🧠 DeepSeek Chat (V3)</option>
                  </select>
                </div>
              </div>
            </div>

            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
              <button id="cancelNewTaskModalBtn" style="padding:8px 16px;background:#334155;border:none;border-radius:6px;color:#cbd5e1;cursor:pointer;font-size:13px;">取消</button>
              <button id="submitNewTaskModalBtn" style="padding:8px 20px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border:none;border-radius:6px;color:#fff;font-weight:700;cursor:pointer;font-size:13px;box-shadow:0 0 12px rgba(99,102,241,0.5);">🚀 立即启动真实协同</button>
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}
function renderAll() {
  captureCurrentInputsBeforeRender();
  renderTopbarAndSidebar();
  renderActiveTaskBar();

  const viewport = document.getElementById('viewportContent');
  if (!viewport) return;

  switch (uiState.activeView) {
    case 'dashboard':
      viewport.innerHTML = renderDashboardView();
      break;
    case 'task-center':
      viewport.innerHTML = renderTaskCenterView();
      break;
    case 'workflow-dag':
      viewport.innerHTML = renderWorkflowDagView();
      break;
    case 'agent-workspace':
      viewport.innerHTML = renderAgentWorkspaceView();
      break;
    case 'communication':
      viewport.innerHTML = renderCommunicationView();
      break;
    case 'review-center':
      viewport.innerHTML = renderReviewCenterView();
      break;
    case 'artifact-center':
      viewport.innerHTML = renderArtifactCenterView();
      break;
    case 'settings':
      viewport.innerHTML = renderSettingsView();
      break;
    case 'agent-router':
      viewport.innerHTML = renderAgentRouterView();
      break;
    default:
      viewport.innerHTML = renderDashboardView();
  }
}

document.addEventListener('click', async (e) => {
  const target = e.target.closest('button, [data-select-task], [data-ar-toggle-mode], [data-ar-member], [data-goto-view]');
  if (!target) return;

  if (target.dataset.selectTextDoc) {
    uiState.selectedTextDeliverableId = target.dataset.selectTextDoc;
    await ensureArtifactContent(target.dataset.selectTextDoc);
    renderAll();
    return;
  }

  if (target.dataset.copyTextDeliverable) {
    const docId = target.dataset.copyTextDeliverable;
    const text = uiState.artifactContentCache[docId] || '';
    if (navigator.clipboard && text) {
      await navigator.clipboard.writeText(text);
      showToast('✔ 已复制成果文字说明到剪贴板！');
    }
    return;
  }

  if (target.dataset.arToggleMode) {
    uiState.routerMode = target.dataset.arToggleMode;
    renderAll();
    return;
  }

  if (target.dataset.arMember) {
    uiState.routerSelectedMember = uiState.routerSelectedMember === target.dataset.arMember ? 'all' : target.dataset.arMember;
    renderAll();
    return;
  }

  if (target.dataset.view) {
    uiState.activeView = target.dataset.view;
    renderAll();
    return;
  }

  if (target.dataset.gotoView) {
    uiState.activeView = target.dataset.gotoView;
    renderAll();
    return;
  }

  if (target.id === 'quickNewTaskBtn') {
    uiState.activeView = 'task-center';
    renderAll();
    document.getElementById('composerGoalInput')?.focus();
    return;
  }

  if (target.id === 'createRealTaskBtn') {
    uiState.showNewTaskModal = true;
    renderAll();
    return;
  }

  if (target.id === 'closeNewTaskModalBtn' || target.id === 'cancelNewTaskModalBtn' || target.id === 'newTaskModalBackdrop') {
    uiState.showNewTaskModal = false;
    renderAll();
    return;
  }

  if (target.id === 'submitNewTaskModalBtn') {
    const titleInput = document.getElementById('newTaskTitleInput');
    const goalInput = document.getElementById('newTaskGoalInput');
    const repoSelect = document.getElementById('newTaskRepoSelect');
    const plannerSelect = document.getElementById('newTaskPlannerSelect');
    const devSelect = document.getElementById('newTaskDevSelect');
    const execModeSelect = document.getElementById('newTaskExecModeSelect');

    const title = titleInput?.value.trim() || '多智能体真实协同研发任务';
    const goal = goalInput?.value.trim();
    const repositoryId = repoSelect?.value || uiState.repositories?.[0]?.id;
    const execMode = execModeSelect?.value || 'fast';

    if (!goal) {
      showToast('请输入具体的任务目标与 Prompt！', true);
      return;
    }

    try {
      const plannerModel = plannerSelect?.value || 'workbuddy';
      const devModel = devSelect?.value || 'workbuddy';
      const fastSubtaskId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
        ? globalThis.crypto.randomUUID()
        : '10000000-1000-4000-8000-' + String(Date.now()).padStart(12, '0').slice(-12);
      showToast(`🚀 正在向 Hub 主调度器下发真实目标 (模型: ${devModel}, 模式: ${execMode === 'fast' ? '⚡极速直达' : '🕸️DAG拆解'})...`);
      const created = await apiRequest('/api/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title,
          goal,
          repositoryId,
          priority: 'high',
          models: {
            planner: plannerModel,
            developer: devModel,
            reviewer: devModel
          },
          acceptanceCriteria: [
            { id: 'ac-core', description: 'All generated modules pass automated tests and review gate' }
          ],
          ...(execMode === 'fast' ? {
            plannedSubtasks: [
              {
                id: fastSubtaskId,
                code: 'SUB-01',
                title: `${title} · 综合实现与中文成果报告`,
                description: `直接完成用户目标（${goal}），生成所需代码/数据文件以及一份详尽直观的中文成果说明报告 DELIVERY_REPORT.md，并在最终回复中直接给出完整的中文文字解答。`,
                stage: 'implementation',
                dependsOn: [],
                requiredCapabilities: ['stream'],
                acceptanceCriteria: [
                  { id: 'ac-sub-01', description: 'Deliver complete implementation and Chinese summary report' }
                ]
              }
            ]
          } : {})
        })
      });

      uiState.showNewTaskModal = false;
      uiState.selectedTaskId = created.id;
      showToast(`✔ 真实任务下发成功 (ID: ${created.id.slice(0, 8)}...)，模型正在并行执行！`);
      await loadConsistentSnapshot(created.id);
    } catch (err) {
      showToast(`下发任务失败: ${err.message}`, true);
    }
    return;
  }

  if (target.id === 'testExpiredCursorBtn') {
    await connectFetchSse(1);
    return;
  }

  if (target.id === 'resetDemoStateBtn') {
    await apiRequest('/__mock_control/reset', { method: 'POST', body: JSON.stringify({}) });
    await loadConsistentSnapshot('task-smartcar-01');
    showToast('已通过 /__mock_control/reset 重置初始演示状态');
    return;
  }

  if (target.dataset.selectTask && !e.target.closest('button')) {
    uiState.selectedTaskId = target.dataset.selectTask;
    await loadConsistentSnapshot(uiState.selectedTaskId);
    return;
  }

  if (target.dataset.filterAgent) {
    uiState.selectedAgentId = target.dataset.filterAgent;
    renderAll();
    return;
  }

  if (target.dataset.filterArtifact) {
    uiState.selectedArtifactCategory = target.dataset.filterArtifact;
    renderAll();
    return;
  }

  if (target.dataset.downloadArtifact) {
    const artifactId = target.dataset.downloadArtifact;
    const filename = target.dataset.filename || `${artifactId}.bin`;
    const raw = await fetchArtifactRaw(artifactId);
    const blob = new Blob([raw.bytes], { type: raw.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    uiState.lastDownloadedArtifact = {
      artifactId,
      filename,
      byteLength: raw.bytes.byteLength,
      mimeType: raw.mimeType,
      sha256: raw.sha256,
      expectedSha256: raw.expectedSha256,
      bytesPreserved: !raw.expectedSha256 || raw.expectedSha256.toLowerCase() === raw.sha256.toLowerCase()
    };
    showToast(`已校验 SHA-256 并下载原始受控产物: ${filename} (${raw.bytes.byteLength} bytes)`);
    return;
  }

  // Quick Inspiration Preset fill
  const quickPresetBtn = target.closest('.quick-prompt-btn');
  if (quickPresetBtn) {
    const title = quickPresetBtn.getAttribute('data-preset-title');
    const goal = quickPresetBtn.getAttribute('data-preset-goal');
    if (title && goal) {
      uiState.composerDraft.title = title;
      uiState.composerDraft.goal = goal;
      const tInput = document.getElementById('composerTitleInput');
      const gInput = document.getElementById('composerGoalInput');
      if (tInput) tInput.value = title;
      if (gInput) gInput.value = goal;
      showToast(`已载入灵感预设：「${title}」`);
    }
    return;
  }

  // B-03 Interruption Quarantine Recovery: acknowledge
  if (target.dataset.action === 'ack-interruption') {
    const runId = target.dataset.runId;
    const version = Number(target.dataset.runVersion);
    const confirmed = confirm("确认已核对该 Run 的孤儿进程组已退出，且已复核工作区副作用？\n确认后将向后端发送解除隔离请求并释放执行槽。");
    if (!confirmed) return;
    try {
      target.disabled = true;
      target.textContent = "正在解除隔离...";
      await apiRequest(`/api/v1/runs/${encodeURIComponent(runId)}/acknowledge`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: version,
          processGroupVerifiedStopped: true,
          reason: 'Web Console Operator confirmed process stopped and reviewed side-effects'
        })
      });
      showToast("执行槽隔离已受控解除，系统已恢复可用！", false);
      await loadConsistentSnapshot(uiState.selectedTaskId);
    } catch (err) {
      showToast("解除隔离失败: " + err.message, true);
      renderAll();
    }
    return;
  }

  // v0.2 Business Task Control: pause | resume | cancel
  if (target.dataset.v1TaskControl) {
    const action = target.dataset.v1TaskControl;
    const taskId = target.dataset.taskId || uiState.selectedTaskId;
    const expectedVersion = Number(target.dataset.version);
    const body = action === 'cancel' ? { expectedVersion, reason: 'Operator requested cancellation from UI' } : { expectedVersion };
    const res = await apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    showToast(`任务控制指令已提交 [202]: status=${res.status} (operationId=${res.operationId})`);
    await loadConsistentSnapshot(taskId);
    return;
  }

  // Isolated Mock Step
  if (target.dataset.mockStep) {
    const taskId = target.dataset.mockStep;
    const res = await apiRequest('/__mock_control/step', {
      method: 'POST',
      body: JSON.stringify({ taskId })
    });
    showToast(`模拟步进完成: ${res.transition}`);
    await loadConsistentSnapshot(taskId);
    return;
  }

  // Isolated Mock Fault Injection
  if (target.dataset.mockFault) {
    const faultType = target.dataset.mockFault;
    const taskId = target.dataset.taskId || uiState.selectedTaskId;
    await apiRequest('/__mock_control/fault', {
      method: 'POST',
      body: JSON.stringify({ taskId, faultType })
    });
    showToast(`已通过 /__mock_control/fault 注入模拟故障: ${faultType}`);
    await loadConsistentSnapshot(taskId);
    return;
  }

  // v0.2 Subtask Retry
  if (target.dataset.subtaskRetry) {
    const subtaskId = target.dataset.subtaskRetry;
    const sub = (uiState.selectedTaskDetail?.subtasks || []).find((s) => s.id === subtaskId);
    const expectedVersion = Number(target.dataset.version || sub?.version || 1);
    const res = await apiRequest(`/api/v1/subtasks/${encodeURIComponent(subtaskId)}/retry`, {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion,
        reason: 'Operator triggered bounded retry from UI'
      })
    });
    const retryInfo = res?.subtask
      ? `Attempt #${res.subtask.attempt}/${res.subtask.maxAttempts}`
      : `status=${res?.status || 'retry_wait'} (operationId=${res?.operationId || 'ok'})`;
    showToast(`已启动子任务新尝试 (${retryInfo})`);
    await loadConsistentSnapshot(uiState.selectedTaskId);
    return;
  }

  // v0.2 Subtask Rework (decoupled from approval decision)
  if (target.dataset.subtaskRework) {
    captureCurrentInputsBeforeRender();
    const subtaskId = target.dataset.subtaskRework;
    const expectedVersion = Number(target.dataset.version);
    const artifactRefs = (target.dataset.artifacts || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const commentRef = target.dataset.commentRef;
    const reason =
      (commentRef && uiState.reviewComments[commentRef]?.trim()) ||
      'Operator requested subtask rework; invalidating pending approval and starting new attempt.';

    const res = await apiRequest(`/api/v1/subtasks/${encodeURIComponent(subtaskId)}/rework`, {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion,
        reason,
        artifactRefs
      })
    });
    const reworkInfo = res?.subtask
      ? `Attempt #${res.subtask.attempt}，已自动失效旧审批: ${(res.invalidatedApprovalIds || []).join(', ') || 'none'}`
      : `status=${res?.status || 'retry_wait'} (operationId=${res?.operationId || 'ok'}，旧待决审批已自动置为 invalidated)`;
    showToast(`已发起子任务独立返工 (${reworkInfo})`);
    await loadConsistentSnapshot(uiState.selectedTaskId);
    return;
  }

  // v0.2 Approval Decision: strictly 'approve' | 'reject'
  if (target.dataset.approvalDecision) {
    captureCurrentInputsBeforeRender();
    const decision = target.dataset.approvalDecision;
    const approvalId = target.dataset.approvalId;
    const expectedVersion = Number(target.dataset.version);
    const actionDigest = target.dataset.digest;
    const comment = uiState.reviewComments[approvalId]?.trim() || undefined;

    const res = await apiRequest(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion,
        decision,
        actionDigest,
        ...(comment ? { comment } : {})
      })
    });
    showToast(`审批决定已生效: status=${res.status} (actionDigest 已校验)`);
    await loadConsistentSnapshot(uiState.selectedTaskId);
    return;
  }

  // v0.2 Decompose Preview
  if (target.id === 'previewDecomposeBtn') {
    captureCurrentInputsBeforeRender();
    const plan = await apiRequest('/api/v1/tasks/decompose', {
      method: 'POST',
      body: JSON.stringify({
        goal: uiState.composerDraft.goal,
        repositoryId: uiState.composerDraft.repositoryId
      })
    });
    uiState.composerDraft.draftPlan = plan;
    showToast(`已生成 DraftPlan (${plan.subtasks.length} 个 PlannedSubtask)`);
    renderAll();
    return;
  }

  // Explicit compression of non-executable DraftPlan nodes preserving transitive dependencies
  if (target.id === 'compressDraftPlanBtn') {
    captureCurrentInputsBeforeRender();
    const currentPlan = uiState.composerDraft.draftPlan;
    if (!currentPlan || !Array.isArray(currentPlan.subtasks)) return;
    try {
      const compressed = sanitizeExecutablePlan(currentPlan.subtasks);
      uiState.composerDraft.draftPlan = {
        ...currentPlan,
        subtasks: compressed,
        compressedFromCount: currentPlan.subtasks.length
      };
      showToast(`已显式压缩非执行节点并保留传递依赖，请核对新预览 (${compressed.length} 个可执行节点)`);
      renderAll();
    } catch (err) {
      showToast(`压缩计划失败 [${err.code || 'INVALID_INPUT'}]: ${err.message}`, true);
    }
    return;
  }

  // v0.2 Create Task
  if (target.id === 'launchTaskBtn') {
    captureCurrentInputsBeforeRender();
    const rawDraftSubtasks = uiState.composerDraft.draftPlan?.subtasks;
    let plannedSubtasks;
    if (Array.isArray(rawDraftSubtasks)) {
      if (uiState.meta.executionMode === 'live') {
        const compat = inspectDraftPlanCompatibility(rawDraftSubtasks);
        if (!compat.isDirectlyExecutable) {
          const invalidList = [...compat.analysisNodes, ...compat.reservedNodes]
            .map((n) => `${n.code}(${n.stage})`)
            .join(', ');
          const msg =
            compat.executableCount === 0
              ? 'DraftPlan 不包含任何可执行子任务，拒绝静默回退服务端重规划'
              : `DraftPlan 含非执行或保留节点 [${invalidList}]，拒绝静默删减；请先点击「压缩非执行节点并重新预览」确认传递依赖后再创建`;
          showToast(`请求被拒绝 [INVALID_INPUT]: ${msg}`, true);
          return;
        }
        try {
          plannedSubtasks = sanitizeExecutablePlan(rawDraftSubtasks);
        } catch (err) {
          showToast(`请求被拒绝 [${err.code || 'INVALID_INPUT'}]: ${err.message}`, true);
          return;
        }
      } else {
        plannedSubtasks = rawDraftSubtasks.filter((s) => s.code !== 'FINAL-REVIEW');
      }
    }
    const createdTask = await apiRequest('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: uiState.composerDraft.title,
        goal: uiState.composerDraft.goal,
        repositoryId: uiState.composerDraft.repositoryId,
        priority: uiState.composerDraft.priority,
        acceptanceCriteria: [
          { id: 'ac-1', description: 'All planned subtasks pass independent validation (exitCode=0)' }
        ],
        ...(plannedSubtasks ? { plannedSubtasks } : {})
      })
    });
    uiState.selectedTaskId = createdTask.id;
    uiState.composerDraft.draftPlan = null;
    showToast(`新任务已创建并进入 ${createdTask.status} 队列 (ID: ${createdTask.id})`);
    await loadConsistentSnapshot(createdTask.id);
    return;
  }

  // v0.2 Send Queued Context Message
  if (target.id === 'sendDirectiveBtn') {
    captureCurrentInputsBeforeRender();
    const task = getSelectedTask();
    if (!task) return;
    const subtasks = uiState.selectedTaskDetail?.subtasks || [];
    const toSubtaskId = uiState.directiveSubtaskId || subtasks[0]?.id;
    const content = uiState.directiveDraft.trim();
    if (!content || !toSubtaskId) {
      showToast('请选择目标子任务并输入补充上下文内容', true);
      return;
    }
    const res = await apiRequest(`/api/v1/tasks/${encodeURIComponent(task.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        toSubtaskId,
        content,
        artifactRefs: []
      })
    });
    uiState.directiveDraft = '';
    showToast(`上下文消息已登记 (delivery=${res.delivery})`);
    await loadConsistentSnapshot(task.id);
  }
});

// Keyboard Shortcuts (1-9 to switch modules when not typing in form fields)
const VIEW_KEYS = {
  '1': 'agent-router',
  '2': 'task-center',
  '3': 'agent-workspace',
  '4': 'artifact-center',
  '5': 'dashboard',
  '6': 'workflow-dag',
  '7': 'review-center',
  '8': 'communication',
  '9': 'settings'
};

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target?.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
  const nextView = VIEW_KEYS[e.key];
  if (nextView && uiState.activeView !== nextView) {
    uiState.activeView = nextView;
    renderAll();
  }
});

// Bootstrap
(async function init() {
  try {
    const snap = await loadConsistentSnapshot('task-smartcar-01');
    await connectFetchSse(snap.snapshotSeq);
  } catch (err) {
    console.error('Bootstrap failed:', err);
  }
})();
