import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4320);
const HOST = process.env.HOST || '127.0.0.1';
const DEV_TOKEN = process.env.HUB_DEV_TOKEN || 'dev-local-hub-token-v1';

const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:4320',
  'http://localhost:4320'
]);

let globalSeq = 200;
const MIN_RETAINED_SEQ_WINDOW = 180;
const MAX_OUTBOX = 300;
const eventOutbox = [];
const sseClients = new Set();
const idempotencyStore = new Map();
const artifactContentStore = new Map();
const runLogsStore = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalizeJson(value[k]))
      .join(',') +
    '}'
  );
}

function createInitialState() {
  globalSeq = 200;
  eventOutbox.length = 0;
  idempotencyStore.clear();
  artifactContentStore.clear();
  runLogsStore.clear();

  const contractsPy = `from dataclasses import dataclass
import numpy as np

@dataclass(frozen=True)
class CameraHomography:
    h_matrix: np.ndarray
    h_inv: np.ndarray
    pixels_per_meter: float = 120.0

@dataclass(frozen=True)
class LaneFitResult:
    center_offset_cm: float
    curvature_radius_m: float
    heading_error_deg: float
    confidence: float
`;

  const laneDetectorPy = `import cv2
import numpy as np
from .contracts import CameraHomography, LaneFitResult

class SlidingWindowLaneDetector:
    """Birds-eye perspective warp + 9-band sliding window polynomial lane tracker."""
    def detect(self, frame) -> LaneFitResult:
        return LaneFitResult(
            center_offset_cm=1.42,
            curvature_radius_m=48.5,
            heading_error_deg=-0.85,
            confidence=0.96
        )
`;

  const obstacleDiff = `diff --git a/src/vision/obstacle_detector.py b/src/vision/obstacle_detector.py
new file mode 100644
index 0000000..f73c91a
--- /dev/null
+++ b/src/vision/obstacle_detector.py
@@ -0,0 +1,28 @@
+import cv2
+import numpy as np
+from .contracts import CameraHomography
+
+class SmartCarObstacleDetector:
+    """Real-time cone & barrier detector with CLAHE glare suppression."""
+    def __init__(self, homography: CameraHomography, conf_threshold: float = 0.65):
+        self.homography = homography
+        self.conf_threshold = conf_threshold
+        self.clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
`;

  const relayAcceptanceJson = JSON.stringify(
    {
      execution: 'real',
      faultInjected: true,
      initialTestExit: 1,
      finalTestExit: 0,
      stdout: '5 acceptance cases passed\n',
      developerSession: '01a19ad1-2021-7f92-9454-108378e8ace6',
      reviewerSession: '01a19ad1-36b6-7ab1-9d83-e3ae84bd1909',
      independentSessions: true,
      reviewerRanTests: true,
      testsExecutedBy: 'coordinator-and-reviewer',
      repairUsedResume: true
    },
    null,
    2
  );

  const relayClampPy = `def clamp(value: float, lower: float, upper: float) -> float:
    """Clamp value into [lower, upper]. Raises ValueError when lower > upper."""
    if lower > upper:
        raise ValueError("lower bound must not exceed upper bound")
    return max(lower, min(upper, value))
`;

  artifactContentStore.set('art-01', contractsPy);
  artifactContentStore.set('art-02', laneDetectorPy);
  artifactContentStore.set('art-03', obstacleDiff);
  artifactContentStore.set('art-relay-clamp', relayClampPy);
  artifactContentStore.set('art-relay-acceptance', relayAcceptanceJson);

  const gate101Digest = sha256Hex(`gate-101:sub-03:${obstacleDiff}`).slice(0, 24);

  runLogsStore.set('run-101', [
    { logSeq: 1, timestamp: '2026-11-02T05:16:16.000Z', stream: 'system', text: '[Worktree] Checked out isolated branch hub/smartcar-01/sub-02-lane @ a4f92c1' },
    { logSeq: 2, timestamp: '2026-11-02T05:16:18.000Z', stream: 'stdout', text: '[Codex] thread.started: Loaded shared context from SUB-01 (art-01: src/vision/contracts.py)' },
    { logSeq: 3, timestamp: '2026-11-02T05:19:42.000Z', stream: 'stdout', text: '[Codex] Implemented perspective warp & sliding-window polynomial fit in src/vision/lane_detector.py' },
    { logSeq: 4, timestamp: '2026-11-02T05:27:55.000Z', stream: 'stdout', text: '[Validator] 8/8 unit tests passed in tests/test_lane_detector.py (avg latency: 4.8ms/frame)' },
    { logSeq: 5, timestamp: '2026-11-02T05:28:00.000Z', stream: 'system', text: '[Orchestrator] turn.completed + exitCode=0 -> status=succeeded.' }
  ]);

  runLogsStore.set('run-102', [
    { logSeq: 1, timestamp: '2026-11-02T05:16:21.000Z', stream: 'system', text: '[Worktree] Checked out isolated branch hub/smartcar-01/sub-03-obstacle @ a4f92c1' },
    { logSeq: 2, timestamp: '2026-11-02T05:22:10.000Z', stream: 'stdout', text: '[Codex] Implemented ObstacleDetector with HSV cone segmentation + homography distance' },
    { logSeq: 3, timestamp: '2026-11-02T05:31:04.000Z', stream: 'stderr', text: '[Validator] Low-light glare sample #14 caused false positive; triggering attempt=2 via exec resume' },
    { logSeq: 4, timestamp: '2026-11-02T05:39:18.000Z', stream: 'stdout', text: '[Codex] Applied CLAHE normalization: mAP@0.5 improved from 0.86 -> 0.94, distance MAE = 3.1%' },
    { logSeq: 5, timestamp: '2026-11-02T05:41:55.000Z', stream: 'system', text: `[ApprovalGate] Staged diff artifact art-03 for waiting_approval (gate-101, actionDigest=${gate101Digest}).` }
  ]);

  runLogsStore.set('run-202', [
    { logSeq: 1, timestamp: '2026-11-02T04:31:05.000Z', stream: 'system', text: '[Worktree] Checked out isolated branch hub/telemetry-02/sub-202-bench @ a4f92c1' },
    { logSeq: 2, timestamp: '2026-11-02T04:32:00.000Z', stream: 'stdout', text: '[Codex] Starting 10,000 fps CAN 2.0B frame stress benchmark...' },
    { logSeq: 3, timestamp: '2026-11-02T04:55:00.000Z', stream: 'stderr', text: '[Watchdog] Run run-202 exceeded timeoutMs=120000 waiting for vcan0 interface (TIMEOUT).' }
  ]);

  runLogsStore.set('run-relay-real', [
    { logSeq: 1, timestamp: '2026-11-02T05:00:05.000Z', stream: 'system', text: '[Historical Real Evidence] Developer session 01a19ad1-2021-7f92-9454-108378e8ace6 generated clamp.py' },
    { logSeq: 2, timestamp: '2026-11-02T05:00:12.000Z', stream: 'stderr', text: '[Fault Injected] Coordinator injected missing lower > upper guard -> acceptance.py exitCode=1' },
    { logSeq: 3, timestamp: '2026-11-02T05:00:25.000Z', stream: 'stdout', text: '[Reviewer B] Session 01a19ad1-36b6-7ab1-9d83-e3ae84bd1909 rejected artifact and reported bound check defect' },
    { logSeq: 4, timestamp: '2026-11-02T05:00:38.000Z', stream: 'stdout', text: '[Developer A] Resumed session 01a19ad1-2021-7f92-9454-108378e8ace6 and repaired ValueError guard' },
    { logSeq: 5, timestamp: '2026-11-02T05:00:45.000Z', stream: 'stdout', text: '[Acceptance] 5 acceptance cases passed (finalTestExit=0, reviewerRanTests=true)' }
  ]);

  return {
    meta: {
      contractVersion: '0.2',
      executionMode: 'mock',
      liveExecutionAvailable: false,
      enabledFeatures: [
        'dag-decompose-preview',
        'cas-version-control',
        'idempotency-key',
        'digest-bound-approvals',
        'sse-snapshot-replay',
        'b01-safe-runtime-guardrails',
        'historical-evidence-readonly'
      ]
    },
    repositories: [
      {
        id: 'repo-smartcar-vision',
        label: 'smartcar-vision (~/workspace/smartcar-vision)',
        baseBranch: 'main',
        baseCommit: 'a4f92c1'
      },
      {
        id: 'repo-agetor-b01',
        label: 'agetor-safe-runtime (codex/b01-b02-safe-runtime)',
        baseBranch: 'codex/b01-b02-safe-runtime',
        baseCommit: '5ebf2aa4'
      },
      {
        id: 'repo-real-relay-01',
        label: 'Codex/evidence/real-relay-01/workspace (Read-Only Evidence)',
        baseBranch: 'detached-evidence',
        baseCommit: '5ebf2aa4'
      }
    ],
    agents: [
      {
        id: 'agent-codex',
        version: 2,
        createdAt: '2026-11-02T04:00:00.000Z',
        updatedAt: '2026-11-02T05:42:00.000Z',
        executionMode: 'mock',
        label: 'OpenAI Codex CLI (Workspace-Write)',
        roleTitle: 'Lead Backend & Algorithm Engineer',
        adapterId: 'codex-cli',
        adapterVersion: '0.166.0-b01-hardened',
        availability: 'busy',
        capabilities: ['stream', 'resume', 'cancel', 'structured-output'],
        unsupportedReasons: {
          'live-context': 'codex exec 首版不支持运行中实时注入，补充上下文将排队至下一轮 (queued_next_turn / exec resume)'
        },
        supportedStages: ['analysis', 'implementation', 'testing'],
        permissionProfile: 'workspace-write (B-01: --ignore-user-config, writable_roots=[], network=false, no external .git)',
        maxConcurrency: 2
      },
      {
        id: 'agent-codex-reviewer',
        version: 1,
        createdAt: '2026-11-02T04:00:00.000Z',
        updatedAt: '2026-11-02T05:30:00.000Z',
        executionMode: 'mock',
        label: 'OpenAI Codex CLI (Read-Only Reviewer)',
        roleTitle: 'Independent Code Reviewer & QA Verifier',
        adapterId: 'codex-cli-ask',
        adapterVersion: '0.166.0-b01-hardened',
        availability: 'available',
        capabilities: ['stream', 'resume', 'cancel', 'structured-output'],
        unsupportedReasons: {
          'live-context': 'ask 模式只读审查按轮次执行，上下文指令排队至下一轮'
        },
        supportedStages: ['testing', 'review'],
        permissionProfile: 'read-only (B-01: allows external Git metadata inspection without escalation)',
        maxConcurrency: 2
      },
      {
        id: 'agent-antigravity',
        version: 1,
        createdAt: '2026-11-02T04:00:00.000Z',
        updatedAt: '2026-11-02T05:15:00.000Z',
        executionMode: 'mock',
        label: 'Google Antigravity (Collaborator / Mock Doc Role)',
        roleTitle: 'Chief Frontend / UI-UX & Browser Verification Collaborator',
        adapterId: 'antigravity-collaborator',
        adapterVersion: '2.0-collaborator',
        availability: 'available',
        capabilities: ['stream', 'resume', 'cancel', 'structured-output'],
        unsupportedReasons: {
          'live-context': '根据 alignment-v0.2 规定，Antigravity 是开发协作者，首版不封装为具备 live-context 的后台自动服务'
        },
        supportedStages: ['analysis', 'review', 'documentation'],
        permissionProfile: 'workspace-write (Mock Simulation Role Only)',
        maxConcurrency: 1
      },
      {
        id: 'agent-deepseek',
        version: 1,
        createdAt: '2026-11-02T04:00:00.000Z',
        updatedAt: '2026-11-02T04:00:00.000Z',
        executionMode: 'mock',
        label: 'DeepSeek Harness (P2 Candidate)',
        roleTitle: 'Candidate Optimizer (R-01 Pending Auth/Cost Verification)',
        adapterId: 'deepseek-harness',
        adapterVersion: '0.1.0-candidate',
        availability: 'disabled',
        capabilities: [],
        unsupportedReasons: {
          stream: 'B-01 默认关闭未授权 CLI 自动启用 (AGETOR_HARNESS_AUTO_ENABLE != 1)',
          resume: '留至 R-01 (P2) 预研后再决定是否启用',
          cancel: '适配器处于 disabled 状态',
          'live-context': '适配器处于 disabled 状态',
          'structured-output': '适配器处于 disabled 状态'
        },
        supportedStages: ['implementation'],
        permissionProfile: 'disabled (B-01 harnessAutoEnableActive=false)',
        maxConcurrency: 0
      }
    ],
    tasks: [
      {
        id: 'task-smartcar-01',
        version: 4,
        createdAt: '2026-11-02T05:10:00.000Z',
        updatedAt: '2026-11-02T05:42:00.000Z',
        executionMode: 'mock',
        provenance: 'current',
        title: '[MOCK 闭环演练] Python 智能车视觉识别系统（赛道识别 + 障碍物检测 + 测试与文档）',
        goal: '开发一个基于 Python 的智能车视觉识别系统，要求实现赛道识别、障碍物检测、测试验证，并生成完整开发文档。',
        repositoryId: 'repo-smartcar-vision',
        baseCommit: 'a4f92c1',
        status: 'waiting_approval',
        priority: 'high',
        progressPct: 60,
        pendingApprovalCount: 1,
        artifactCount: 3,
        acceptanceCriteria: [
          { id: 'ac-smartcar-1', description: '输出 FramePacket 与检测器接口契约', testProfileId: 'pytest-contracts' },
          { id: 'ac-smartcar-2', description: '赛道中心线横向误差 < 3.5cm，障碍物检测 mAP@0.5 >= 0.92', testProfileId: 'pytest-vision' },
          { id: 'ac-smartcar-3', description: '独立验证套件 exitCode=0 且生成完整开发文档', testProfileId: 'pytest-integration' }
        ],
        error: null,
        startedAt: '2026-11-02T05:10:05.000Z',
        endedAt: null,
        deadlineAt: '2026-11-02T08:10:00.000Z'
      },
      {
        id: 'task-telemetry-02',
        version: 3,
        createdAt: '2026-11-02T04:30:00.000Z',
        updatedAt: '2026-11-02T04:55:00.000Z',
        executionMode: 'mock',
        provenance: 'current',
        title: '[MOCK 故障恢复演练] 智能车 CAN 总线高速遥测帧解析与超时恢复',
        goal: '实现 500kbps CAN 总线传感器帧解析器，支持轮速与 IMU 同步校验及超时告警。',
        repositoryId: 'repo-smartcar-vision',
        baseCommit: 'a4f92c1',
        status: 'timed_out',
        priority: 'medium',
        progressPct: 50,
        pendingApprovalCount: 0,
        artifactCount: 0,
        acceptanceCriteria: [
          { id: 'ac-can-1', description: 'CAN 2.0B CRC-16 校验通过', testProfileId: 'pytest-can' },
          { id: 'ac-can-2', description: '10,000 fps 环形缓冲压测零丢包', testProfileId: 'pytest-can-stress' }
        ],
        error: {
          code: 'TIMEOUT',
          message: 'Subtask SUB-202 (CAN Frame Stress Benchmark) exceeded timeoutMs (120000ms) waiting for virtual vcan0 socket.',
          retryable: true,
          details: {
            subtaskId: 'sub-202',
            runId: 'run-202',
            attempt: 1,
            maxAttempts: 2,
            suggestedAction: 'Use Subtask Retry (POST /api/v1/subtasks/sub-202/retry) to spawn attempt #2.'
          },
          occurredAt: '2026-11-02T04:55:00.000Z'
        },
        startedAt: '2026-11-02T04:31:00.000Z',
        endedAt: '2026-11-02T04:55:00.000Z',
        deadlineAt: '2026-11-02T04:55:00.000Z'
      },
      {
        id: 'real-relay-01',
        version: 6,
        createdAt: '2026-11-02T05:00:00.000Z',
        updatedAt: '2026-11-02T05:30:00.000Z',
        executionMode: 'live',
        provenance: 'historical',
        title: '[CODEX 实测历史证据 · 只读] 双会话接力实现与独立验收 clamp(value, lower, upper)',
        goal: '由独立 Codex 开发会话 A 生成 clamp.py，注入反向边界缺陷 (initialTestExit=1)，经独立审核会话 B 拒绝后，通过 exec resume 修复并通过双方独立 Python 验收 (finalTestExit=0, 5 acceptance cases passed)。',
        repositoryId: 'repo-real-relay-01',
        baseCommit: '5ebf2aa4',
        status: 'succeeded',
        priority: 'high',
        progressPct: 100,
        pendingApprovalCount: 0,
        artifactCount: 2,
        acceptanceCriteria: [
          { id: 'ac-relay-1', description: 'Developer A 与 Reviewer B 使用独立真实 Codex CLI 会话', testProfileId: 'relay-session-audit' },
          { id: 'ac-relay-2', description: '注入缺陷触发 initialTestExit=1，通过 exec resume 修复后 finalTestExit=0', testProfileId: 'relay-acceptance-py' }
        ],
        error: null,
        startedAt: '2026-11-02T05:00:02.000Z',
        endedAt: '2026-11-02T05:30:00.000Z',
        deadlineAt: null
      }
    ],
    subtasks: [
      {
        id: 'sub-01',
        version: 2,
        createdAt: '2026-11-02T05:10:00.000Z',
        updatedAt: '2026-11-02T05:16:00.000Z',
        executionMode: 'mock',
        taskId: 'task-smartcar-01',
        code: 'SUB-01',
        title: '系统架构设计与视觉流水线接口定义',
        description: '定义 FramePacket 数据结构、鸟瞰图逆透视变换参数与统一检测器接口 VisionDetectorProtocol。',
        stage: 'analysis',
        dependsOn: [],
        requiredCapabilities: ['stream', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-sub01-1', description: '输出 src/vision/contracts.py 包含类型注解' },
          { id: 'ac-sub01-2', description: '定义 640x480 @ 60FPS 帧处理延迟预算 (<15ms)' }
        ],
        status: 'succeeded',
        assignedAgentId: 'agent-codex',
        workspaceId: 'ws-smartcar-01-sub-01',
        branchName: 'hub/smartcar-01/sub-01-arch',
        progressPct: 100,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 180000,
        outputArtifactIds: ['art-01'],
        error: null
      },
      {
        id: 'sub-02',
        version: 2,
        createdAt: '2026-11-02T05:10:00.000Z',
        updatedAt: '2026-11-02T05:28:00.000Z',
        executionMode: 'mock',
        taskId: 'task-smartcar-01',
        code: 'SUB-02',
        title: '赛道识别模块（逆透视变换 + 滑动窗口车道线曲率拟合）',
        description: '实现 HLS/Sobel 双通道阈值分割、鸟瞰图透视变换与二阶多项式车道中心线偏航角计算。',
        stage: 'implementation',
        dependsOn: ['sub-01'],
        requiredCapabilities: ['stream', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-sub02-1', description: '急弯与十字环岛场景下中心线横向误差 < 3.5cm' },
          { id: 'ac-sub02-2', description: '单帧处理平均耗时 < 6.2ms' }
        ],
        status: 'succeeded',
        assignedAgentId: 'agent-codex',
        workspaceId: 'ws-smartcar-01-sub-02',
        branchName: 'hub/smartcar-01/sub-02-lane',
        progressPct: 100,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 180000,
        outputArtifactIds: ['art-02'],
        error: null
      },
      {
        id: 'sub-03',
        version: 3,
        createdAt: '2026-11-02T05:10:00.000Z',
        updatedAt: '2026-11-02T05:42:00.000Z',
        executionMode: 'mock',
        taskId: 'task-smartcar-01',
        code: 'SUB-03',
        title: '障碍物检测模块（轻量化目标检测 + 单目几何测距）',
        description: '识别赛道锥桶、横断路障与坡道标志，输出边界框置信度与基于地面单应性矩阵的纵向距离估计。',
        stage: 'review',
        dependsOn: ['sub-01'],
        requiredCapabilities: ['stream', 'resume', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-sub03-1', description: '锥桶与路障检测 mAP@0.5 >= 0.92' },
          { id: 'ac-sub03-2', description: '距离估算误差在 0.5m~3.0m 范围内 < 5%' }
        ],
        status: 'waiting_approval',
        assignedAgentId: 'agent-codex',
        workspaceId: 'ws-smartcar-01-sub-03',
        branchName: 'hub/smartcar-01/sub-03-obstacle',
        progressPct: 90,
        attempt: 2,
        maxAttempts: 3,
        timeoutMs: 180000,
        outputArtifactIds: ['art-03'],
        error: null
      },
      {
        id: 'sub-04',
        version: 1,
        createdAt: '2026-11-02T05:10:00.000Z',
        updatedAt: '2026-11-02T05:10:00.000Z',
        executionMode: 'mock',
        taskId: 'task-smartcar-01',
        code: 'SUB-04',
        title: '集成测试验证（协调器授权 Pytest 回归套件 + 帧率评测）',
        description: '合并 SUB-02 与 SUB-03 分支，由独立审查 Agent 与 Result Validator 运行授权测试脚本并生成覆盖率报告。',
        stage: 'testing',
        dependsOn: ['sub-02', 'sub-03'],
        requiredCapabilities: ['stream', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-sub04-1', description: 'Result Validator 运行授权 pytest exitCode=0' },
          { id: 'ac-sub04-2', description: '代码行覆盖率 >= 88%' }
        ],
        status: 'pending',
        assignedAgentId: 'agent-codex-reviewer',
        workspaceId: 'ws-smartcar-01-sub-04',
        branchName: 'hub/smartcar-01/sub-04-verify',
        progressPct: 0,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 180000,
        outputArtifactIds: [],
        error: null
      },
      {
        id: 'sub-05',
        version: 1,
        createdAt: '2026-11-02T05:10:00.000Z',
        updatedAt: '2026-11-02T05:10:00.000Z',
        executionMode: 'mock',
        taskId: 'task-smartcar-01',
        code: 'SUB-05',
        title: '完整开发文档与实车标定指南生成',
        description: '汇总系统架构图、API 手册、相机内参标定流程与测试基准报告，生成可交付的 Markdown 文档集。',
        stage: 'documentation',
        dependsOn: ['sub-04'],
        requiredCapabilities: ['structured-output'],
        acceptanceCriteria: [
          { id: 'ac-sub05-1', description: '包含模块架构图、接口签名说明、标定步骤与故障排查章节' }
        ],
        status: 'pending',
        assignedAgentId: 'agent-antigravity',
        workspaceId: 'ws-smartcar-01-sub-05',
        branchName: 'hub/smartcar-01/sub-05-docs',
        progressPct: 0,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 180000,
        outputArtifactIds: [],
        error: null
      },
      {
        id: 'sub-201',
        version: 2,
        createdAt: '2026-11-02T04:30:00.000Z',
        updatedAt: '2026-11-02T04:35:00.000Z',
        executionMode: 'mock',
        taskId: 'task-telemetry-02',
        code: 'SUB-201',
        title: 'CAN 2.0B DBC 报文协议解析定义',
        description: '定义 0x101 轮速编码器与 0x102 六轴 IMU 报文解包结构体。',
        stage: 'analysis',
        dependsOn: [],
        requiredCapabilities: ['stream'],
        acceptanceCriteria: [{ id: 'ac-sub201-1', description: 'CRC-16 校验通过' }],
        status: 'succeeded',
        assignedAgentId: 'agent-codex',
        workspaceId: 'ws-telemetry-02-sub-201',
        branchName: 'hub/telemetry-02/sub-201-dbc',
        progressPct: 100,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 120000,
        outputArtifactIds: [],
        error: null
      },
      {
        id: 'sub-202',
        version: 2,
        createdAt: '2026-11-02T04:30:00.000Z',
        updatedAt: '2026-11-02T04:55:00.000Z',
        executionMode: 'mock',
        taskId: 'task-telemetry-02',
        code: 'SUB-202',
        title: '高并发 CAN 帧环形缓冲压测验证',
        description: '模拟 10,000 帧/秒突发流量下的零丢包解析能力。',
        stage: 'testing',
        dependsOn: ['sub-201'],
        requiredCapabilities: ['stream', 'resume'],
        acceptanceCriteria: [{ id: 'ac-sub202-1', description: '连续 60s 压测丢包率 = 0%' }],
        status: 'timed_out',
        assignedAgentId: 'agent-codex',
        workspaceId: 'ws-telemetry-02-sub-202',
        branchName: 'hub/telemetry-02/sub-202-bench',
        progressPct: 45,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 120000,
        outputArtifactIds: [],
        error: {
          code: 'TIMEOUT',
          message: 'Subtask SUB-202 exceeded timeoutMs (120000ms) waiting for kernel vcan0 interface.',
          retryable: true,
          details: { attempt: 1, maxAttempts: 2, rawExitCode: 124 },
          occurredAt: '2026-11-02T04:55:00.000Z'
        }
      },
      {
        id: 'relay-sub-1',
        version: 2,
        createdAt: '2026-11-02T05:00:00.000Z',
        updatedAt: '2026-11-02T05:10:00.000Z',
        executionMode: 'live',
        taskId: 'real-relay-01',
        code: 'RELAY-01',
        title: 'Developer Session A (01a19ad1-2021...) 生成 clamp.py 与故障注入验证',
        description: '真实调用 codex exec 生成 clamp.py；协调器注入反向边界缺陷后运行 acceptance.py 得到 initialTestExit=1。',
        stage: 'implementation',
        dependsOn: [],
        requiredCapabilities: ['stream', 'resume'],
        acceptanceCriteria: [
          { id: 'ac-relay-sub1', description: 'AST 白名单校验通过，故障注入触发 initialTestExit=1' }
        ],
        status: 'succeeded',
        assignedAgentId: 'agent-codex',
        workspaceId: 'ws-real-relay-01',
        branchName: 'real-relay-01',
        progressPct: 100,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 120000,
        outputArtifactIds: ['art-relay-clamp'],
        error: null
      },
      {
        id: 'relay-sub-2',
        version: 2,
        createdAt: '2026-11-02T05:10:00.000Z',
        updatedAt: '2026-11-02T05:22:00.000Z',
        executionMode: 'live',
        taskId: 'real-relay-01',
        code: 'RELAY-02',
        title: 'Reviewer Session B (01a19ad1-36b6...) 独立审查并经 exec resume 修复',
        description: '独立会话 B 接收代码与失败输出，指出 lower > upper 边界缺陷；协调器通过 exec resume 驱动会话 A 完成修复。',
        stage: 'review',
        dependsOn: ['relay-sub-1'],
        requiredCapabilities: ['stream', 'resume'],
        acceptanceCriteria: [
          { id: 'ac-relay-sub2', description: 'independentSessions=true 且 repairUsedResume=true' }
        ],
        status: 'succeeded',
        assignedAgentId: 'agent-codex-reviewer',
        workspaceId: 'ws-real-relay-01',
        branchName: 'real-relay-01',
        progressPct: 100,
        attempt: 2,
        maxAttempts: 2,
        timeoutMs: 120000,
        outputArtifactIds: ['art-relay-clamp'],
        error: null
      },
      {
        id: 'relay-sub-3',
        version: 2,
        createdAt: '2026-11-02T05:22:00.000Z',
        updatedAt: '2026-11-02T05:30:00.000Z',
        executionMode: 'live',
        taskId: 'real-relay-01',
        code: 'RELAY-03',
        title: '协调器与 Reviewer B 独立执行 acceptance.py 验收通过',
        description: '验证 5 acceptance cases passed, finalTestExit=0, reviewerRanTests=true。',
        stage: 'testing',
        dependsOn: ['relay-sub-2'],
        requiredCapabilities: ['stream'],
        acceptanceCriteria: [
          { id: 'ac-relay-sub3', description: 'finalTestExit=0 且 5 acceptance cases passed' }
        ],
        status: 'succeeded',
        assignedAgentId: 'agent-codex-reviewer',
        workspaceId: 'ws-real-relay-01',
        branchName: 'real-relay-01',
        progressPct: 100,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 120000,
        outputArtifactIds: ['art-relay-acceptance'],
        error: null
      }
    ],
    runs: [
      {
        id: 'run-101',
        version: 2,
        createdAt: '2026-11-02T05:16:15.000Z',
        updatedAt: '2026-11-02T05:28:00.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-02',
        agentId: 'agent-codex',
        status: 'succeeded',
        attempt: 1,
        providerSessionId: 'mock-session-codex-101',
        workspaceId: 'ws-smartcar-01-sub-02',
        startedAt: '2026-11-02T05:16:15.000Z',
        endedAt: '2026-11-02T05:28:00.000Z',
        exitCode: 0,
        error: null
      },
      {
        id: 'run-102',
        version: 3,
        createdAt: '2026-11-02T05:16:20.000Z',
        updatedAt: '2026-11-02T05:41:55.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-03',
        agentId: 'agent-codex',
        status: 'succeeded',
        attempt: 2,
        providerSessionId: 'mock-session-codex-102',
        workspaceId: 'ws-smartcar-01-sub-03',
        startedAt: '2026-11-02T05:16:20.000Z',
        endedAt: '2026-11-02T05:41:55.000Z',
        exitCode: 0,
        error: null
      },
      {
        id: 'run-202',
        version: 2,
        createdAt: '2026-11-02T04:31:00.000Z',
        updatedAt: '2026-11-02T04:55:00.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-telemetry-02',
        subtaskId: 'sub-202',
        agentId: 'agent-codex',
        status: 'timed_out',
        attempt: 1,
        providerSessionId: 'mock-session-codex-202',
        workspaceId: 'ws-telemetry-02-sub-202',
        startedAt: '2026-11-02T04:31:00.000Z',
        endedAt: '2026-11-02T04:55:00.000Z',
        exitCode: 124,
        error: {
          code: 'TIMEOUT',
          message: 'Run run-202 exceeded timeoutMs (120000ms) waiting for vcan0.',
          retryable: true,
          occurredAt: '2026-11-02T04:55:00.000Z'
        }
      },
      {
        id: 'run-relay-real',
        version: 4,
        createdAt: '2026-11-02T05:00:02.000Z',
        updatedAt: '2026-11-02T05:30:00.000Z',
        executionMode: 'live',
        provenance: 'historical',
        taskId: 'real-relay-01',
        subtaskId: 'relay-sub-3',
        agentId: 'agent-codex',
        status: 'succeeded',
        attempt: 2,
        providerSessionId: '01a19ad1-36b6-7ab1-9d83-e3ae84bd1909',
        workspaceId: 'ws-real-relay-01',
        startedAt: '2026-11-02T05:00:02.000Z',
        endedAt: '2026-11-02T05:30:00.000Z',
        exitCode: 0,
        error: null
      }
    ],
    validations: [
      {
        id: 'val-101',
        version: 1,
        createdAt: '2026-11-02T05:27:55.000Z',
        updatedAt: '2026-11-02T05:27:55.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-02',
        runId: 'run-101',
        criterionId: 'ac-sub02-1',
        status: 'passed',
        exitCode: 0,
        evidenceArtifactIds: ['art-02']
      },
      {
        id: 'val-102',
        version: 1,
        createdAt: '2026-11-02T05:41:50.000Z',
        updatedAt: '2026-11-02T05:41:50.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-03',
        runId: 'run-102',
        criterionId: 'ac-sub03-1',
        status: 'passed',
        exitCode: 0,
        evidenceArtifactIds: ['art-03']
      },
      {
        id: 'val-relay-01',
        version: 1,
        createdAt: '2026-11-02T05:30:00.000Z',
        updatedAt: '2026-11-02T05:30:00.000Z',
        executionMode: 'live',
        provenance: 'historical',
        taskId: 'real-relay-01',
        subtaskId: 'relay-sub-3',
        runId: 'run-relay-real',
        criterionId: 'ac-relay-2',
        status: 'passed',
        exitCode: 0,
        evidenceArtifactIds: ['art-relay-acceptance', 'art-relay-clamp']
      }
    ],
    messages: [
      {
        id: 'msg-01',
        version: 1,
        createdAt: '2026-11-02T05:10:08.000Z',
        updatedAt: '2026-11-02T05:10:08.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        fromRunId: null,
        toSubtaskId: 'sub-01',
        fromLabel: 'Orchestrator Planner',
        toLabel: 'SUB-01 (System Architecture)',
        summary: '自动拆解任务为 5 个具有 DAG 依赖关系的子任务（SUB-01 ~ SUB-05）',
        content: '已完成自然语言需求解析：\n1. SUB-01 (架构与接口契约) -> Codex CLI\n2. SUB-02 (赛道识别) & SUB-03 (障碍物检测) 独立 Workspace 分支实现 -> Codex CLI\n3. SUB-04 (Pytest 集成验证) 依赖 SUB-02 + SUB-03 -> Codex Read-Only Reviewer\n4. SUB-05 (完整开发文档交付) 依赖 SUB-04 -> Antigravity Collaborator',
        kind: 'task_decomposition',
        correlationId: 'corr-smartcar-01',
        causationId: null,
        artifactRefs: ['art-01'],
        deliveredAt: '2026-11-02T05:10:08.000Z'
      },
      {
        id: 'msg-02',
        version: 1,
        createdAt: '2026-11-02T05:16:02.000Z',
        updatedAt: '2026-11-02T05:16:02.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        fromRunId: 'run-101',
        toSubtaskId: 'sub-03',
        fromLabel: 'OpenAI Codex CLI (run-101)',
        toLabel: 'SUB-03 (Obstacle Detection)',
        summary: 'SUB-01/SUB-02 完成：发布不可变产物 src/vision/contracts.py (SHA-256 已校验)',
        content: '已在分支 `hub/smartcar-01/sub-01-arch` 产出 `src/vision/contracts.py`。下游 `SUB-02` 与 `SUB-03` 通过不可变 `artifactRefs: ["art-01"]` 引用该契约。',
        kind: 'context_handoff',
        correlationId: 'corr-smartcar-01',
        causationId: 'msg-01',
        artifactRefs: ['art-01', 'art-02'],
        deliveredAt: '2026-11-02T05:16:02.000Z'
      },
      {
        id: 'msg-03',
        version: 1,
        createdAt: '2026-11-02T05:41:56.000Z',
        updatedAt: '2026-11-02T05:41:56.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        fromRunId: 'run-102',
        toSubtaskId: 'sub-03',
        fromLabel: 'OpenAI Codex CLI (run-102)',
        toLabel: 'Human Reviewer (Gate #gate-101)',
        summary: `SUB-03 障碍物检测进入 waiting_approval，请求审批 Gate #gate-101 (actionDigest=${gate101Digest})`,
        content: '已补充 CLAHE 自适应直方图均衡化预处理，mAP@0.5 提升至 0.94。请审核 `patches/sub-03-obstacle-detector.diff`；审批决定仅限 approve 或 reject，若需返工请调用独立 Subtask Rework 接口。',
        kind: 'approval_request',
        correlationId: 'corr-smartcar-01',
        causationId: 'msg-02',
        artifactRefs: ['art-03'],
        deliveredAt: '2026-11-02T05:41:56.000Z'
      },
      {
        id: 'msg-relay-01',
        version: 1,
        createdAt: '2026-11-02T05:25:00.000Z',
        updatedAt: '2026-11-02T05:25:00.000Z',
        executionMode: 'live',
        provenance: 'historical',
        taskId: 'real-relay-01',
        fromRunId: 'run-relay-real',
        toSubtaskId: 'relay-sub-3',
        fromLabel: 'Reviewer Session B (01a19ad1-36b6)',
        toLabel: 'Developer Session A (01a19ad1-2021)',
        summary: '[真实 CLI 历史记录] Reviewer B 检出 lower > upper 缺陷并经 exec resume 完成修复验证',
        content: '真实双 Codex 会话接力验证记录：initialTestExit=1 -> Reviewer B 审查打回 -> Developer A exec resume 修复 -> 协调器与 Reviewer B 独立运行 acceptance.py (finalTestExit=0)。',
        kind: 'review_feedback',
        correlationId: 'corr-real-relay-01',
        causationId: null,
        artifactRefs: ['art-relay-clamp', 'art-relay-acceptance'],
        deliveredAt: '2026-11-02T05:25:00.000Z'
      }
    ],
    approvals: [
      {
        id: 'gate-101',
        version: 1,
        createdAt: '2026-11-02T05:41:55.000Z',
        updatedAt: '2026-11-02T05:41:55.000Z',
        executionMode: 'mock',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-03',
        runId: 'run-102',
        actionType: 'code_diff_review',
        actionDigest: gate101Digest,
        summary: '审核 SUB-03：障碍物检测与单目几何测距模块代码变更 (CLAHE 光照归一化 + 单应性矩阵测距)',
        status: 'pending',
        expiresAt: '2026-11-05T05:41:55.000Z',
        artifactRefs: ['art-03'],
        diffArtifactId: 'art-03',
        decidedAt: null,
        decidedBy: null
      }
    ],
    artifacts: [
      {
        id: 'art-01',
        version: 1,
        createdAt: '2026-11-02T05:15:58.000Z',
        updatedAt: '2026-11-02T05:15:58.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-01',
        producerRunId: 'run-101',
        name: 'contracts.py',
        relativePath: 'src/vision/contracts.py',
        sha256: sha256Hex(contractsPy),
        sizeBytes: Buffer.byteLength(contractsPy, 'utf8'),
        mimeType: 'text/x-python',
        category: 'code',
        validationStatus: 'validated'
      },
      {
        id: 'art-02',
        version: 1,
        createdAt: '2026-11-02T05:27:50.000Z',
        updatedAt: '2026-11-02T05:27:50.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-02',
        producerRunId: 'run-101',
        name: 'lane_detector.py',
        relativePath: 'src/vision/lane_detector.py',
        sha256: sha256Hex(laneDetectorPy),
        sizeBytes: Buffer.byteLength(laneDetectorPy, 'utf8'),
        mimeType: 'text/x-python',
        category: 'code',
        validationStatus: 'validated',
        diffStats: { filesChanged: 2, insertions: 134, deletions: 0 }
      },
      {
        id: 'art-03',
        version: 1,
        createdAt: '2026-11-02T05:41:50.000Z',
        updatedAt: '2026-11-02T05:41:50.000Z',
        executionMode: 'mock',
        provenance: 'current',
        taskId: 'task-smartcar-01',
        subtaskId: 'sub-03',
        producerRunId: 'run-102',
        name: 'sub-03-obstacle-detector.diff',
        relativePath: 'patches/sub-03-obstacle-detector.diff',
        sha256: sha256Hex(obstacleDiff),
        sizeBytes: Buffer.byteLength(obstacleDiff, 'utf8'),
        mimeType: 'text/x-diff',
        category: 'diff',
        validationStatus: 'staged',
        diffStats: { filesChanged: 2, insertions: 86, deletions: 4 },
        testSummary: { total: 18, passed: 18, failed: 0, coveragePct: 91.4 }
      },
      {
        id: 'art-relay-clamp',
        version: 1,
        createdAt: '2026-11-02T05:28:00.000Z',
        updatedAt: '2026-11-02T05:28:00.000Z',
        executionMode: 'live',
        provenance: 'historical',
        taskId: 'real-relay-01',
        subtaskId: 'relay-sub-2',
        producerRunId: 'run-relay-real',
        name: 'clamp.py',
        relativePath: 'workspace/clamp.py',
        sha256: '06bdec88381be5255a3a5b9735b15011adc5857a54141260df7c74ef700e55f5',
        sizeBytes: Buffer.byteLength(relayClampPy, 'utf8'),
        mimeType: 'text/x-python',
        category: 'code',
        validationStatus: 'validated'
      },
      {
        id: 'art-relay-acceptance',
        version: 1,
        createdAt: '2026-11-02T05:30:00.000Z',
        updatedAt: '2026-11-02T05:30:00.000Z',
        executionMode: 'live',
        provenance: 'historical',
        taskId: 'real-relay-01',
        subtaskId: 'relay-sub-3',
        producerRunId: 'run-relay-real',
        name: 'acceptance.json',
        relativePath: 'acceptance.json',
        sha256: 'a2238d4bfffe10a6dca8856b202a11bf58643136fd2f3681aacbb2d82cb3ab02',
        sizeBytes: Buffer.byteLength(relayAcceptanceJson, 'utf8'),
        mimeType: 'application/json',
        category: 'test_report',
        validationStatus: 'validated',
        testSummary: { total: 5, passed: 5, failed: 0, coveragePct: 100 }
      }
    ]
  };
}

