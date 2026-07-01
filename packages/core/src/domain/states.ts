// §11.1 Job 生命周期
export const JOB_STATUS = [
  'created',
  'running',
  'paused',
  'interrupted',
  'completed',
  'failed',
] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

// §11.1 受控暂停原因（前置条件可恢复）
export const JOB_PAUSE_REASONS = [
  'auth_required',
  'challenge_required',
  'rate_limited',
  'manual_intervention_required',
  'operator_paused',
] as const;
export type JobPauseReason = (typeof JOB_PAUSE_REASONS)[number];

// §11.1 current_stage 管线
export const CURRENT_STAGES = [
  'preflight',
  'scanning',
  'planning',
  'extracting',
  'normalizing',
  'transferring_assets',
  'writing_target',
  'verifying_target',
  'generating_indexes',
  'reporting',
  'completed',
] as const;
export type CurrentStage = (typeof CURRENT_STAGES)[number];

// §11.1 条目正常处理路径
export const ITEM_PROCESSING_STATES = [
  'discovered',
  'queued',
  'extracting',
  'extracted',
  'normalized',
  'assets_ready',
  'writing',
  'written',
  'verified',
] as const;
export type ItemProcessingState = (typeof ITEM_PROCESSING_STATES)[number];

// §11.1 可恢复状态，不计入完成对账终态。
// 限流（429/503）未处理条目归入 interrupted（可恢复，断点续跑），不另设终态，
// 以符合规格 §11.1：rate_limited 是 Job 级 paused 的 pause_reason，非条目终态。
export const ITEM_RECOVERABLE_STATES = [
  'retryable_failed',
  'interrupted',
] as const;
export type ItemRecoverableState = (typeof ITEM_RECOVERABLE_STATES)[number];

// §11.1 本 Job 完整性方程允许的条目终态（规格 §11.1 七个终态）
export const ITEM_FINAL_STATES = [
  'verified',
  'degraded',
  'permanent_failed',
  'unsupported',
  'blocked',
  'conflict',
  'skipped',
] as const;
export type ItemFinalState = (typeof ITEM_FINAL_STATES)[number];

// §11.9 完整性方程允许的终态（与 ITEM_FINAL_STATES 一致，显式列出便于引用）
export const COMPLETION_EQUATION_TERMS = [
  'verified',
  'degraded',
  'permanent_failed',
  'unsupported',
  'blocked',
  'conflict',
  'skipped',
] as const;

// §16.6 target_artifacts.status 受控值
export const ARTIFACT_STATUSES = [
  'planned',
  'written',
  'verified',
  'conflict',
  'superseded',
  'invalid',
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

// §16.6 target_artifacts.artifact_kind 受控值
export const ARTIFACT_KINDS = [
  'note',
  'note_variant',
  'index',
  'report',
  'manifest',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// §16.7 migration_attempts.attempt_scope 受控值
export const ATTEMPT_SCOPES = ['job', 'item'] as const;
export type AttemptScope = (typeof ATTEMPT_SCOPES)[number];

// §16.7 / §17.5 migration_attempts.action_code 核心保留值
export const ACTION_CODES = [
  'stage_attempt',
  'source_update',
  'quality_upgrade',
  'forced_overwrite',
  'write_new_variant',
  'metadata_update',
] as const;
export type ActionCode = (typeof ACTION_CODES)[number];

export interface FinalStateCounts {
  verified: number;
  degraded: number;
  permanent_failed: number;
  unsupported: number;
  blocked: number;
  conflict: number;
  skipped: number;
}

export interface CompletionEquationInput {
  scanCount: number;
  counts: FinalStateCounts;
  recoverable: number;
}

/**
 * §11.9 完整性方程校验：
 *   scan_count == verified + degraded + permanent_failed + unsupported
 *                 + blocked + conflict + skipped
 * 且不存在悬挂的可恢复状态（retryable_failed / interrupted）。
 */
export function verifyCompletionEquation(
  input: CompletionEquationInput,
): boolean {
  if (input.recoverable !== 0) return false;
  const sum =
    input.counts.verified +
    input.counts.degraded +
    input.counts.permanent_failed +
    input.counts.unsupported +
    input.counts.blocked +
    input.counts.conflict +
    input.counts.skipped;
  return sum === input.scanCount;
}

/** §11.9 failed_count 聚合：permanent_failed + unsupported + blocked。 */
export function aggregateFailedCount(c: FinalStateCounts): number {
  return c.permanent_failed + c.unsupported + c.blocked;
}

export function isItemFinalState(v: unknown): v is ItemFinalState {
  return (
    typeof v === 'string' &&
    (ITEM_FINAL_STATES as readonly string[]).includes(v)
  );
}

export function isItemRecoverableState(
  v: unknown,
): v is ItemRecoverableState {
  return (
    typeof v === 'string' &&
    (ITEM_RECOVERABLE_STATES as readonly string[]).includes(v)
  );
}

export function isJobStatus(v: unknown): v is JobStatus {
  return typeof v === 'string' && (JOB_STATUS as readonly string[]).includes(v);
}

/**
 * §11.1 Job status 合法转换矩阵（单一真相源）。
 *
 * M9: 此前 runtime/job-state.ts 与 storage/repositories/migration-jobs.ts 各持一份
 * 手动同步的副本，注释承认「两处需同步」但无测试约束，漂移必然发生。提升到 domain 层
 * （runtime 和 storage 都已依赖 domain），两处引用同一常量，消除分叉。
 *
 * paused 不是终态；从 paused 恢复必须先复核暂停原因。
 * interrupted 恢复前必须重检悬挂状态。
 * completed/failed 是终态，不可再转换。
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  created: new Set<JobStatus>(['running', 'failed']),
  running: new Set<JobStatus>(['paused', 'interrupted', 'completed', 'failed']),
  paused: new Set<JobStatus>(['running', 'failed']),
  interrupted: new Set<JobStatus>(['running', 'failed']),
  completed: new Set<JobStatus>(),
  failed: new Set<JobStatus>(),
};

/**
 * §11.1 跨状态转换合法性（不含自环）。
 * 调用方若需允许「同 status 内推进 current_stage」（自环），自行处理 to===from。
 */
export function canJobTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].has(to);
}

