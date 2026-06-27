/**
 * JSON-RPC 2.0 协议定义（over stdio）。
 *
 * Tauri Rust 后端通过 stdin 向 sidecar 发送 Request，
 * sidecar 通过 stdout 返回 Response 或推送 Notification。
 */

// ─── 请求 ───

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

/** 所有消息的联合类型（stdout 输出）。 */
export type RpcMessage<T = unknown> = RpcResponse<T> | RpcNotification;

// ─── 方法定义 ───

export interface AuthLoginParams {
  source: string;
  stateDir: string;
  favoritesUrl?: string;
  timeoutMs?: number;
}

export interface AuthLoginResult {
  state: 'logged-in' | 'not-logged-in' | 'auth-state-unknown';
  /** 登录成功后自动提取的收藏页 URL。 */
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

/** 查询某 source 下最近一个可续跑的迁移 Job。 */
export interface MigrateResumableParams {
  source: string;
  stateDir: string;
}

/** 可续跑 Job 的摘要。`job` 为 null 表示没有可续跑的 Job。 */
export interface MigrateResumableResult {
  job: string | null;
  /** 该 Job 的终态状态（interrupted / paused）。 */
  status?: string;
  /** 该 source 实例下的 source_items 总条目数。 */
  total?: number;
  /** 已 verified 的条目数（续跑会跳过这些）。 */
  verified?: number;
  /** 原 Job 绑定的 target 实例 ID，便于前端回显。 */
  targetInstanceId?: string;
}

export interface MigrateResult {
  status: string;
  scanCount: number;
  reconciliationOk: boolean;
  reconciliationReason?: string;
  jobId: string;
}

export interface CleanupUnfavoriteParams {
  source: string;
  stateDir: string;
  maxItems?: number;
}

export interface CleanupResult {
  successCount: number;
  skipCount: number;
  failCount: number;
}

export interface StatusQueryParams {
  job: string;
  stateDir: string;
}

export interface StatusQueryResult {
  status: string;
  currentStage: string;
  scanCount: number;
  verifiedCount: number;
  degradedCount: number;
  failedCount: number;
  conflictCount: number;
  skippedCount: number;
}

// ─── 通知 ───

export interface ProgressNotification {
  jobId?: string;
  phase: 'scanning' | 'migrating' | 'cleanup' | 'login';
  current: number;
  total: number;
  currentItem?: string;
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

/** 所有 RPC 方法的参数和返回值类型映射。 */
export interface RpcMethodMap {
  'auth.login': { params: AuthLoginParams; result: AuthLoginResult };
  'auth.status': { params: AuthStatusParams; result: AuthStatusResult };
  'auth.clear': { params: AuthStatusParams; result: { cleared: boolean } };
  'scan.start': { params: ScanStartParams; result: ScanStartResult };
  'migrate.start': { params: MigrateStartParams; result: MigrateResult };
  'migrate.resume': { params: MigrateResumeParams; result: MigrateResult };
  /** 查询某 source 下最近一个可续跑 Job（不启动任务）。 */
  'migrate.resumable': { params: MigrateResumableParams; result: MigrateResumableResult };
  'cleanup.unfavorite': { params: CleanupUnfavoriteParams; result: CleanupResult };
  'status.query': { params: StatusQueryParams; result: StatusQueryResult };
  /** 终止当前正在运行的长任务（scan/migrate/cleanup）。幂等。 */
  'cancel.cancel': { params: Record<string, unknown>; result: { cancelling: boolean } };
}

export type RpcMethodName = keyof RpcMethodMap;
