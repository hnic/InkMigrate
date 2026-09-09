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

// §11.9 完整性方程允许的终态：直接复用 ITEM_FINAL_STATES 作为单一真相源，
// 避免两份字面量列表仅靠测试维持同步。
export const COMPLETION_EQUATION_TERMS = ITEM_FINAL_STATES;

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

// 由 ItemFinalState 联合派生，保证七个键与终态词表同步
export type FinalStateCounts = Record<ItemFinalState, number>;

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
  // 负数计数（聚合器损坏时可能出现）会让荒谬的组合凑平方程，先行拒绝
  if (input.scanCount < 0) return false;
  if (Object.values(input.counts).some((n) => n < 0)) return false;
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

/** §11.9 failed 口径的失败类终态（failed_count = permanent_failed + unsupported + blocked）。 */
export const FAILED_FINAL_STATES = [
  'permanent_failed',
  'unsupported',
  'blocked',
] as const;

/** §11.9 failed_count 聚合：permanent_failed + unsupported + blocked。 */
export function aggregateFailedCount(c: FinalStateCounts): number {
  return FAILED_FINAL_STATES.reduce((acc, s) => acc + c[s], 0);
}

/** 字符串词表守卫的通用构造器，避免每个词表手写一遍相同的判定体。 */
function makeStringGuard<T extends string>(values: readonly T[]) {
  return (v: unknown): v is T =>
    typeof v === 'string' && (values as readonly string[]).includes(v);
}

export const isItemFinalState = makeStringGuard(ITEM_FINAL_STATES);

export const isItemRecoverableState =
  makeStringGuard(ITEM_RECOVERABLE_STATES);

export const isJobStatus = makeStringGuard(JOB_STATUS);

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
  // 运行期 from 越界（如从存储读出的脏值）时返回 false 而非抛 TypeError
  return JOB_TRANSITIONS[from]?.has(to) ?? false;
}

// §16.9 cleanup_jobs 生命周期
// M-6: interrupted 允许 → running（恢复语义，与 migration-jobs 一致）。
// 不加 failed（orchestrator 用 interrupted 表达硬失败；加 failed 需 schema v4
// 重建 cleanup_jobs CHECK，且当前无人写入，留后续）。
export const CLEANUP_JOB_STATUS = [
  'created',
  'running',
  'completed',
  'interrupted',
] as const;
export type CleanupJobStatus = (typeof CLEANUP_JOB_STATUS)[number];

export const isCleanupJobStatus = makeStringGuard(CLEANUP_JOB_STATUS);

/**
 * §16.9 cleanup_jobs 合法转换矩阵（N4: 单一真相源，供 storage 守卫复用）。
 * M-6: interrupted → running 允许恢复（原为终态，resume 实际靠新建 job 绕过，
 * 但补此转换使状态机语义完整，与 migration-jobs 对齐）。completed 是终态。
 */
export const CLEANUP_JOB_TRANSITIONS: Readonly<
  Record<CleanupJobStatus, ReadonlySet<CleanupJobStatus>>
> = {
  created: new Set<CleanupJobStatus>(['running', 'interrupted']),
  running: new Set<CleanupJobStatus>(['completed', 'interrupted']),
  completed: new Set<CleanupJobStatus>(),
  interrupted: new Set<CleanupJobStatus>(['running']),
};

export function canCleanupJobTransition(
  from: CleanupJobStatus,
  to: CleanupJobStatus,
): boolean {
  // 同 canJobTransition：越界 from 视为非法转换而非崩溃
  return CLEANUP_JOB_TRANSITIONS[from]?.has(to) ?? false;
}

export const isJobPauseReason = makeStringGuard(JOB_PAUSE_REASONS);

export const isCurrentStage = makeStringGuard(CURRENT_STAGES);

export const isArtifactStatus = makeStringGuard(ARTIFACT_STATUSES);

export const isArtifactKind = makeStringGuard(ARTIFACT_KINDS);

export const isAttemptScope = makeStringGuard(ATTEMPT_SCOPES);

export const isActionCode = makeStringGuard(ACTION_CODES);
