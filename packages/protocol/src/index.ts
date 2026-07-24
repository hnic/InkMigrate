/**
 * @inkmigrate/protocol — Engine 与 GUI 共享的 RPC 协议类型（R12）。
 *
 * 从 apps/engine/src/protocol.ts 提取，作为单一真相源，消除 GUI 侧重声明导致的
 * 类型漂移（如 GUI 的 ResumableJob vs Engine 的 MigrateResumableResult、
 * ProgressEvent vs ProgressNotification）。
 *
 * Engine 的 protocol.ts re-export 本文件 + 保留 RpcRequest/RpcResponse 等传输层
 * 类型（仅 Engine 侧需要）；GUI 从本包导入结果/通知类型。
 */

// ─── 通用 RPC 传输类型（仅 Engine 内部用，但定义在此供双方引用） ───

export interface RpcRequest<P = Record<string, unknown>> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: P;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcNotification<P = Record<string, unknown>> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

// ─── 各方法 Params / Result（GUI 构造 params、消费 result） ───

export interface AuthLoginParams {
  source: string;
  stateDir: string;
  favoritesUrl?: string;
  timeoutMs?: number;
}

export interface AuthLoginResult {
  state: 'logged-in' | 'not-logged-in' | 'auth-state-unknown';
  favoritesUrl?: string;
}

export interface AuthStatusParams {
  source: string;
  stateDir: string;
}

export interface AuthStatusResult {
  profileExists: boolean;
  profilePath: string;
}

export interface ScanStartParams {
  source: string;
  stateDir: string;
  favoritesUrl: string;
  maxItems?: number;
  headless?: boolean;
}

export interface ScanStartResult {
  uniqueItems: number;
  terminationReason: string;
  items: Array<{
    externalId?: string;
    canonicalUrl: string;
    title: string;
    contentKind: string;
  }>;
}

export interface MigrateStartParams {
  source: string;
  target: string;
  stateDir: string;
  vaultPath: string;
  favoritesUrl?: string;
  maxItems?: number;
  intervalMs?: number;
}

export interface MigrateResumeParams {
  job: string;
  stateDir: string;
  vaultPath: string;
  favoritesUrl?: string;
  maxItems?: number;
}

export interface MigrateResumableParams {
  source: string;
  stateDir: string;
}

/** 可续跑 Job 的摘要。`job` 为 null 表示没有可续跑的 Job。 */
export interface MigrateResumableResult {
  job: string | null;
  status?: string;
  total?: number;
  verified?: number;
  targetInstanceId?: string;
}

export interface MigrateResult {
  /** 对齐 core 的 JobStatus：created|running|paused|interrupted|completed|failed */
  status: 'created' | 'running' | 'paused' | 'interrupted' | 'completed' | 'failed';
  scanCount: number;
  reconciliationOk: boolean;
  reconciliationReason?: string;
  jobId: string;
}

export interface CleanupUnfavoriteParams {
  source: string;
  stateDir: string;
  maxItems?: number;
  intervalMs?: number;
  /** M6: 服务端危险操作确认令牌。 */
  confirmed?: boolean;
}

export interface CleanupResult {
  successCount: number;
  skipCount: number;
  failCount: number;
  unknownCount: number;
  /** §5/§14.12 因登录墙/风控挑战而受控中断的条目数。GUI 据此提示用户重新登录。 */
  loginPauseCount: number;
  /** §5/§14.12 受控中断原因（'login_required' | 'challenge_required'），无则 undefined。 */
  pauseReason?: string;
}

export interface StatusQueryParams {
  job: string;
  stateDir: string;
}

export interface StatusQueryResult {
  /** 对齐 core 的 JobStatus */
  status: 'created' | 'running' | 'paused' | 'interrupted' | 'completed' | 'failed';
  currentStage: string;
  scanCount: number;
  verifiedCount: number;
  degradedCount: number;
  failedCount: number;
  conflictCount: number;
  skippedCount: number;
}

// ─── 通知类型（GUI 监听 sidecar 事件用） ───

export interface ProgressNotification {
  jobId?: string;
  phase: 'scanning' | 'migrating' | 'cleanup' | 'login';
  current: number;
  total: number;
  currentItem?: string;
  /** 子阶段标签（如 scanning/migrating 内的 extracting/reporting），GUI 显示用。 */
  stage?: string;
  counts?: {
    verified?: number;
    degraded?: number;
    failed?: number;
    conflict?: number;
    skipped?: number;
  };
}

export interface LogNotification {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface HealthDegradedNotification {
  /** 降级原因类别。当前固定 "uncaughtException"；为将来扩展其他降级源预留。 */
  reason: 'uncaughtException';
  /** err.message */
  message: string;
  /** err.stack，完整不脱敏（本地诊断用，不落盘不分享） */
  stack?: string;
}

// ─── 方法映射（类型安全 dispatch 用） ───

export interface RpcMethodMap {
  'auth.login': { params: AuthLoginParams; result: AuthLoginResult };
  'auth.status': { params: AuthStatusParams; result: AuthStatusResult };
  'auth.clear': { params: AuthStatusParams; result: { cleared: boolean } };
  'scan.start': { params: ScanStartParams; result: ScanStartResult };
  'migrate.start': { params: MigrateStartParams; result: MigrateResult };
  'migrate.resume': { params: MigrateResumeParams; result: MigrateResult };
  'migrate.resumable': { params: MigrateResumableParams; result: MigrateResumableResult };
  'cleanup.unfavorite': { params: CleanupUnfavoriteParams; result: CleanupResult };
  'status.query': { params: StatusQueryParams; result: StatusQueryResult };
  'job.cancel': { params: JobCancelParams; result: { cancelling: boolean } };
}

/** 取消当前活跃任务。job 可选（留空 = 取消当前任务），为前向兼容指定 job 预留。 */
export interface JobCancelParams {
  job?: string;
}

export type RpcMethodName = keyof RpcMethodMap;
