// Multi-Agent Collaboration Hub — Frontend Controller (apps/web/public/app.js)
// Strictly aligned with Unified Contract v0.2 (docs/api-contract.md & packages/shared/src/types.v0.2.ts):
// 1. All business endpoints use /api/v1/* with { data, requestId } and Page<T> { items, nextCursor }.
// 2. Mutating POST requests include Idempotency-Key and expectedVersion CAS.
// 3. Statuses strictly use v0.2 enums: succeeded, waiting_approval, pausing -> paused, cancelling -> cancelled.
// 4. Approval decisions strictly use 'approve' | 'reject'; rework uses POST /api/v1/subtasks/:id/rework.
// 5. Historical real CLI evidence (real-relay-01) is strictly read-only.
// 6. Mock step/reset/fault controls are isolated under /__mock_control/* outside /api/v1.

const AUTH_TOKEN = globalThis.__HUB_BOOT__.token;

const uiState = {
  activeView: 'dashboard',
  selectedTaskId: null,
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
  reviewComments: {}
};
globalThis.uiState = uiState;

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

async function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
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

  if (path.endsWith('/content')) {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object' && typeof payload.data === 'string') return payload.data;
    return JSON.stringify(payload, null, 2);
  }

  return isJson ? payload.data : payload;
}

function sanitizeExecutablePlan(subtasks) {
  if (!Array.isArray(subtasks)) return undefined;
  const executable = subtasks.filter((s) => s.stage !== 'analysis' && s.code !== 'FINAL-REVIEW');
  if (executable.length === 0) return undefined;
  const validIds = new Set(executable.map((s) => s.id));
  return executable.map((s) => ({
    ...s,
    dependsOn: (s.dependsOn || []).filter((depId) => validIds.has(depId))
  }));
}

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
    for (const art of artifacts) {
      ensureArtifactContent(art.id);
    }
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
          <span>v${t.version} · ${t.progressPct}% · <span class="mock-tag ${isHistorical ? 'provenance-live' : ''}">${isHistorical ? '🔒 HISTORICAL LIVE' : (t.executionMode === 'live' ? 'LIVE CURRENT' : 'MOCK CURRENT')}</span></span>
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
        <span class="mock-tag ${isHistorical ? 'provenance-live' : ''}">${isHistorical ? '🔒 HISTORICAL REAL EVIDENCE (READ-ONLY · provenance=historical)' : (task.executionMode === 'live' ? 'LIVE CURRENT (executionMode=live · provenance=current)' : 'MOCK CURRENT (executionMode=mock · provenance=current)')}</span>
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
      !isHistorical && uiState.meta.executionMode === 'mock'
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
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">分页任务列表 (Page&lt;Task&gt;)</div>
        <div class="kpi-value">${tasks.length}</div>
        <div class="kpi-sub">${tasks.filter((t) => t.provenance !== 'historical' && t.executionMode === 'live').length} 项当前 LIVE / ${tasks.filter((t) => t.provenance !== 'historical' && t.executionMode === 'mock').length} 项当前 MOCK / ${tasks.filter((t) => t.provenance === 'historical').length} 项历史证据</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">当前任务 DAG 节点 (Succeeded)</div>
        <div class="kpi-value">${succeededSubs} / ${subtasks.length}</div>
        <div class="kpi-sub">状态枚举严格对齐 v0.2 succeeded</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Agent 适配器注册表</div>
        <div class="kpi-value">${agents.filter((a) => a.availability === 'available' || a.availability === 'busy').length} / ${agents.length}</div>
        <div class="kpi-sub">含 B-01 沙箱策略与 unsupportedReasons</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">待决审批 (waiting_approval)</div>
        <div class="kpi-value" style="color:${pendingApprovals.length ? 'var(--accent-amber)' : 'var(--accent-green)'}">${pendingApprovals.length}</div>
        <div class="kpi-sub">审批与 Subtask Rework 职责严格分离</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">当前任务不可变产物</div>
        <div class="kpi-value">${artifacts.length}</div>
        <div class="kpi-sub">relativePath + SHA-256 · 严禁绝对路径</div>
      </div>
    </div>

    <div class="section-card">
      <div class="section-header">
        <div class="section-title">Agent 适配器能力矩阵与 B-01 安全运行时边界 (GET /api/v1/agents)</div>
        <div style="display:flex;gap:8px;">
          ${uiState.meta.executionMode === 'mock' ? `<button class="btn" id="testExpiredCursorBtn" title="发送过期 Last-Event-ID=1 触发 409 EVENT_CURSOR_EXPIRED 并验证自动快照重连">演练 SSE 游标过期恢复 (409 Replay)</button>` : ''}
        </div>
      </div>
      <div class="agent-grid">
        ${agents
          .map(
            (ag) => `
          <div class="agent-card">
            <div class="agent-card-top">
              <div>
                <div class="agent-name">${escapeHtml(ag.label)}</div>
                <div class="agent-role">${escapeHtml(ag.roleTitle)}</div>
              </div>
              <span class="status-badge status-${escapeHtml(ag.availability)}">${escapeHtml(ag.availability)}</span>
            </div>
            <div style="font-size:11.5px;color:var(--text-secondary);font-family:var(--font-mono);">
              <div>Adapter: <code>${escapeHtml(ag.adapterId)} @ ${escapeHtml(ag.adapterVersion)}</code></div>
              <div>PermissionProfile: <code>${escapeHtml(ag.permissionProfile)}</code></div>
              <div>Stages: ${escapeHtml((ag.supportedStages || []).join(', '))} | MaxConcurrency: ${ag.maxConcurrency}</div>
            </div>
            <div class="chip-list">
              ${(ag.capabilities || []).map((c) => `<span class="chip" style="color:#6ee7b7;">✓ ${escapeHtml(c)}</span>`).join('')}
              ${Object.entries(ag.unsupportedReasons || {})
                .map(
                  ([cap, reason]) =>
                    `<span class="chip" style="color:#fca5a5;" title="${escapeHtml(reason)}">✗ ${escapeHtml(cap)}: ${escapeHtml(reason)}</span>`
                )
                .join('')}
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>

    ${
      activeTask
        ? `
      <div class="section-card">
        <div class="section-header">
          <div class="section-title">当前聚焦任务一致性详情 (GET /api/v1/tasks/${escapeHtml(activeTask.id)})</div>
          <div style="display:flex;gap:8px;">
            <button class="btn" data-goto-view="workflow-dag">查看完整 Subtask DAG →</button>
            <button class="btn btn-warn" data-goto-view="review-center">前往审核门禁 (${pendingApprovals.length}) →</button>
          </div>
        </div>
        <p style="color:var(--text-secondary);margin-bottom:12px;">
          <strong>任务目标 (goal)：</strong>${escapeHtml(activeTask.goal)}
        </p>
        <div class="dag-stages">
          ${subtasks
            .map(
              (s) => `
            <div class="dag-node node-${escapeHtml(s.status)}" style="margin-top:0;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <strong>${escapeHtml(s.code)} · ${escapeHtml(s.stage.toUpperCase())}</strong>
                <span class="status-badge status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
              </div>
              <div style="font-weight:600;color:#fff;">${escapeHtml(s.title)}</div>
              <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">
                attempt: ${s.attempt}/${s.maxAttempts} | timeoutMs: ${s.timeoutMs} | deps: ${s.dependsOn.length ? escapeHtml(s.dependsOn.join(', ')) : 'root'}
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `
        : ''
    }
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
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">发布多 Agent 自主协同任务 (POST /api/v1/tasks/decompose & POST /api/v1/tasks)</div>
        <span class="mock-tag">强制校验 repositoryId 白名单 + Idempotency-Key + 有界 DAG (&lt;=100)</span>
      </div>
      <div class="form-row">
        <div style="flex:2;min-width:240px;">
          <label style="font-size:11px;color:var(--text-secondary);">任务标题 (title)</label>
          <input id="composerTitleInput" class="input" value="${escapeHtml(draft.title)}" />
        </div>
        <div style="flex:1;min-width:220px;">
          <label style="font-size:11px;color:var(--text-secondary);">受控登记仓库 (repositoryId)</label>
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
          <label style="font-size:11px;color:var(--text-secondary);">优先级 (priority)</label>
          <select id="composerPrioritySelect" class="select">
            <option value="high" ${draft.priority === 'high' ? 'selected' : ''}>high</option>
            <option value="critical" ${draft.priority === 'critical' ? 'selected' : ''}>critical</option>
            <option value="medium" ${draft.priority === 'medium' ? 'selected' : ''}>medium</option>
            <option value="low" ${draft.priority === 'low' ? 'selected' : ''}>low</option>
          </select>
        </div>
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:11px;color:var(--text-secondary);">自然语言任务目标 (goal)</label>
        <textarea id="composerGoalInput" class="textarea">${escapeHtml(draft.goal)}</textarea>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <button class="btn" id="previewDecomposeBtn">1. 生成 DraftPlan 拆解预览 (POST /api/v1/tasks/decompose)</button>
        <button class="btn btn-primary" id="launchTaskBtn">2. 创建并入队任务 (POST /api/v1/tasks → 201 queued)</button>
      </div>
      <div style="margin-top:8px;font-size:11.5px;color:var(--text-secondary);font-family:var(--font-mono);background:rgba(6,182,212,0.06);border:1px solid rgba(6,182,212,0.22);padding:7px 10px;border-radius:6px;">
        🛡️ <strong>B-04~B-06 协同规则：</strong><code>FINAL-REVIEW</code> 为服务端协调器保留编码（创建可执行任务时自动追加 <code>Independent final review</code> 独立会话终审节点，客户端切勿重复使用）；<code>analysis</code> 阶段归属 <code>/tasks/decompose</code> 拆解预览，可执行子任务使用 <code>implementation | testing | review | documentation</code>；省略 <code>testProfileId</code> 时服务端自动绑定仓库登记的 <code>defaultTestProfileId</code> 并在独立 OS 沙箱内运行验收（测试期间若修改受控源码树将判定验收失败）。
      </div>

      ${
        draft.draftPlan
          ? `
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-subtle);">
          <div style="font-weight:700;margin-bottom:8px;color:#93c5fd;">
            DraftPlan #${escapeHtml(draft.draftPlan.id)} 预览 (共 ${draft.draftPlan.subtasks.length} 个 PlannedSubtask，不执行生成代码)：
          </div>
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
      `
          : ''
      }
    </div>

    <div class="section-card">
      <div class="section-header">
        <div class="section-title">多任务状态看板 (GET /api/v1/tasks · Page&lt;Task&gt; nextCursor=${escapeHtml(String(uiState.tasksPage.nextCursor))})</div>
        <span style="font-size:12px;color:var(--text-secondary);">严格区分 current (LIVE/MOCK) 与 historical (只读实测证据)</span>
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
                        <span class="mock-tag ${isHist ? 'provenance-live' : ''}">${isHist ? '🔒 HISTORICAL LIVE' : (t.executionMode === 'live' ? 'LIVE CURRENT' : 'MOCK CURRENT')}</span>
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
              <span class="mock-tag ${run.provenance === 'historical' ? 'provenance-live' : ''}">${run.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : (run.executionMode === 'live' ? 'LIVE RUN' : 'MOCK RUN')}</span>
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
                  ${run.status === 'interrupted' ? `<div style="color:#fcd34d;margin-top:3px;">B-03 Quarantine: 执行槽已保留隔离，需核对进程组已停止且复核副作用后方可解除，禁止自动重放。</div>` : ''}
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
                <span class="mock-tag">${m.provenance === 'historical' ? '🔒 HISTORICAL LIVE' : (m.executionMode === 'live' ? 'LIVE CURRENT' : 'MOCK CURRENT')}</span>
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
  const allArts = detail?.artifacts?.items || [];
  const filtered =
    uiState.selectedArtifactCategory === 'all'
      ? allArts
      : allArts.filter((a) => a.category === uiState.selectedArtifactCategory);

  return `
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
              <span class="mock-tag ${art.provenance === 'historical' ? 'provenance-live' : ''}">${art.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : (art.executionMode === 'live' ? 'LIVE ARTIFACT' : 'MOCK ARTIFACT')}</span>
              <span class="chip">${escapeHtml(art.category.toUpperCase())}</span>
              <span class="status-badge status-${escapeHtml(art.validationStatus)}">${escapeHtml(art.validationStatus)}</span>
              <strong style="color:#fff;margin-left:6px;font-family:var(--font-mono);">${escapeHtml(art.relativePath)}</strong>
            </div>
            <div style="display:flex;align-items:center;gap:10px;font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">
              <span>ID: ${escapeHtml(art.id)}</span>
              <span>SHA-256: ${(art.sha256 || '').slice(0, 14)}...</span>
              <span>${art.sizeBytes} B</span>
              <button class="btn btn-sm" data-download-artifact="${escapeHtml(art.id)}" data-filename="${escapeHtml((art.relativePath || 'artifact.txt').split('/').pop())}" title="下载受控产物 (GET /api/v1/artifacts/:id/content)">⬇ 下载产物</button>
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
        <div class="section-title">契约版本 v0.2 与 Codex B-01 / B-02 / B03-1 分批交接对齐状态 (Contract & Backend Handoff Status)</div>
        <span class="mock-tag">contractVersion=${escapeHtml(uiState.meta.contractVersion)} · F-03 Migrated</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;color:var(--text-secondary);font-size:13px;">
        <div style="padding:12px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:6px;">
          <strong style="color:#fff;">1. Codex B-01 安全参数改造（已交付 · 413 项测试通过）：</strong>
          <p style="margin-top:4px;">
            已移除遇到外部 Git 元数据时自动提权至 <code>danger-full-access</code> 的逻辑（<code>auto</code> 模式直接报 <code>PERMISSION_DENIED</code>，<code>ask</code> 模式保持 <code>read-only</code>）；拒绝非空 <code>AGETOR_CODEX_ARGS</code>；默认关闭未授权 CLI 自动发现（<code>AGETOR_HARNESS_AUTO_ENABLE != 1</code>）。
          </p>
        </div>
        <div style="padding:12px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:6px;">
          <strong style="color:#fff;">2. Codex B-02 受控执行器（已交付 · 真实 CLI 6 项串行验收通过）：</strong>
          <p style="margin-top:4px;">
            <code>packages/agent-adapters/codex/runtime.ts</code> 独立子进程运行器已就绪（不依赖 <code>tmux</code>），通过真实 ChatGPT 登录验证：启动输出、显式 session 恢复、允许工作区写入、工作区外写入拒绝、活动取消（<code>commandStarted=true</code> → <code>CANCELLED</code>）、活动 15s 超时（<code>timeoutCommandStarted=true</code> → <code>TIMEOUT</code>）。
          </p>
        </div>
        <div style="padding:12px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:6px;">
          <strong style="color:#fff;">3. Codex B-03 SQLite 持久化与启动恢复（B03-1 & B03-2 已完成交付 · 提交 0f19c9b9）：</strong>
          <p style="margin-top:4px;">
            新增 082 号迁移与 <code>hub_</code> 命名空间表，39 项 Hub 测试、51 项迁移回归与真实 CLI 重开数据库验证通过；支持 <code>(subtaskId, idempotencyKey)</code> 幂等、单执行槽 lease、启动崩溃保守对账（<code>run=interrupted</code>, <code>subtask=blocked</code>，保留执行槽隔离并禁止自动重放），以及控制区 <code>hub-root/state/</code> 与 Agent 实际 <code>hub-root/workspaces/task-001/</code> 目录互不包含边界。
          </p>
        </div>
        <div style="padding:12px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:6px;">
          <strong style="color:#fff;">4. Antigravity F-03 前端契约 v0.2 迁移与 SSE 游标衔接：</strong>
          <p style="margin-top:4px;">
            全部业务接口收敛至 <code>/api/v1/*</code>，列表统一返回 <code>Page&lt;T&gt; { items, nextCursor }</code>；写操作强制校验 <code>Idempotency-Key</code>、<code>expectedVersion</code> 与未知字段拒绝；Mock 步进/故障注入物理隔离至 <code>/__mock_control/*</code>。当前快照水位 <code>snapshotSeq=${uiState.snapshotSeq}</code>，已应用事件序号 <code>seq=${uiState.lastAppliedSeq}</code>，已幂等忽略重复事件 <code>${uiState.duplicateEventsIgnored}</code> 次。
          </p>
        </div>
        <div style="padding:12px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:6px;">
          <strong style="color:#fff;">5. Codex B-04 ~ B-06 真实多 Agent 协同平台与 F-02 / I-01 端到端闭环（已交付 · 提交 9322bac2）：</strong>
          <p style="margin-top:4px;">
            已打通真实 HTTP <code>/api/v1/*</code>、Fetch-SSE 流式事件、Git Worktree 隔离执行、独立 OS 沙箱验收测试（<code>defaultTestProfileId</code>）与 <code>actionDigest</code> 终审门禁（协调器自动追加保留编码 <code>FINAL-REVIEW</code> 独立会话终审节点，规划预览 <code>analysis</code> 阶段与可执行 DAG 严格分离）。
          </p>
        </div>
      </div>
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
    default:
      viewport.innerHTML = renderDashboardView();
  }
}

document.addEventListener('click', async (e) => {
  const target = e.target.closest('button, [data-select-task]');
  if (!target) return;

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

  if (uiState.meta.executionMode !== 'mock' && (['testExpiredCursorBtn', 'resetDemoStateBtn'].includes(target.id) || target.dataset.mockStep || target.dataset.mockFault)) {
    showToast('Mock controls are disabled by the live backend', true);
    return;
  }

  if (target.id === 'testExpiredCursorBtn') {
    await connectFetchSse(1);
    return;
  }

  if (target.id === 'resetDemoStateBtn') {
    await apiRequest('/__mock_control/reset', { method: 'POST', body: JSON.stringify({}) });
    await loadConsistentSnapshot(null);
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
    const filename = target.dataset.filename || `${artifactId}.txt`;
    await ensureArtifactContent(artifactId);
    const content = uiState.artifactContentCache[artifactId] || '';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`已下载受控产物: ${filename}`);
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

  // v0.2 Create Task
  if (target.id === 'launchTaskBtn') {
    captureCurrentInputsBeforeRender();
    const rawDraftSubtasks = uiState.composerDraft.draftPlan?.subtasks;
    const plannedSubtasks =
      uiState.meta.executionMode === 'live'
        ? sanitizeExecutablePlan(rawDraftSubtasks)
        : rawDraftSubtasks?.filter((s) => s.code !== 'FINAL-REVIEW');
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

// Keyboard Shortcuts (1-8 to switch modules when not typing in form fields)
const VIEW_KEYS = {
  '1': 'dashboard',
  '2': 'task-center',
  '3': 'workflow-dag',
  '4': 'agent-workspace',
  '5': 'communication',
  '6': 'review-center',
  '7': 'artifact-center',
  '8': 'settings'
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
    const snap = await loadConsistentSnapshot(null);
    await connectFetchSse(snap.snapshotSeq);
  } catch (err) {
    console.error('Bootstrap failed:', err);
  }
})();