let state = createInitialState();

function makePage(allItems, searchParams, defaultLimit = 20, maxLimit = 100) {
  const rawLimit = searchParams.get('limit');
  let limit = defaultLimit;
  if (rawLimit !== null && rawLimit !== '') {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
      return { error: `limit must be an integer between 1 and ${maxLimit}` };
    }
    limit = parsed;
  }

  const cursor = searchParams.get('cursor');
  let startIndex = 0;
  if (cursor !== null && cursor !== '') {
    const idx = allItems.findIndex((item) => item.id === cursor);
    if (idx === -1) {
      return { error: `Invalid or unknown pagination cursor: ${cursor}` };
    }
    startIndex = idx + 1;
  }

  const slice = allItems.slice(startIndex, startIndex + limit);
  const nextCursor =
    startIndex + limit < allItems.length && slice.length > 0
      ? slice[slice.length - 1].id
      : null;

  return {
    page: {
      items: slice,
      nextCursor
    }
  };
}

function buildTaskDetail(taskId, pageLimit = 20) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const subtasks = state.subtasks.filter((s) => s.taskId === taskId);
  const taskRuns = state.runs.filter((r) => r.taskId === taskId);
  const taskValidations = state.validations.filter((v) => v.taskId === taskId);
  const taskApprovals = state.approvals.filter((a) => a.taskId === taskId);
  const taskArtifacts = state.artifacts.filter((a) => a.taskId === taskId);

  const slicePage = (arr) => ({
    items: arr.slice(0, pageLimit),
    nextCursor: arr.length > pageLimit ? arr[pageLimit - 1].id : null
  });

  return {
    task,
    subtasks,
    runs: slicePage(taskRuns),
    validations: slicePage(taskValidations),
    approvals: slicePage(taskApprovals),
    artifacts: slicePage(taskArtifacts)
  };
}

