/** 全局共享类型定义。 */
// R12: RPC 协议类型从 @inkmigrate/protocol 共享包导入，消除重声明漂移。
export type {
  ProgressNotification as ProgressEvent,
  LogNotification,
  MigrateResumableResult as ResumableJob,
  MigrateResult,
  StatusQueryResult,
  AuthLoginResult,
  AuthStatusResult,
  HealthDegradedNotification,
} from '@inkmigrate/protocol';

import type { LogNotification } from '@inkmigrate/protocol';

/** GUI 本地日志条目（含自增 id 与 timestamp，由 useSidecar 在收到通知时附加）。 */
export interface LogEntry extends LogNotification {
  id: number;
  timestamp: number;
}

/** 来源类型常量表：类型联合与运行时校验共用同一真相源，新增 adapter 不会漂移。 */
export const SOURCE_ADAPTER_KINDS = ['toutiao', 'evernote'] as const;

/** 来源类型：toutiao（浏览器收藏）| evernote（ENEX/HTML 导出文件，无需登录）。 */
export type SourceAdapterKind = (typeof SOURCE_ADAPTER_KINDS)[number];

export interface AppSettings {
  stateDir: string;
  vaultPath: string;
  favoritesUrl: string;
  source: string;
  target: string;
  /** 登录状态（由 LoginPage 检测后写入） */
  loggedIn?: boolean;
  /** 来源类型，见 SourceAdapterKind。 */
  sourceAdapter?: SourceAdapterKind;
  /** inkmigrate.yaml 路径（evernote 来源必填；含 inputPaths/formats 等定义）。 */
  configPath?: string;
}

export type PageId = 'login' | 'scan' | 'migrate' | 'cleanup' | 'report' | 'settings';

export type OperationState = 'idle' | 'loading' | 'success' | 'failed';
