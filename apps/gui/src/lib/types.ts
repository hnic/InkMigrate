/** 全局共享类型定义。 */

export interface AppSettings {
  stateDir: string;
  vaultPath: string;
  favoritesUrl: string;
  source: string;
  target: string;
  /** 登录状态（由 LoginPage 检测后写入） */
  loggedIn?: boolean;
}

export interface ProgressEvent {
  jobId?: string;
  phase: 'scanning' | 'migrating' | 'cleanup' | 'login' | string;
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

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export type PageId = 'login' | 'scan' | 'migrate' | 'cleanup' | 'report' | 'settings';

export type OperationState = 'idle' | 'loading' | 'success' | 'failed';