// §16.9 cleanup_jobs 生命周期（比 migration_jobs 简单：无 paused/failed）
export const CLEANUP_JOB_STATUS = [
  'created',
  'running',
  'completed',
  'interrupted',
] as const;
export type CleanupJobStatus = (typeof CLEANUP_JOB_STATUS)[number];

export function isCleanupJobStatus(v: unknown): v is CleanupJobStatus {
  return (
    typeof v === 'string' &&
    (CLEANUP_JOB_STATUS as readonly string[]).includes(v)
  );
}

/**
 * §16.9 cleanup_jobs 合法转换矩阵（N4: 单一真相源，供 storage 守卫复用）。
 * created → running；running → completed/interrupted；终态不可再转换。
 */
export const CLEANUP_JOB_TRANSITIONS: Readonly<
  Record<CleanupJobStatus, ReadonlySet<CleanupJobStatus>>
> = {
  created: new Set<CleanupJobStatus>(['running', 'interrupted']),
  running: new Set<CleanupJobStatus>(['completed', 'interrupted']),
  completed: new Set<CleanupJobStatus>(),
  interrupted: new Set<CleanupJobStatus>(),
};

export function canCleanupJobTransition(
  from: CleanupJobStatus,
  to: CleanupJobStatus,
): boolean {
  return CLEANUP_JOB_TRANSITIONS[from].has(to);
}

export function isJobPauseReason(v: unknown): v is JobPauseReason {
  return (
    typeof v === 'string' &&
    (JOB_PAUSE_REASONS as readonly string[]).includes(v)
  );
}

export function isCurrentStage(v: unknown): v is CurrentStage {
  return (
    typeof v === 'string' &&
    (CURRENT_STAGES as readonly string[]).includes(v)
  );
}

export function isArtifactStatus(v: unknown): v is ArtifactStatus {
  return (
    typeof v === 'string' &&
    (ARTIFACT_STATUSES as readonly string[]).includes(v)
  );
}

export function isArtifactKind(v: unknown): v is ArtifactKind {
  return (
    typeof v === 'string' &&
    (ARTIFACT_KINDS as readonly string[]).includes(v)
  );
}

export function isAttemptScope(v: unknown): v is AttemptScope {
  return (
    typeof v === 'string' &&
    (ATTEMPT_SCOPES as readonly string[]).includes(v)
  );
}

export function isActionCode(v: unknown): v is ActionCode {
  return (
    typeof v === 'string' &&
    (ACTION_CODES as readonly string[]).includes(v)
  );
}