function buildSnapshot(selectedTaskId = null) {
  const targetId = selectedTaskId || state.tasks[0]?.id || null;
  return {
    schemaVersion: '0.2',
    snapshotSeq: globalSeq,
    tasks: {
      items: state.tasks.slice(0, 20),
      nextCursor: state.tasks.length > 20 ? state.tasks[19].id : null
    },
    agents: {
      items: state.agents.slice(0, 20),
      nextCursor: state.agents.length > 20 ? state.agents[19].id : null
    },
    selectedTask: targetId ? buildTaskDetail(targetId) : null
  };
}

function emitEvent(type, payload, opts = {}) {
  globalSeq += 1;
  const envelope = {
    schemaVersion: '0.2',
    seq: globalSeq,
    type,
    timestamp: nowIso(),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    payload
  };

  eventOutbox.push(envelope);
  if (eventOutbox.length > MAX_OUTBOX) {
    eventOutbox.shift();
  }

  const frame = `id: ${envelope.seq}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
  for (const client of sseClients) {
    if (client.taskId && envelope.taskId && client.taskId !== envelope.taskId) {
      continue;
    }
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
  return envelope;
}

function recomputeTaskAggregates(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || task.provenance === 'historical') return;
  const subs = state.subtasks.filter((s) => s.taskId === taskId);
  if (subs.length > 0) {
    const sum = subs.reduce((acc, s) => acc + (s.progressPct || 0), 0);
    task.progressPct = Math.round(sum / subs.length);
  }
  task.pendingApprovalCount = state.approvals.filter(
    (a) => a.taskId === taskId && a.status === 'pending'
  ).length;
  task.artifactCount = state.artifacts.filter((a) => a.taskId === taskId).length;
  task.version = (task.version || 1) + 1;
  task.updatedAt = nowIso();
}

function checkTaskCompletionGate(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || task.provenance === 'historical') return false;
  const subs = state.subtasks.filter((s) => s.taskId === taskId);
  if (subs.length === 0) return false;

  const allSubsSucceeded = subs.every((s) => s.status === 'succeeded');
  const pendingApprovals = state.approvals.filter(
    (a) => a.taskId === taskId && a.status === 'pending'
  );
  const taskArtifacts = state.artifacts.filter((a) => a.taskId === taskId);
  const allArtifactsValid =
    taskArtifacts.length > 0 &&
    taskArtifacts.every((a) => a.sha256 && a.validationStatus === 'validated');
  const taskValidations = state.validations.filter((v) => v.taskId === taskId);
  const hasPassingValidation =
    taskValidations.length > 0 &&
    taskValidations.every((v) => v.status === 'passed' && v.exitCode === 0);

  if (allSubsSucceeded && pendingApprovals.length === 0 && allArtifactsValid && hasPassingValidation) {
    task.status = 'succeeded';
    task.progressPct = 100;
    task.endedAt = nowIso();
    task.error = null;
    recomputeTaskAggregates(taskId);
    return true;
  }
  return false;
}

function buildDraftPlannedSubtasks(goal, repositoryId) {
  const isSmartCar = /智能车|视觉|赛道|障碍物|vision|lane/i.test(goal);
  if (isSmartCar) {
    return [
      {
        id: 'plan-sub-01',
        code: 'SUB-01',
        title: '系统架构设计与视觉流水线接口定义',
        description: `针对仓库 ${repositoryId} 定义 FramePacket 数据结构与 VisionDetectorProtocol 接口契约。`,
        stage: 'analysis',
        dependsOn: [],
        requiredCapabilities: ['stream', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-plan-1', description: '定义 FramePacket 与检测器接口契约' },
          { id: 'ac-plan-2', description: '明确 60FPS 实时延迟预算 (<15ms)' }
        ]
      },
      {
        id: 'plan-sub-02',
        code: 'SUB-02',
        title: '赛道识别模块（逆透视变换与曲率拟合）',
        description: '实现 HLS/Sobel 双通道分割、鸟瞰图逆透视变换与滑动窗口曲率拟合。',
        stage: 'implementation',
        dependsOn: ['plan-sub-01'],
        requiredCapabilities: ['stream', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-plan-3', description: '中心线横向误差 < 3.5cm' }
        ]
      },
      {
        id: 'plan-sub-03',
        code: 'SUB-03',
        title: '障碍物检测模块（锥桶/路障识别与单目测距）',
        description: '实现 CLAHE 光照归一化与单应性地面测距。',
        stage: 'implementation',
        dependsOn: ['plan-sub-01'],
        requiredCapabilities: ['stream', 'resume', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-plan-4', description: 'mAP@0.5 >= 0.92 且距离估算误差 < 5%' }
        ]
      },
      {
        id: 'plan-sub-04',
        code: 'SUB-04',
        title: '集成测试验证（协调器运行 Pytest 回归套件与帧率评测）',
        description: '合并并行分支并由独立只读审查 Agent 与协调器运行验收脚本。',
        stage: 'testing',
        dependsOn: ['plan-sub-02', 'plan-sub-03'],
        requiredCapabilities: ['stream', 'structured-output'],
        acceptanceCriteria: [
          { id: 'ac-plan-5', description: 'Pytest 用例 100% 通过 (exitCode=0)' }
        ]
      },
      {
        id: 'plan-sub-05',
        code: 'SUB-05',
        title: '完整开发文档与实车标定指南生成',
        description: '生成系统架构说明、API 手册与测试报告归档。',
        stage: 'documentation',
        dependsOn: ['plan-sub-04'],
        requiredCapabilities: ['structured-output'],
        acceptanceCriteria: [
          { id: 'ac-plan-6', description: '输出完整 Markdown 开发文档与标定指南' }
        ]
      }
    ];
  }

  return [
    {
      id: 'plan-sub-01',
      code: 'SUB-01',
      title: '需求目标解析与模块接口契约设计',
      description: `绑定仓库 ${repositoryId}，输出模块边界与数据结构定义。`,
      stage: 'analysis',
      dependsOn: [],
      requiredCapabilities: ['stream', 'structured-output'],
      acceptanceCriteria: [{ id: 'ac-gen-1', description: '输出接口契约定义' }]
    },
    {
      id: 'plan-sub-02',
      code: 'SUB-02',
      title: '核心业务逻辑与算法模块实现',
      description: '在受控 Workspace 分支完成核心代码实现。',
      stage: 'implementation',
      dependsOn: ['plan-sub-01'],
      requiredCapabilities: ['stream', 'resume'],
      acceptanceCriteria: [{ id: 'ac-gen-2', description: '完成核心模块编码' }]
    },
    {
      id: 'plan-sub-03',
      code: 'SUB-03',
      title: '自动化单元测试与集成质量审核',
      description: '运行独立验收套件并校验产物 SHA-256。',
      stage: 'testing',
      dependsOn: ['plan-sub-02'],
      requiredCapabilities: ['stream'],
      acceptanceCriteria: [{ id: 'ac-gen-3', description: '独立测试 exitCode=0' }]
    },
    {
      id: 'plan-sub-04',
      code: 'SUB-04',
      title: '项目交付文档与变更总结生成',
      description: '生成 README 与完整交付说明。',
      stage: 'documentation',
      dependsOn: ['plan-sub-03'],
      requiredCapabilities: ['structured-output'],
      acceptanceCriteria: [{ id: 'ac-gen-4', description: '生成完整开发文档' }]
    }
  ];
}

function validateDagSubtasks(plannedSubtasks) {
  if (!Array.isArray(plannedSubtasks) || plannedSubtasks.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'plannedSubtasks must be a non-empty array' };
  }
  if (plannedSubtasks.length > 100) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: `Task cannot exceed 100 subtasks in v0.2 (received ${plannedSubtasks.length})`
    };
  }
  const idSet = new Set();
  for (const s of plannedSubtasks) {
    if (!s.id || !s.code || !s.title || !s.stage) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Each PlannedSubtask requires id, code, title, stage' };
    }
    if (idSet.has(s.id)) {
      return { ok: false, code: 'INVALID_INPUT', message: `Duplicate subtask id: ${s.id}` };
    }
    idSet.add(s.id);
  }
  for (const s of plannedSubtasks) {
    for (const dep of s.dependsOn || []) {
      if (!idSet.has(dep)) {
        return { ok: false, code: 'INVALID_INPUT', message: `Subtask ${s.id} depends on unknown subtask ${dep}` };
      }
    }
  }
  // Cycle detection via DFS
  const visiting = new Set();
  const visited = new Set();
  const map = new Map(plannedSubtasks.map((s) => [s.id, s]));
  function dfs(nodeId) {
    if (visiting.has(nodeId)) return false;
    if (visited.has(nodeId)) return true;
    visiting.add(nodeId);
    const node = map.get(nodeId);
    for (const dep of node?.dependsOn || []) {
      if (!dfs(dep)) return false;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return true;
  }
  for (const s of plannedSubtasks) {
    if (!dfs(s.id)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'PlannedSubtasks contain a dependency cycle (DAG required)' };
    }
  }
  return { ok: true };
}

function validateAllowedKeys(body, allowedKeys, requiredKeys = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return `Unknown or disallowed control field in request JSON: "${key}"`;
    }
  }
  for (const reqKey of requiredKeys) {
    if (body[reqKey] === undefined || body[reqKey] === null || body[reqKey] === '') {
      return `Missing required field: "${reqKey}"`;
    }
  }
  return null;
}

function sendData(res, statusCode, data, origin = 'http://127.0.0.1:4320', requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin
  });
  res.end(JSON.stringify({ data, requestId }));
}

function sendError(res, statusCode, code, message, retryable = false, details = undefined, origin = 'http://127.0.0.1:4320') {
  const errorObj = {
    code,
    message,
    retryable,
    occurredAt: nowIso(),
    ...(details ? { details } : {})
  };
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin
  });
  res.end(
    JSON.stringify({
      error: errorObj,
      requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    })
  );
}

function checkIdempotency(req, res, scopeKey, body, origin) {
  const idemKey = req.headers['idempotency-key'];
  if (!idemKey || typeof idemKey !== 'string' || !idemKey.trim()) {
    sendError(
      res,
      400,
      'INVALID_INPUT',
      'Mutating POST endpoints require a non-empty Idempotency-Key header.',
      false,
      undefined,
      origin
    );
    return { handled: true };
  }
  const compositeKey = `${scopeKey}:${idemKey.trim()}`;
  const payloadHash = sha256Hex(canonicalizeJson(body));
  const existing = idempotencyStore.get(compositeKey);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      sendError(
        res,
        409,
        'CONFLICT',
        `Idempotency-Key "${idemKey}" was already used with a different request payload for ${scopeKey}.`,
        false,
        { scopeKey, idempotencyKey: idemKey },
        origin
      );
      return { handled: true };
    }
    sendData(res, existing.statusCode, existing.data, origin, existing.requestId);
    return { handled: true };
  }
  return {
    handled: false,
    commit(statusCode, data) {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      idempotencyStore.set(compositeKey, {
        payloadHash,
        statusCode,
        data,
        requestId
      });
      sendData(res, statusCode, data, origin, requestId);
    }
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function advanceMockStep(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return { error: { status: 404, code: 'NOT_FOUND', message: 'Task not found' } };
  if (task.provenance === 'historical') {
    return {
      error: {
        status: 409,
        code: 'UNSUPPORTED_TRANSITION',
        message: 'Historical real CLI evidence (real-relay-01) is read-only and cannot be mutated or stepped in Mock.'
      }
    };
  }

  if (task.status === 'pausing') {
    task.status = 'paused';
    recomputeTaskAggregates(task.id);
    emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });
    return { result: { transition: 'pausing -> paused', task } };
  }

  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.endedAt = nowIso();
    const activeRuns = state.runs.filter(
      (r) => r.taskId === task.id && ['running', 'starting', 'queued', 'cancelling'].includes(r.status)
    );
    for (const r of activeRuns) {
      r.status = 'cancelled';
      r.endedAt = nowIso();
      r.version += 1;
      r.updatedAt = nowIso();
      const logs = runLogsStore.get(r.id) || [];
      const drainedLine = {
        logSeq: logs.length + 1,
        timestamp: nowIso(),
        stream: 'stdout',
        text: '[Drained post-cancel] Late stdout flushed with drained=true; terminal status remains cancelled.',
        drained: true
      };
      logs.push(drainedLine);
      runLogsStore.set(r.id, logs);
      emitEvent('run.output', { ...drainedLine, runId: r.id, line: drainedLine }, { taskId: task.id, runId: r.id });
      emitEvent('run.updated', { run: r }, { taskId: task.id, runId: r.id, version: r.version });
    }
    const activeSubs = state.subtasks.filter(
      (s) => s.taskId === task.id && ['pending', 'ready', 'running', 'validating', 'waiting_approval', 'retry_wait'].includes(s.status)
    );
    for (const s of activeSubs) {
      s.status = 'cancelled';
      s.version += 1;
      s.updatedAt = nowIso();
      emitEvent('subtask.updated', { subtask: s }, { taskId: task.id, version: s.version });
    }
    recomputeTaskAggregates(task.id);
    emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });
    return { result: { transition: 'cancelling -> cancelled', task } };
  }

  if (task.status === 'queued') {
    task.status = 'running';
    if (!task.startedAt) task.startedAt = nowIso();
  }

  const subs = state.subtasks.filter((s) => s.taskId === task.id);
  let targetSub = subs.find((s) => ['running', 'validating', 'ready', 'retry_wait'].includes(s.status));
  if (!targetSub) {
    targetSub = subs.find((s) => {
      if (s.status !== 'pending' && s.status !== 'blocked') return false;
      return s.dependsOn.every((depId) => {
        const dep = subs.find((x) => x.id === depId);
        return dep && dep.status === 'succeeded';
      });
    });
  }

  if (!targetSub) {
    return {
      result: {
        transition: 'noop',
        reason: 'No ready/running subtask available to advance (check pending approvals or terminal state).',
        task
      }
    };
  }

  targetSub.status = 'succeeded';
  targetSub.progressPct = 100;
  targetSub.version += 1;
  targetSub.updatedAt = nowIso();
  targetSub.error = null;

  const runId = `run-${Date.now().toString().slice(-5)}`;
  const run = {
    id: runId,
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    executionMode: 'mock',
    provenance: 'current',
    taskId: task.id,
    subtaskId: targetSub.id,
    agentId: targetSub.assignedAgentId || 'agent-codex',
    status: 'succeeded',
    attempt: targetSub.attempt,
    providerSessionId: `mock-session-${runId}`,
    workspaceId: targetSub.workspaceId || `ws-${task.id}-${targetSub.code.toLowerCase()}`,
    startedAt: nowIso(),
    endedAt: nowIso(),
    exitCode: 0,
    error: null
  };
  state.runs.unshift(run);
  runLogsStore.set(runId, [
    { logSeq: 1, timestamp: nowIso(), stream: 'system', text: `[MockScheduler] Executed ${targetSub.code} (${targetSub.title}) in isolated workspace ${run.workspaceId}` },
    { logSeq: 2, timestamp: nowIso(), stream: 'stdout', text: `[ResultValidator] Acceptance criteria verified (exitCode=0).` }
  ]);

  const artId = `art-${Date.now().toString().slice(-5)}`;
  const isTest = targetSub.stage === 'testing';
  const isDoc = targetSub.stage === 'documentation';
  const artContent = isTest
    ? JSON.stringify({ suite: targetSub.code, total: 42, passed: 42, failed: 0, exitCode: 0, coveragePct: 93.6 }, null, 2)
    : isDoc
    ? `# ${task.title} — 交付文档 (${targetSub.code})\n\n- 仓库：\`${task.repositoryId}\`\n- 基线提交：\`${task.baseCommit}\`\n- 独立验证：42/42 用例通过 (exitCode=0)`
    : `# Generated module for ${targetSub.code}\ndef verify_${targetSub.code.toLowerCase().replace(/[^a-z0-9]/g, '_')}():\n    return True\n`;

  artifactContentStore.set(artId, artContent);
  const artifact = {
    id: artId,
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    executionMode: 'mock',
    provenance: 'current',
    taskId: task.id,
    subtaskId: targetSub.id,
    producerRunId: runId,
    name: isTest ? `${targetSub.code.toLowerCase()}-report.json` : isDoc ? `${targetSub.code.toLowerCase()}-docs.md` : `${targetSub.code.toLowerCase()}.py`,
    relativePath: isTest
      ? `reports/${targetSub.code.toLowerCase()}-report.json`
      : isDoc
      ? `docs/${targetSub.code.toLowerCase()}-docs.md`
      : `src/${targetSub.code.toLowerCase()}.py`,
    sha256: sha256Hex(artContent),
    sizeBytes: Buffer.byteLength(artContent, 'utf8'),
    mimeType: isTest ? 'application/json' : isDoc ? 'text/markdown' : 'text/x-python',
    category: isTest ? 'test_report' : isDoc ? 'documentation' : 'code',
    validationStatus: 'validated',
    ...(isTest ? { testSummary: { total: 42, passed: 42, failed: 0, coveragePct: 93.6 } } : {})
  };
  state.artifacts.unshift(artifact);
  targetSub.outputArtifactIds.push(artId);

  const val = {
    id: `val-${Date.now().toString().slice(-5)}`,
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    executionMode: 'mock',
    provenance: 'current',
    taskId: task.id,
    subtaskId: targetSub.id,
    runId,
    criterionId: targetSub.acceptanceCriteria[0]?.id || 'ac-default',
    status: 'passed',
    exitCode: 0,
    evidenceArtifactIds: [artId]
  };
  state.validations.unshift(val);

  // Unlock next pending subtasks whose dependencies are all succeeded
  for (const candidate of subs) {
    if (candidate.status === 'pending' || candidate.status === 'blocked') {
      const depsDone = candidate.dependsOn.every((depId) => {
        const dep = subs.find((x) => x.id === depId);
        return dep && dep.status === 'succeeded';
      });
      if (depsDone) {
        candidate.status = 'running';
        candidate.progressPct = 50;
        candidate.version += 1;
        candidate.updatedAt = nowIso();
        emitEvent('subtask.updated', { subtask: candidate }, { taskId: task.id, version: candidate.version });
      }
    }
  }

  recomputeTaskAggregates(task.id);
  const completedAll = checkTaskCompletionGate(task.id);
  if (!completedAll) {
    task.status = task.pendingApprovalCount > 0 ? 'waiting_approval' : 'running';
  }

  emitEvent('artifact.created', { artifact }, { taskId: task.id, runId, version: artifact.version });
  emitEvent('validation.completed', { validation: val }, { taskId: task.id, runId, version: val.version });
  emitEvent('subtask.updated', { subtask: targetSub }, { taskId: task.id, version: targetSub.version });
  emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });

  return { result: { transition: `subtask ${targetSub.code} -> succeeded`, subtask: targetSub, task } };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1:4320'}`);
  const pathname = parsedUrl.pathname;
  const originHeader = req.headers.origin;
  const effectiveOrigin = originHeader && ALLOWED_ORIGINS.has(originHeader) ? originHeader : 'http://127.0.0.1:4320';

  if (originHeader && !ALLOWED_ORIGINS.has(originHeader)) {
    return sendError(
      res,
      403,
      'PERMISSION_DENIED',
      `Origin "${originHeader}" is not in the local allowlist.`,
      false
    );
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': effectiveOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Last-Event-ID, Idempotency-Key'
    });
    return res.end();
  }

  // Reject URL query tokens everywhere per docs/api-contract.md ("禁止 query token")
  if (parsedUrl.searchParams.has('token') || parsedUrl.searchParams.has('access_token')) {
    return sendError(
      res,
      400,
      'INVALID_INPUT',
      'Passing bearer tokens in URL query parameters is forbidden. Use the Authorization header.',
      false,
      undefined,
      effectiveOrigin
    );
  }

  // 1. Minimal Health Check (no auth required)
  if (req.method === 'GET' && pathname === '/api/v1/health') {
    return sendData(res, 200, { status: 'ok' }, effectiveOrigin);
  }

  // Require Bearer Auth for all other /api/v1/* and /__mock_control/* routes
  if (pathname.startsWith('/api/') || pathname.startsWith('/__mock_control/')) {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${DEV_TOKEN}`) {
      return sendError(
        res,
        401,
        'UNAUTHENTICATED',
        'Missing or invalid Bearer token in Authorization header.',
        false,
        undefined,
        effectiveOrigin
      );
    }
  }

  // 2. GET /api/v1/meta
  if (req.method === 'GET' && pathname === '/api/v1/meta') {
    return sendData(res, 200, state.meta, effectiveOrigin);
  }

  // 3. GET /api/v1/repositories
  if (req.method === 'GET' && pathname === '/api/v1/repositories') {
    const paged = makePage(state.repositories, parsedUrl.searchParams, 20, 100);
    if (paged.error) return sendError(res, 400, 'INVALID_INPUT', paged.error, false, undefined, effectiveOrigin);
    return sendData(res, 200, paged.page, effectiveOrigin);
  }

  // 4. GET /api/v1/agents
  if (req.method === 'GET' && pathname === '/api/v1/agents') {
    const paged = makePage(state.agents, parsedUrl.searchParams, 20, 100);
    if (paged.error) return sendError(res, 400, 'INVALID_INPUT', paged.error, false, undefined, effectiveOrigin);
    return sendData(res, 200, paged.page, effectiveOrigin);
  }

  // 5. GET /api/v1/snapshot
  if (req.method === 'GET' && pathname === '/api/v1/snapshot') {
    const taskId = parsedUrl.searchParams.get('taskId');
    if (taskId && !state.tasks.some((t) => t.id === taskId)) {
      return sendError(res, 404, 'NOT_FOUND', `Task ${taskId} not found`, false, undefined, effectiveOrigin);
    }
    return sendData(res, 200, buildSnapshot(taskId), effectiveOrigin);
  }

  // 6. GET /api/v1/tasks (Page<Task>, NOT full state)
  if (req.method === 'GET' && pathname === '/api/v1/tasks') {
    const statusFilter = parsedUrl.searchParams.get('status');
    let filtered = state.tasks;
    if (statusFilter) {
      filtered = filtered.filter((t) => t.status === statusFilter);
    }
    const paged = makePage(filtered, parsedUrl.searchParams, 20, 100);
    if (paged.error) return sendError(res, 400, 'INVALID_INPUT', paged.error, false, undefined, effectiveOrigin);
    return sendData(res, 200, paged.page, effectiveOrigin);
  }

  // 7. POST /api/v1/tasks/decompose
  if (req.method === 'POST' && pathname === '/api/v1/tasks/decompose') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, e.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_INPUT', 'Malformed JSON body', false, undefined, effectiveOrigin);
    }
    const keyErr = validateAllowedKeys(body, ['goal', 'repositoryId'], ['goal', 'repositoryId']);
    if (keyErr) return sendError(res, 400, 'INVALID_INPUT', keyErr, false, undefined, effectiveOrigin);

    const idem = checkIdempotency(req, res, 'tasks.decompose', body, effectiveOrigin);
    if (idem.handled) return;

    const repo = state.repositories.find((r) => r.id === body.repositoryId);
    if (!repo) {
      return sendError(res, 404, 'NOT_FOUND', `Repository "${body.repositoryId}" is not in the registered allowlist.`, false, undefined, effectiveOrigin);
    }

    const draftPlan = {
      id: `plan-${Date.now().toString().slice(-6)}`,
      repositoryId: repo.id,
      goal: String(body.goal).trim(),
      subtasks: buildDraftPlannedSubtasks(String(body.goal).trim(), repo.id),
      executionMode: state.meta.executionMode
    };
    return idem.commit(200, draftPlan);
  }

  // 8. POST /api/v1/tasks
  if (req.method === 'POST' && pathname === '/api/v1/tasks') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, e.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_INPUT', 'Malformed JSON body', false, undefined, effectiveOrigin);
    }
    const keyErr = validateAllowedKeys(
      body,
      ['title', 'goal', 'repositoryId', 'acceptanceCriteria', 'priority', 'plannedSubtasks'],
      ['title', 'goal', 'repositoryId', 'acceptanceCriteria']
    );
    if (keyErr) return sendError(res, 400, 'INVALID_INPUT', keyErr, false, undefined, effectiveOrigin);

    const idem = checkIdempotency(req, res, 'tasks.create', body, effectiveOrigin);
    if (idem.handled) return;

    const repo = state.repositories.find((r) => r.id === body.repositoryId);
    if (!repo) {
      return sendError(res, 404, 'NOT_FOUND', `Repository "${body.repositoryId}" not found in registered repositories.`, false, undefined, effectiveOrigin);
    }
    if (repo.id === 'repo-real-relay-01') {
      return sendError(res, 403, 'PERMISSION_DENIED', 'Historical evidence repository is read-only.', false, undefined, effectiveOrigin);
    }

    const planned = body.plannedSubtasks || buildDraftPlannedSubtasks(body.goal, repo.id);
    const dagCheck = validateDagSubtasks(planned);
    if (!dagCheck.ok) {
      return sendError(res, dagCheck.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, dagCheck.code, dagCheck.message, false, undefined, effectiveOrigin);
    }

    const taskId = `task-${Date.now().toString().slice(-6)}`;
    const planIdToSubId = new Map();
    planned.forEach((p, idx) => {
      planIdToSubId.set(p.id, `${taskId}-sub-0${idx + 1}`);
    });

    const createdSubtasks = planned.map((p, idx) => {
      const subId = planIdToSubId.get(p.id);
      const mappedDeps = (p.dependsOn || []).map((d) => planIdToSubId.get(d) || d);
      return {
        id: subId,
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        executionMode: 'mock',
        taskId,
        code: p.code,
        title: p.title,
        description: p.description,
        stage: p.stage,
        dependsOn: mappedDeps,
        requiredCapabilities: p.requiredCapabilities || ['stream'],
        acceptanceCriteria: p.acceptanceCriteria || [{ id: `ac-${subId}`, description: 'Pass validation' }],
        status: idx === 0 ? 'ready' : 'pending',
        assignedAgentId: p.stage === 'testing' || p.stage === 'review' ? 'agent-codex-reviewer' : 'agent-codex',
        workspaceId: `ws-${taskId}-${p.code.toLowerCase()}`,
        branchName: `hub/${taskId}/${p.code.toLowerCase()}`,
        progressPct: 0,
        attempt: 1,
        maxAttempts: 2,
        timeoutMs: 180000,
        outputArtifactIds: [],
        error: null
      };
    });

    const newTask = {
      id: taskId,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      executionMode: 'mock',
      provenance: 'current',
      title: String(body.title).trim(),
      goal: String(body.goal).trim(),
      repositoryId: repo.id,
      baseCommit: repo.baseCommit,
      status: 'queued',
      priority: body.priority || 'high',
      progressPct: 0,
      pendingApprovalCount: 0,
      artifactCount: 0,
      acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [],
      error: null,
      startedAt: null,
      endedAt: null,
      deadlineAt: new Date(Date.now() + 3600 * 1000).toISOString()
    };

    state.tasks.unshift(newTask);
    state.subtasks.push(...createdSubtasks);

    const decompMsg = {
      id: `msg-${Date.now().toString().slice(-6)}`,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      executionMode: 'mock',
      provenance: 'current',
      taskId,
      fromRunId: null,
      toSubtaskId: createdSubtasks[0].id,
      fromLabel: 'Orchestrator Planner',
      toLabel: `${createdSubtasks[0].code} (${createdSubtasks[0].title})`,
      summary: `新任务「${newTask.title}」已通过 DAG 校验进入 queued 状态（共 ${createdSubtasks.length} 个子任务）`,
      content: createdSubtasks.map((s) => `- ${s.code} [${s.stage}]: ${s.title}`).join('\n'),
      kind: 'task_decomposition',
      correlationId: `corr-${taskId}`,
      causationId: null,
      artifactRefs: [],
      deliveredAt: nowIso()
    };
    state.messages.unshift(decompMsg);

    emitEvent('task.updated', { task: newTask }, { taskId: newTask.id, version: newTask.version });
    emitEvent('message.created', { message: decompMsg }, { taskId: newTask.id, version: decompMsg.version });

    return idem.commit(201, newTask);
  }

  // 9. GET /api/v1/tasks/:id
  const taskDetailMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && taskDetailMatch) {
    const taskId = decodeURIComponent(taskDetailMatch[1]);
    const detail = buildTaskDetail(taskId);
    if (!detail) return sendError(res, 404, 'NOT_FOUND', `Task ${taskId} not found`, false, undefined, effectiveOrigin);
    return sendData(res, 200, detail, effectiveOrigin);
  }

  // 10. GET /api/v1/tasks/:id/runs | validations | messages | artifacts | approvals
  const taskSubResourceMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/(runs|validations|messages|artifacts|approvals)$/);
  if (req.method === 'GET' && taskSubResourceMatch) {
    const taskId = decodeURIComponent(taskSubResourceMatch[1]);
    const subResource = taskSubResourceMatch[2];
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return sendError(res, 404, 'NOT_FOUND', `Task ${taskId} not found`, false, undefined, effectiveOrigin);

    let list = state[subResource].filter((item) => item.taskId === taskId);
    if (subResource === 'approvals') {
      const statusFilter = parsedUrl.searchParams.get('status');
      if (statusFilter) list = list.filter((a) => a.status === statusFilter);
    }
    const paged = makePage(list, parsedUrl.searchParams, 20, 100);
    if (paged.error) return sendError(res, 400, 'INVALID_INPUT', paged.error, false, undefined, effectiveOrigin);
    return sendData(res, 200, paged.page, effectiveOrigin);
  }

  // 11. GET /api/v1/runs/:id/logs
  const runLogsMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/logs$/);
  if (req.method === 'GET' && runLogsMatch) {
    const runId = decodeURIComponent(runLogsMatch[1]);
    const run = state.runs.find((r) => r.id === runId);
    if (!run) return sendError(res, 404, 'NOT_FOUND', `AgentRun ${runId} not found`, false, undefined, effectiveOrigin);

    const rawAfter = parsedUrl.searchParams.get('afterSeq');
    const afterSeq = rawAfter !== null && rawAfter !== '' ? Number(rawAfter) : 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      return sendError(res, 400, 'INVALID_INPUT', 'afterSeq must be a non-negative integer', false, undefined, effectiveOrigin);
    }
    const rawLimit = parsedUrl.searchParams.get('limit');
    const limit = rawLimit !== null && rawLimit !== '' ? Number(rawLimit) : 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return sendError(res, 400, 'INVALID_INPUT', 'logs limit must be an integer between 1 and 500', false, undefined, effectiveOrigin);
    }

    const allLogs = runLogsStore.get(runId) || [];
    const remaining = allLogs.filter((l) => l.logSeq > afterSeq);
    const items = remaining.slice(0, limit);
    const nextSeq = items.length > 0 ? items[items.length - 1].logSeq : afterSeq;
    const hasMore = remaining.length > limit;

    return sendData(res, 200, { runId, items, nextSeq, hasMore }, effectiveOrigin);
  }

  // 12. GET /api/v1/artifacts/:id/content
  const artifactContentMatch = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/);
  if (req.method === 'GET' && artifactContentMatch) {
    const rawId = artifactContentMatch[1];
    const artId = decodeURIComponent(rawId);
    if (
      artId.includes('..') ||
      artId.includes('/') ||
      artId.includes('\\') ||
      artId.includes('\0') ||
      parsedUrl.searchParams.has('path')
    ) {
      return sendError(
        res,
        400,
        'INVALID_INPUT',
        'Path traversal or arbitrary file path access is forbidden. Use registered artifact ID only.',
        false,
        undefined,
        effectiveOrigin
      );
    }
    const art = state.artifacts.find((a) => a.id === artId);
    if (!art) {
      return sendError(res, 404, 'NOT_FOUND', `Artifact ${artId} not found`, false, undefined, effectiveOrigin);
    }
    const content = artifactContentStore.get(artId) || '';
    res.writeHead(200, {
      'Content-Type': `${art.mimeType || 'text/plain'}; charset=utf-8`,
      'Content-Disposition': `inline; filename="${path.basename(art.name)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': effectiveOrigin
    });
    return res.end(content);
  }

  // 13. POST /api/v1/tasks/:id/pause | resume | cancel
  const taskControlMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/(pause|resume|cancel)$/);
  if (req.method === 'POST' && taskControlMatch) {
    const taskId = decodeURIComponent(taskControlMatch[1]);
    const action = taskControlMatch[2];
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'INVALID_INPUT', 'Malformed JSON body', false, undefined, effectiveOrigin);
    }

    const allowedKeys = action === 'cancel' ? ['expectedVersion', 'reason'] : ['expectedVersion'];
    const keyErr = validateAllowedKeys(body, allowedKeys, ['expectedVersion']);
    if (keyErr) return sendError(res, 400, 'INVALID_INPUT', keyErr, false, undefined, effectiveOrigin);

    const idem = checkIdempotency(req, res, `task.${action}:${taskId}`, body, effectiveOrigin);
    if (idem.handled) return;

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return sendError(res, 404, 'NOT_FOUND', `Task ${taskId} not found`, false, undefined, effectiveOrigin);

    if (task.provenance === 'historical') {
      return sendError(
        res,
        409,
        'UNSUPPORTED_TRANSITION',
        'Historical evidence task (real-relay-01) is read-only and cannot be paused, resumed, or cancelled.',
        false,
        undefined,
        effectiveOrigin
      );
    }

    if (Number(body.expectedVersion) !== task.version) {
      return sendError(
        res,
        409,
        'CONFLICT',
        `CAS version mismatch on task ${taskId}: expectedVersion=${body.expectedVersion}, actual=${task.version}`,
        false,
        { expectedVersion: body.expectedVersion, actualVersion: task.version },
        effectiveOrigin
      );
    }

    const terminalStates = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
    if (terminalStates.has(task.status) && action !== 'cancel') {
      return sendError(
        res,
        409,
        'UNSUPPORTED_TRANSITION',
        `Cannot ${action} task in terminal status "${task.status}".`,
        false,
        undefined,
        effectiveOrigin
      );
    }

    if (action === 'pause') {
      if (!['queued', 'running', 'waiting_approval'].includes(task.status)) {
        return sendError(res, 409, 'UNSUPPORTED_TRANSITION', `Cannot pause task from status "${task.status}".`, false, undefined, effectiveOrigin);
      }
      task.status = 'pausing';
    } else if (action === 'resume') {
      if (task.status !== 'paused') {
        return sendError(
          res,
          409,
          'UNSUPPORTED_TRANSITION',
          `POST /tasks/:id/resume is only allowed when task is in "paused" state (current: "${task.status}").`,
          false,
          undefined,
          effectiveOrigin
        );
      }
      task.status = 'queued';
    } else if (action === 'cancel') {
      if (task.status === 'cancelled' || task.status === 'succeeded') {
        return sendError(
          res,
          409,
          'UNSUPPORTED_TRANSITION',
          `Cannot cancel task already in terminal status "${task.status}".`,
          false,
          undefined,
          effectiveOrigin
        );
      }
      task.status = 'cancelling';
      for (const r of state.runs.filter((x) => x.taskId === task.id && x.status === 'running')) {
        r.status = 'cancelling';
        r.version += 1;
        r.updatedAt = nowIso();
        emitEvent('run.updated', { run: r }, { taskId: task.id, runId: r.id, version: r.version });
      }
    }

    recomputeTaskAggregates(task.id);
    emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });

    const responsePayload = {
      taskId: task.id,
      status: task.status,
      version: task.version,
      operationId: `op-${action}-${Date.now().toString().slice(-6)}`
    };
    return idem.commit(202, responsePayload);
  }

  // 14. POST /api/v1/subtasks/:id/retry | rework
  const subtaskControlMatch = pathname.match(/^\/api\/v1\/subtasks\/([^/]+)\/(retry|rework)$/);
  if (req.method === 'POST' && subtaskControlMatch) {
    const subtaskId = decodeURIComponent(subtaskControlMatch[1]);
    const action = subtaskControlMatch[2];
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'INVALID_INPUT', 'Malformed JSON body', false, undefined, effectiveOrigin);
    }

    const allowedKeys = action === 'rework' ? ['expectedVersion', 'reason', 'artifactRefs'] : ['expectedVersion', 'reason'];
    const requiredKeys = action === 'rework' ? ['expectedVersion', 'reason', 'artifactRefs'] : ['expectedVersion', 'reason'];
    const keyErr = validateAllowedKeys(body, allowedKeys, requiredKeys);
    if (keyErr) return sendError(res, 400, 'INVALID_INPUT', keyErr, false, undefined, effectiveOrigin);

    const idem = checkIdempotency(req, res, `subtask.${action}:${subtaskId}`, body, effectiveOrigin);
    if (idem.handled) return;

    const subtask = state.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return sendError(res, 404, 'NOT_FOUND', `Subtask ${subtaskId} not found`, false, undefined, effectiveOrigin);

    const task = state.tasks.find((t) => t.id === subtask.taskId);
    if (task?.provenance === 'historical') {
      return sendError(res, 409, 'UNSUPPORTED_TRANSITION', 'Historical evidence subtask is read-only.', false, undefined, effectiveOrigin);
    }

    if (Number(body.expectedVersion) !== subtask.version) {
      return sendError(
        res,
        409,
        'CONFLICT',
        `CAS version mismatch on subtask ${subtaskId}: expectedVersion=${body.expectedVersion}, actual=${subtask.version}`,
        false,
        { expectedVersion: body.expectedVersion, actualVersion: subtask.version },
        effectiveOrigin
      );
    }

    const hasActiveRun = state.runs.some(
      (r) => r.subtaskId === subtask.id && ['queued', 'starting', 'running', 'cancelling'].includes(r.status)
    );
    if (hasActiveRun) {
      return sendError(res, 409, 'UNSUPPORTED_TRANSITION', `Subtask ${subtask.id} still has an active run.`, false, undefined, effectiveOrigin);
    }

    if (action === 'retry') {
      if (!['failed', 'timed_out'].includes(subtask.status)) {
        return sendError(
          res,
          409,
          'UNSUPPORTED_TRANSITION',
          `POST /subtasks/:id/retry requires subtask status in failed or timed_out (current: "${subtask.status}").`,
          false,
          undefined,
          effectiveOrigin
        );
      }
      if (subtask.error && subtask.error.retryable === false) {
        return sendError(
          res,
          409,
          'UNSUPPORTED_TRANSITION',
          `Subtask error ${subtask.error.code} is marked non-retryable (auth/permission failure).`,
          false,
          undefined,
          effectiveOrigin
        );
      }
      if (subtask.attempt >= subtask.maxAttempts) {
        return sendError(
          res,
          409,
          'UNSUPPORTED_TRANSITION',
          `Subtask ${subtask.code} has exhausted maxAttempts (${subtask.attempt}/${subtask.maxAttempts}).`,
          false,
          undefined,
          effectiveOrigin
        );
      }

      subtask.attempt += 1;
      subtask.status = 'running';
      subtask.progressPct = 55;
      subtask.error = null;
      subtask.version += 1;
      subtask.updatedAt = nowIso();

      const newRun = {
        id: `run-${Date.now().toString().slice(-5)}`,
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        executionMode: 'mock',
        provenance: 'current',
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        agentId: subtask.assignedAgentId || 'agent-codex',
        status: 'running',
        attempt: subtask.attempt,
        providerSessionId: `mock-session-retry-${subtask.attempt}`,
        workspaceId: subtask.workspaceId || `ws-${subtask.taskId}-${subtask.code.toLowerCase()}`,
        startedAt: nowIso(),
        endedAt: null,
        exitCode: null,
        error: null
      };
      state.runs.unshift(newRun);
      runLogsStore.set(newRun.id, [
        { logSeq: 1, timestamp: nowIso(), stream: 'system', text: `[Retry] Spawned new attempt #${subtask.attempt}/${subtask.maxAttempts} (previous runs preserved). Reason: ${body.reason}` }
      ]);

      if (task) {
        task.status = 'running';
        task.error = null;
        task.endedAt = null;
        recomputeTaskAggregates(task.id);
        emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });
      }
      emitEvent('subtask.updated', { subtask }, { taskId: subtask.taskId, version: subtask.version });
      emitEvent('run.updated', { run: newRun }, { taskId: subtask.taskId, runId: newRun.id, version: newRun.version });

      return idem.commit(202, {
        subtask,
        run: newRun,
        operationId: `op-retry-${Date.now().toString().slice(-6)}`
      });
    }

    // action === 'rework'
    if (!['validating', 'waiting_approval'].includes(subtask.status)) {
      return sendError(
        res,
        409,
        'UNSUPPORTED_TRANSITION',
        `POST /subtasks/:id/rework is only allowed from validating or waiting_approval (current: "${subtask.status}").`,
        false,
        undefined,
        effectiveOrigin
      );
    }
    if (!Array.isArray(body.artifactRefs)) {
      return sendError(res, 400, 'INVALID_INPUT', 'artifactRefs must be an array of artifact IDs', false, undefined, effectiveOrigin);
    }
    if (subtask.attempt >= subtask.maxAttempts) {
      return sendError(
        res,
        409,
        'UNSUPPORTED_TRANSITION',
        `Subtask ${subtask.code} has reached maxAttempts (${subtask.attempt}/${subtask.maxAttempts}).`,
        false,
        undefined,
        effectiveOrigin
      );
    }

    // Invalidate pending approvals on this subtask
    const invalidatedApprovalIds = [];
    for (const ap of state.approvals) {
      if (ap.subtaskId === subtask.id && ap.status === 'pending') {
        ap.status = 'invalidated';
        ap.version += 1;
        ap.updatedAt = nowIso();
        ap.decidedAt = nowIso();
        ap.decidedBy = 'system:rework_invalidated';
        invalidatedApprovalIds.push(ap.id);
        emitEvent('approval.decided', { approval: ap }, { taskId: subtask.taskId, version: ap.version });
      }
    }

    // Block downstream dependent subtasks
    const blockedSubtaskIds = [];
    for (const candidate of state.subtasks.filter((s) => s.taskId === subtask.taskId)) {
      if (candidate.dependsOn.includes(subtask.id) && candidate.status !== 'blocked') {
        candidate.status = 'blocked';
        candidate.version += 1;
        candidate.updatedAt = nowIso();
        blockedSubtaskIds.push(candidate.id);
        emitEvent('subtask.updated', { subtask: candidate }, { taskId: subtask.taskId, version: candidate.version });
      }
    }

    subtask.attempt += 1;
    subtask.status = 'running';
    subtask.progressPct = 65;
    subtask.version += 1;
    subtask.updatedAt = nowIso();

    const reworkRun = {
      id: `run-${Date.now().toString().slice(-5)}`,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      executionMode: 'mock',
      provenance: 'current',
      taskId: subtask.taskId,
      subtaskId: subtask.id,
      agentId: subtask.assignedAgentId || 'agent-codex',
      status: 'running',
      attempt: subtask.attempt,
      providerSessionId: `mock-session-rework-${subtask.attempt}`,
      workspaceId: subtask.workspaceId || `ws-${subtask.taskId}-${subtask.code.toLowerCase()}`,
      startedAt: nowIso(),
      endedAt: null,
      exitCode: null,
      error: null
    };
    state.runs.unshift(reworkRun);
    runLogsStore.set(reworkRun.id, [
      { logSeq: 1, timestamp: nowIso(), stream: 'system', text: `[Rework] Started attempt #${subtask.attempt}/${subtask.maxAttempts}; invalidated approvals: [${invalidatedApprovalIds.join(', ')}]. Reason: ${body.reason}` }
    ]);

    const reworkMsg = {
      id: `msg-${Date.now().toString().slice(-6)}`,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      executionMode: 'mock',
      provenance: 'current',
      taskId: subtask.taskId,
      fromRunId: null,
      toSubtaskId: subtask.id,
      fromLabel: 'Human Reviewer / Coordinator',
      toLabel: `${subtask.code} (${subtask.assignedAgentId})`,
      summary: `触发子任务独立返工 (${subtask.code} Attempt #${subtask.attempt})，旧审批已置为 invalidated`,
      content: String(body.reason),
      kind: 'rework_instruction',
      correlationId: `corr-${subtask.taskId}`,
      causationId: null,
      artifactRefs: body.artifactRefs,
      deliveredAt: nowIso()
    };
    state.messages.unshift(reworkMsg);

    if (task) {
      task.status = 'running';
      recomputeTaskAggregates(task.id);
      emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });
    }
    emitEvent('subtask.updated', { subtask }, { taskId: subtask.taskId, version: subtask.version });
    emitEvent('run.updated', { run: reworkRun }, { taskId: subtask.taskId, runId: reworkRun.id, version: reworkRun.version });
    emitEvent('message.created', { message: reworkMsg }, { taskId: subtask.taskId, version: reworkMsg.version });

    return idem.commit(202, {
      subtask,
      run: reworkRun,
      invalidatedApprovalIds,
      blockedSubtaskIds,
      operationId: `op-rework-${Date.now().toString().slice(-6)}`
    });
  }

  // 15. POST /api/v1/approvals/:id/decision
  const approvalDecisionMatch = pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/decision$/);
  if (req.method === 'POST' && approvalDecisionMatch) {
    const approvalId = decodeURIComponent(approvalDecisionMatch[1]);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'INVALID_INPUT', 'Malformed JSON body', false, undefined, effectiveOrigin);
    }

    const keyErr = validateAllowedKeys(
      body,
      ['expectedVersion', 'decision', 'actionDigest', 'comment'],
      ['expectedVersion', 'decision', 'actionDigest']
    );
    if (keyErr) return sendError(res, 400, 'INVALID_INPUT', keyErr, false, undefined, effectiveOrigin);

    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return sendError(
        res,
        400,
        'INVALID_INPUT',
        `Approval decision must be strictly "approve" or "reject" (received "${body.decision}"). Use POST /api/v1/subtasks/:id/rework for rework.`,
        false,
        undefined,
        effectiveOrigin
      );
    }

    const idem = checkIdempotency(req, res, `approval.decision:${approvalId}`, body, effectiveOrigin);
    if (idem.handled) return;

    const approval = state.approvals.find((a) => a.id === approvalId);
    if (!approval) return sendError(res, 404, 'NOT_FOUND', `Approval ${approvalId} not found`, false, undefined, effectiveOrigin);

    if (Number(body.expectedVersion) !== approval.version) {
      return sendError(
        res,
        409,
        'CONFLICT',
        `CAS version mismatch on approval ${approvalId}: expectedVersion=${body.expectedVersion}, actual=${approval.version}`,
        false,
        { expectedVersion: body.expectedVersion, actualVersion: approval.version },
        effectiveOrigin
      );
    }

    if (approval.status !== 'pending') {
      return sendError(
        res,
        409,
        'UNSUPPORTED_TRANSITION',
        `Approval ${approvalId} is already in "${approval.status}" state.`,
        false,
        undefined,
        effectiveOrigin
      );
    }

    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      approval.status = 'expired';
      approval.version += 1;
      approval.updatedAt = nowIso();
      emitEvent('approval.decided', { approval }, { taskId: approval.taskId, version: approval.version });
      return sendError(
        res,
        409,
        'CONFLICT',
        `Approval ${approvalId} expired at ${approval.expiresAt}.`,
        false,
        { status: 'expired', expiresAt: approval.expiresAt },
        effectiveOrigin
      );
    }

    if (body.actionDigest !== approval.actionDigest) {
      return sendError(
        res,
        409,
        'CONFLICT',
        `Approval actionDigest mismatch: expected "${approval.actionDigest}", received "${body.actionDigest}".`,
        false,
        { expectedDigest: approval.actionDigest, receivedDigest: body.actionDigest },
        effectiveOrigin
      );
    }

    approval.status = body.decision === 'approve' ? 'approved' : 'rejected';
    approval.version += 1;
    approval.updatedAt = nowIso();
    approval.decidedAt = nowIso();
    approval.decidedBy = 'operator-local';

    const subtask = state.subtasks.find((s) => s.id === approval.subtaskId);
    const task = state.tasks.find((t) => t.id === approval.taskId);

    if (body.decision === 'approve') {
      // Mark linked artifacts validated
      for (const refId of approval.artifactRefs) {
        const art = state.artifacts.find((a) => a.id === refId);
        if (art) {
          art.validationStatus = 'validated';
          art.version += 1;
          art.updatedAt = nowIso();
        }
      }
      if (subtask) {
        subtask.status = 'succeeded';
        subtask.progressPct = 100;
        subtask.version += 1;
        subtask.updatedAt = nowIso();
        emitEvent('subtask.updated', { subtask }, { taskId: approval.taskId, version: subtask.version });
      }
      // Unlock downstream subtasks whose dependencies are now all succeeded
      const taskSubs = state.subtasks.filter((s) => s.taskId === approval.taskId);
      for (const candidate of taskSubs) {
        if (candidate.status === 'pending' || candidate.status === 'blocked') {
          const depsDone = candidate.dependsOn.every((depId) => {
            const dep = taskSubs.find((x) => x.id === depId);
            return dep && dep.status === 'succeeded';
          });
          if (depsDone) {
            candidate.status = 'running';
            candidate.progressPct = 40;
            candidate.version += 1;
            candidate.updatedAt = nowIso();
            emitEvent('subtask.updated', { subtask: candidate }, { taskId: approval.taskId, version: candidate.version });
          }
        }
      }
      if (task) {
        recomputeTaskAggregates(task.id);
        const completed = checkTaskCompletionGate(task.id);
        if (!completed) {
          task.status = 'running';
        }
        emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });
      }
    } else {
      // decision === 'reject': blocks action; does NOT auto-complete or silently rework
      for (const refId of approval.artifactRefs) {
        const art = state.artifacts.find((a) => a.id === refId);
        if (art) {
          art.validationStatus = 'rejected';
          art.version += 1;
          art.updatedAt = nowIso();
        }
      }
      if (subtask) {
        subtask.status = 'waiting_approval';
        subtask.version += 1;
        subtask.updatedAt = nowIso();
        emitEvent('subtask.updated', { subtask }, { taskId: approval.taskId, version: subtask.version });
      }
      if (task) {
        recomputeTaskAggregates(task.id);
        emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });
      }
    }

    const feedbackMsg = {
      id: `msg-${Date.now().toString().slice(-6)}`,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      executionMode: 'mock',
      provenance: 'current',
      taskId: approval.taskId,
      fromRunId: approval.runId,
      toSubtaskId: approval.subtaskId,
      fromLabel: 'Operator (Review Center)',
      toLabel: subtask ? `${subtask.code}` : approval.subtaskId,
      summary:
        body.decision === 'approve'
          ? `审批通过 (${approval.id}, digest=${approval.actionDigest.slice(0, 10)}...)，已解锁下游依赖`
          : `审批已拒绝 (${approval.id})，动作已阻止（如需返工请调用 Subtask Rework）`,
      content: body.comment ? String(body.comment) : `Decision: ${body.decision}`,
      kind: 'review_feedback',
      correlationId: `corr-${approval.taskId}`,
      causationId: null,
      artifactRefs: approval.artifactRefs,
      deliveredAt: nowIso()
    };
    state.messages.unshift(feedbackMsg);

    emitEvent('approval.decided', { approval }, { taskId: approval.taskId, version: approval.version });
    emitEvent('message.created', { message: feedbackMsg }, { taskId: approval.taskId, version: feedbackMsg.version });

    return idem.commit(200, approval);
  }

  // 16. POST /api/v1/tasks/:id/messages
  const postMessageMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/messages$/);
  if (req.method === 'POST' && postMessageMatch) {
    const taskId = decodeURIComponent(postMessageMatch[1]);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'INVALID_INPUT', 'Malformed JSON body', false, undefined, effectiveOrigin);
    }

    const keyErr = validateAllowedKeys(
      body,
      ['toSubtaskId', 'content', 'artifactRefs'],
      ['toSubtaskId', 'content', 'artifactRefs']
    );
    if (keyErr) return sendError(res, 400, 'INVALID_INPUT', keyErr, false, undefined, effectiveOrigin);

    const idem = checkIdempotency(req, res, `task.messages:${taskId}`, body, effectiveOrigin);
    if (idem.handled) return;

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return sendError(res, 404, 'NOT_FOUND', `Task ${taskId} not found`, false, undefined, effectiveOrigin);
    if (task.provenance === 'historical') {
      return sendError(res, 409, 'UNSUPPORTED_TRANSITION', 'Cannot post directives to historical read-only evidence task.', false, undefined, effectiveOrigin);
    }

    const subtask = state.subtasks.find((s) => s.id === body.toSubtaskId && s.taskId === taskId);
    if (!subtask) {
      return sendError(res, 404, 'NOT_FOUND', `Subtask ${body.toSubtaskId} not found in task ${taskId}`, false, undefined, effectiveOrigin);
    }
    if (!Array.isArray(body.artifactRefs)) {
      return sendError(res, 400, 'INVALID_INPUT', 'artifactRefs must be an array', false, undefined, effectiveOrigin);
    }

    const message = {
      id: `msg-${Date.now().toString().slice(-6)}`,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      executionMode: 'mock',
      provenance: 'current',
      taskId,
      fromRunId: null,
      toSubtaskId: subtask.id,
      fromLabel: 'Human Operator',
      toLabel: `${subtask.code} (${subtask.assignedAgentId})`,
      summary: `人工补充上下文指令 → ${subtask.code} [delivery=queued_next_turn]`,
      content: String(body.content).trim(),
      kind: 'human_directive',
      correlationId: `corr-${taskId}`,
      causationId: null,
      artifactRefs: body.artifactRefs,
      deliveredAt: null
    };
    state.messages.unshift(message);

    emitEvent('message.created', { message }, { taskId, version: message.version });
    return idem.commit(201, { message, delivery: 'queued_next_turn' });
  }

  // 17. GET /api/v1/events (SSE with Last-Event-ID & snapshotSeq validation)
  if (req.method === 'GET' && pathname === '/api/v1/events') {
    const taskId = parsedUrl.searchParams.get('taskId') || null;
    const rawLastEventId = req.headers['last-event-id'];

    let cursorSeq = null;
    if (rawLastEventId !== undefined && rawLastEventId !== '') {
      if (!/^\d+$/.test(String(rawLastEventId).trim())) {
        return sendError(
          res,
          400,
          'INVALID_INPUT',
          `Invalid Last-Event-ID "${rawLastEventId}": must be a non-negative safe integer.`,
          false,
          undefined,
          effectiveOrigin
        );
      }
      cursorSeq = Number(String(rawLastEventId).trim());
      if (!Number.isSafeInteger(cursorSeq)) {
        return sendError(res, 400, 'INVALID_INPUT', 'Last-Event-ID is not a safe integer.', false, undefined, effectiveOrigin);
      }
      const minWatermark = eventOutbox.length > 0 ? eventOutbox[0].seq - 1 : MIN_RETAINED_SEQ_WINDOW;
      if (cursorSeq < minWatermark || cursorSeq > globalSeq) {
        return sendError(
          res,
          409,
          'EVENT_CURSOR_EXPIRED',
          `Last-Event-ID ${cursorSeq} is outside the valid server window [${minWatermark}, ${globalSeq}]. Re-fetch GET /api/v1/snapshot first.`,
          true,
          { cursorSeq, minWatermark, currentWatermark: globalSeq },
          effectiveOrigin
        );
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': effectiveOrigin
    });

    res.write(`: heartbeat ${nowIso()} snapshotSeq=${globalSeq}\n\n`);

    if (cursorSeq !== null) {
      const missed = eventOutbox.filter(
        (evt) => evt.seq > cursorSeq && (!taskId || !evt.taskId || evt.taskId === taskId)
      );
      for (const evt of missed) {
        res.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
    }

    const clientEntry = { res, taskId };
    sseClients.add(clientEntry);
    req.on('close', () => {
      sseClients.delete(clientEntry);
    });
    return;
  }

  // ============================================================================
  // ISOLATED MOCK TEST CONTROL PLANE (/ __mock_control/*)
  // Strictly separated from /api/v1/* business contract per alignment-v0.2.md
  // ============================================================================
  if (req.method === 'POST' && pathname === '/__mock_control/reset') {
    state = createInitialState();
    const task = state.tasks[0];
    emitEvent('task.updated', { task }, { taskId: task.id, version: task.version });
    return sendData(res, 200, { reset: true, snapshotSeq: globalSeq }, effectiveOrigin);
  }

  if (req.method === 'POST' && pathname === '/__mock_control/step') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'INVALID_INPUT', 'Malformed JSON', false, undefined, effectiveOrigin);
    }
    const taskId = body.taskId || state.tasks[0]?.id;
    const outcome = advanceMockStep(taskId);
    if (outcome.error) {
      return sendError(res, outcome.error.status, outcome.error.code, outcome.error.message, false, undefined, effectiveOrigin);
    }
    return sendData(res, 200, outcome.result, effectiveOrigin);
  }

  if (req.method === 'POST' && pathname === '/__mock_control/fault') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'INVALID_INPUT', 'Malformed JSON', false, undefined, effectiveOrigin);
    }
    const taskId = body.taskId || 'task-smartcar-01';
    const faultType = body.faultType || 'TIMEOUT';
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return sendError(res, 404, 'NOT_FOUND', `Task ${taskId} not found`, false, undefined, effectiveOrigin);
    if (task.provenance === 'historical') {
      return sendError(
        res,
        409,
        'UNSUPPORTED_TRANSITION',
        'Cannot inject mock faults into historical real CLI evidence (real-relay-01).',
        false,
        undefined,
        effectiveOrigin
      );
    }

    const targetSub =
      state.subtasks.find((s) => s.taskId === taskId && s.id === body.subtaskId) ||
      state.subtasks.find((s) => s.taskId === taskId && s.status !== 'succeeded') ||
      state.subtasks.find((s) => s.taskId === taskId);

    if (faultType === 'PERMISSION_DENIED_EXTERNAL_GIT') {
      const errObj = {
        code: 'PERMISSION_DENIED',
        message: 'B-01 Guardrail: external Git metadata writes require a coordinator; auto mode refuses escalation to danger-full-access.',
        retryable: false,
        details: {
          guardrail: 'B-01',
          mode: 'auto',
          codexExternalGitDirs: ['/repo/.git']
        },
        occurredAt: nowIso()
      };
      if (targetSub) {
        targetSub.status = 'failed';
        targetSub.error = errObj;
        targetSub.version += 1;
        targetSub.updatedAt = nowIso();
        emitEvent('subtask.updated', { subtask: targetSub }, { taskId, version: targetSub.version });
      }
      task.status = 'failed';
      task.error = errObj;
      recomputeTaskAggregates(taskId);
      emitEvent('task.updated', { task }, { taskId, version: task.version });
      return sendData(res, 200, { injected: faultType, task, subtask: targetSub }, effectiveOrigin);
    }

    if (faultType === 'TIMEOUT') {
      const errObj = {
        code: 'TIMEOUT',
        message: `Subtask ${targetSub?.code || 'SUB'} exceeded timeoutMs (${targetSub?.timeoutMs || 180000}ms).`,
        retryable: true,
        details: { subtaskId: targetSub?.id, attempt: targetSub?.attempt || 1 },
        occurredAt: nowIso()
      };
      if (targetSub) {
        targetSub.status = 'timed_out';
        targetSub.error = errObj;
        targetSub.version += 1;
        targetSub.updatedAt = nowIso();
        emitEvent('subtask.updated', { subtask: targetSub }, { taskId, version: targetSub.version });
      }
      task.status = 'timed_out';
      task.error = errObj;
      recomputeTaskAggregates(taskId);
      emitEvent('task.updated', { task }, { taskId, version: task.version });
      return sendData(res, 200, { injected: faultType, task, subtask: targetSub }, effectiveOrigin);
    }

    if (faultType === 'WORKTREE_CONFLICT') {
      const errObj = {
        code: 'WORKTREE_CONFLICT',
        message: 'Git worktree integration conflict detected on src/vision/contracts.py; automatic destructive reset is forbidden.',
        retryable: false,
        details: { branchName: targetSub?.branchName },
        occurredAt: nowIso()
      };
      if (targetSub) {
        targetSub.status = 'blocked';
        targetSub.error = errObj;
        targetSub.version += 1;
        targetSub.updatedAt = nowIso();
        emitEvent('subtask.updated', { subtask: targetSub }, { taskId, version: targetSub.version });
      }
      task.status = 'failed';
      task.error = errObj;
      recomputeTaskAggregates(taskId);
      emitEvent('task.updated', { task }, { taskId, version: task.version });
      return sendData(res, 200, { injected: faultType, task, subtask: targetSub }, effectiveOrigin);
    }

    if (faultType === 'EXPIRE_APPROVAL') {
      const ap = state.approvals.find((a) => a.taskId === taskId && a.status === 'pending');
      if (ap) {
        ap.expiresAt = '2020-01-01T00:00:00.000Z';
        ap.version += 1;
        ap.updatedAt = nowIso();
      }
      return sendData(res, 200, { injected: faultType, approval: ap || null }, effectiveOrigin);
    }

    if (faultType === 'WORKER_CRASH_INTERRUPTED') {
      const errObj = {
        code: 'PROCESS_CRASHED',
        message: 'Execution owner lost; reconcile side effects before retry',
        retryable: false,
        details: { subtaskId: targetSub?.id, quarantineSlotRetained: true },
        occurredAt: nowIso()
      };
      const targetRun = state.runs.find((r) => r.taskId === taskId && r.subtaskId === targetSub?.id) || state.runs.find((r) => r.taskId === taskId);
      if (targetRun) {
        targetRun.status = 'interrupted';
        targetRun.endedAt = nowIso();
        targetRun.error = errObj;
        targetRun.version += 1;
        targetRun.updatedAt = nowIso();
        emitEvent('run.updated', targetRun, { taskId, runId: targetRun.id, version: targetRun.version });
      }
      if (targetSub) {
        targetSub.status = 'blocked';
        targetSub.error = errObj;
        targetSub.version += 1;
        targetSub.updatedAt = nowIso();
        emitEvent('subtask.updated', targetSub, { taskId, version: targetSub.version });
      }
      task.error = errObj;
      recomputeTaskAggregates(taskId);
      emitEvent('task.updated', task, { taskId, version: task.version });
      return sendData(res, 200, { injected: faultType, task, subtask: targetSub, run: targetRun || null }, effectiveOrigin);
    }

    return sendError(res, 400, 'INVALID_INPUT', `Unknown faultType: ${faultType}`, false, undefined, effectiveOrigin);
  }

  // Return 404 JSON for unknown /api/* routes
  if (pathname.startsWith('/api/') || pathname.startsWith('/__mock_control/')) {
    return sendError(res, 404, 'NOT_FOUND', `Endpoint ${req.method} ${pathname} not found in v0.2 contract.`, false, undefined, effectiveOrigin);
  }

  // Static file serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[Multi-Agent Collaboration Hub v0.2] Listening on http://${HOST}:${PORT} (contractVersion=0.2, executionMode=mock)`);
  if (process.env.AUTO_TICK === 'true') {
    console.log('[MockScheduler] Auto-tick enabled: active queued/running tasks will advance automatically every 3s.');
    setInterval(() => {
      const activeTask = state.tasks.find(
        (t) => t.provenance !== 'historical' && ['queued', 'running'].includes(t.status)
      );
      if (activeTask) {
        advanceMockStep(activeTask.id);
      }
    }, 3000);
  }
});
