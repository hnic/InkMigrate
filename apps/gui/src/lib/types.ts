/** 全局共享类型定义。 */
// R12: RPC 协议类型从 @inkmigrate/protocol 共享包导入，消除重声明漂移。
export type {
  ProgressNotification as ProgressEvent,
  LogNotification,
  MigrateResumableResult as ResumableJob,
  MigrateResult,
  StatusQueryResult,
  ScanStartResult,
  CleanupResult,
  AuthLoginResult,
  AuthStatusResult,
} from '@inkmigrate/protocol';

import type { LogNotification } from '@inkmigrate/protocol';

/** GUI 本地日志条目（含 timestamp，由 useSidecar 在收到通知时附加）。 */
export interface LogEntry extends LogNotification {
  timestamp: number;
}

export interface AppSettings {
  stateDir: string;
  vaultPath: string;
  favoritesUrl: string;
  source: string;
  target: string;
  /** 登录状态（由 LoginPage 检测后写入） */
  loggedIn?: boolean;
}

export type PageId = 'login' | 'scan' | 'migrate' | 'cleanup' | 'report' | 'settings';

export type OperationState = 'idle' | 'loading' | 'success' | 'failed';
