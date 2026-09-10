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
import type { JobStatus as CoreJobStatus, SourceContentKind } from '@inkmigrate/core';

/** 对齐 core 的 JobStatus（type-only re-export，单一真相源，core 加状态即同步）。 */
export type JobStatus = CoreJobStatus;

// ─── 通用 RPC 传输类型（仅 Engine 内部用，但定义在此供双方引用） ───

export interface RpcRequest<P = Record<string, unknown>> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: P;
}

/**
 * JSON-RPC 2.0 规定响应只能携带 result 或 error 之一——用可辨识联合在类型层面
 * 强制该不变量（error?: undefined / result?: undefined 标记保持字段可探测）。
 * parse error(-32700)/invalid request(-32600) 的响应按规范必须携带 id: null。
 */
export type RpcResponse<T = unknown> =
  | { jsonrpc: '2.0'; id: string | number; result: T; error?: undefined }
  | { jsonrpc: '2.0'; id: string | number; result?: undefined; error: RpcError }
  | { jsonrpc: '2.0'; id: null; result?: undefined; error: RpcError };

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
  /** 扫描终止原因（词表在 toutiao scanner：unknown/cancelled/no_load_more/
   * max_items_reached_<n>/no_new_items_after_<n>_cycles，含动态后缀，保持 string）。 */
  terminationReason: string;
  items: Array<{
    externalId?: string;
    canonicalUrl: string;
    title: string;
    contentKind: SourceContentKind;
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
  /**
   * §10.2 inkmigrate.yaml 路径（Evernote 等文件源）：engine 按 source id 与
   * 配置中的 adapter 分派来源类型。可选——未传时维持 toutiao 行为（向后兼容）。
   */
  configPath?: string;
}

export interface MigrateResumeParams {
  job: string;
  stateDir: string;
  vaultPath: string;
  favoritesUrl?: string;
  maxItems?: number;
  /** 同 MigrateStartParams.configPath。 */
  configPath?: string;
}

export interface MigrateResumableParams {
  source: string;
  stateDir: string;
}

/** 可续跑 Job 的摘要。判别联合：`job: null` 表示没有可续跑的 Job（不携带其他字段）。 */
export type MigrateResumableResult =
  | { job: null }
  | {
      job: string;
      status: JobStatus;
      total: number;
      verified: number;
      targetInstanceId?: string;
    };

export interface MigrateResult {
  status: JobStatus;
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
  /** §5/§14.12 受控中断原因（toutiao cleanup 实际只会发出这两种），无则 undefined。 */
  pauseReason?: 'login_required' | 'challenge_required';
}

export interface StatusQueryParams {
  job: string;
  stateDir: string;
}

export interface StatusQueryResult {
  status: JobStatus;
  /** 管线阶段（规范词表在 core 的 §11.1 current_stage 定义：preflight/scan/…）。 */
  currentStage: string;
  scanCount: number;
  verifiedCount: number;
  degradedCount: number;
  failedCount: number;
  conflictCount: number;
  skippedCount: number;
}

/** §15 Evernote 等文件源的预览扫描（不写库、不启动浏览器）。 */
export interface ScanPreviewParams {
  source: string;
  stateDir: string;
  configPath: string;
}

export interface ScanPreviewResult {
  sourceInstanceId: string;
  uniqueItems: number;
  /** Stack/笔记本 → 条目数（无 Stack 时仅笔记本名）。 */
  byNotebook: Record<string, number>;
  /** 非致命问题（损坏文件、.notes 拒绝前的提示等）。 */
  issues: string[];
  /** 跳过的输入文件（非 .enex/.html）。 */
  skipped: string[];
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

/** 通知方法名 → params 映射（方法名以 engine 的 sendNotification 调用点为准）。 */
export interface RpcNotificationMap {
  progress: ProgressNotification;
  log: LogNotification;
  health_degraded: HealthDegradedNotification;
}

export type RpcNotificationName = keyof RpcNotificationMap;

export interface RpcMethodMap {
  'auth.login': { params: AuthLoginParams; result: AuthLoginResult };
  'auth.status': { params: AuthStatusParams; result: AuthStatusResult };
  'auth.clear': { params: AuthStatusParams; result: { cleared: boolean } };
  'scan.start': { params: ScanStartParams; result: ScanStartResult };
  'scan.preview': { params: ScanPreviewParams; result: ScanPreviewResult };
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
