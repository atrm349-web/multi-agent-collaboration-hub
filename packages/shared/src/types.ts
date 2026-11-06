/**
 * Multi-Agent Collaboration Hub — Unified Shared DTO Types (v0.2)
 * Synchronized with packages/shared/src/types.v0.2.ts and docs/api-contract.md (v0.2).
 */
export type ExecutionMode = 'mock' | 'live';
export type Provenance = 'current' | 'historical';
export type Capability = 'stream' | 'resume' | 'cancel' | 'live-context' | 'structured-output';
export type TaskStatus = 'draft' | 'decomposing' | 'queued' | 'running' |
  'waiting_approval' | 'pausing' | 'paused' | 'cancelling' |
  'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type SubtaskStatus = 'pending' | 'ready' | 'running' | 'validating' |
  'waiting_approval' | 'retry_wait' | 'blocked' | 'succeeded' | 'failed' |
  'timed_out' | 'cancelled';
export type RunStatus = 'queued' | 'starting' | 'running' | 'cancelling' |
  'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated';
export type Stage = 'analysis' | 'implementation' | 'testing' | 'review' | 'documentation';
export interface StructuredError {
  code: string; message: string; retryable: boolean;
  details?: Record<string, unknown>; occurredAt?: string;
}
export interface Entity {
  id: string; version: number; createdAt: string; updatedAt: string;
  executionMode: ExecutionMode;
}
export interface EvidenceEntity extends Entity { provenance: Provenance }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface ApiResponse<T> { data: T; requestId: string }
export interface ApiError { error: StructuredError; requestId: string }
export interface AcceptanceCriterion { id: string; description: string; testProfileId?: string }
export interface RepositoryRef { id: string; label: string; baseBranch: string; baseCommit: string }
export interface Task extends EvidenceEntity {
  title: string; goal: string; repositoryId: string; baseCommit: string;
  status: TaskStatus; priority: 'low' | 'medium' | 'high' | 'critical';
  progressPct: number; pendingApprovalCount: number; artifactCount: number;
  acceptanceCriteria: AcceptanceCriterion[]; error: StructuredError | null;
  startedAt: string | null; endedAt: string | null; deadlineAt: string | null;
}
export interface PlannedSubtask {
  id: string; code: string; title: string; description: string; stage: Stage;
  dependsOn: string[]; requiredCapabilities: Capability[];
  acceptanceCriteria: AcceptanceCriterion[];
}
export interface Subtask extends Entity, PlannedSubtask {
  taskId: string; status: SubtaskStatus; assignedAgentId: string | null;
  workspaceId: string | null; branchName: string | null; progressPct: number;
  attempt: number; maxAttempts: number; timeoutMs: number; idleTimeoutMs?: number;
  outputArtifactIds: string[]; error: StructuredError | null;
}
export interface Agent extends Entity {
  label: string; roleTitle: string; adapterId: string; adapterVersion: string;
  availability: 'unknown' | 'available' | 'busy' | 'unavailable' | 'disabled';
  capabilities: Capability[]; unsupportedReasons?: Partial<Record<Capability, string>>;
  supportedStages: Stage[]; permissionProfile: string; maxConcurrency: number;
}
export interface AgentRun extends EvidenceEntity {
  taskId: string; subtaskId: string; agentId: string; status: RunStatus;
  attempt: number; providerSessionId: string | null; workspaceId: string;
  startedAt: string | null; endedAt: string | null; exitCode: number | null;
  error: StructuredError | null;
}
export interface Message extends EvidenceEntity {
  taskId: string; fromRunId: string | null; toSubtaskId: string;
  fromLabel: string; toLabel: string; summary: string; content: string;
  kind: 'task_decomposition' | 'context_handoff' | 'review_feedback' |
    'approval_request' | 'rework_instruction' | 'error_alert' | 'human_directive';
  correlationId: string; causationId: string | null; artifactRefs: string[];
  deliveredAt: string | null;
}
export interface Artifact extends EvidenceEntity {
  taskId: string; subtaskId: string; producerRunId: string; name: string;
  relativePath: string; sha256: string; sizeBytes: number; mimeType: string;
  category: 'code' | 'diff' | 'test_report' | 'documentation' | 'config';
  validationStatus: 'staged' | 'validated' | 'rejected';
  diffStats?: { filesChanged: number; insertions: number; deletions: number };
  testSummary?: { total: number; passed: number; failed: number; coveragePct?: number };
}
export interface Approval extends Entity {
  taskId: string; subtaskId: string; runId: string;
  actionType: string; actionDigest: string; summary: string;
  status: ApprovalStatus; expiresAt: string; artifactRefs: string[];
  diffArtifactId?: string; decidedAt: string | null; decidedBy: string | null;
}
export interface Validation extends EvidenceEntity {
  taskId: string; subtaskId: string; runId: string; criterionId: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'unverified';
  exitCode: number | null; evidenceArtifactIds: string[];
}
export interface TaskDetail {
  task: Task; subtasks: Subtask[]; runs: Page<AgentRun>;
  validations: Page<Validation>; approvals: Page<Approval>; artifacts: Page<Artifact>;
}
export interface DraftPlan { id: string; repositoryId: string; goal: string; subtasks: PlannedSubtask[]; executionMode: ExecutionMode }
export interface CreateTaskRequest {
  title: string; goal: string; repositoryId: string;
  acceptanceCriteria: AcceptanceCriterion[]; priority?: Task['priority'];
  plannedSubtasks?: PlannedSubtask[];
}
export interface Meta {
  contractVersion: '0.2'; executionMode: ExecutionMode;
  liveExecutionAvailable: boolean; enabledFeatures: string[];
}
export interface Snapshot {
  schemaVersion: '0.2'; snapshotSeq: number;
  tasks: Page<Task>; agents: Page<Agent>; selectedTask: TaskDetail | null;
}
export interface LogLine {
  logSeq: number; timestamp: string; stream: 'stdout' | 'stderr' | 'system';
  text: string; drained?: boolean;
}
export interface LogPage { runId: string; items: LogLine[]; nextSeq: number; hasMore: boolean }
export type EventType = 'task.updated' | 'subtask.updated' | 'agent.updated' |
  'run.updated' | 'run.output' | 'message.created' | 'artifact.created' |
  'validation.completed' | 'approval.required' | 'approval.decided';
export interface EventEnvelope {
  schemaVersion: '0.2'; seq: number; type: EventType; timestamp: string;
  taskId?: string; runId?: string; version?: number; payload: Record<string, unknown>;
}
