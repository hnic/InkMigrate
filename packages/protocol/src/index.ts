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
  intervalMs?: number;
  /** M6: 服务端危险操作确认令牌。 */
  confirmed?: boolean;
}

export interface CleanupResult {
  successCount: number;
  skipCount: number;
  failCount: number;
  unknownCount: number;
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
  'cancel.cancel': { params: Record<string, unknown>; result: { cancelling: boolean } };
}

export type RpcMethodName = keyof RpcMethodMap;
