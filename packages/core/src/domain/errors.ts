export const ERROR_CATEGORIES = [
  'config',
  'auth',
  'network',
  'parse',
  'extract',
  'asset',
  'target',
  'verify',
  'cleanup',
  'internal',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ITEM_DISPOSITIONS = [
  'permanent_failed',
  'unsupported',
  'blocked',
] as const;
export type ItemDisposition = (typeof ITEM_DISPOSITIONS)[number];

/**
 * §11.5 适配器契约错误码：条目级、不可重试错误缺少 `itemDisposition`。
 * 核心不得猜测处置方式，应停止提交该条目并报告此码。
 */
export const ADAPTER_ERROR_DISPOSITION_MISSING =
  'ADAPTER_ERROR_DISPOSITION_MISSING';

export interface InkMigrateError {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  /** 仅用于条目级、不可重试错误 */
  itemDisposition?: ItemDisposition;
  userMessage: string;
  technicalMessage?: string;
  cause?: unknown;
}

export function isErrorCategory(v: unknown): v is ErrorCategory {
  return (
    typeof v === 'string' &&
    (ERROR_CATEGORIES as readonly string[]).includes(v)
  );
}

export function isItemDisposition(v: unknown): v is ItemDisposition {
  return (
    typeof v === 'string' &&
    (ITEM_DISPOSITIONS as readonly string[]).includes(v)
  );
}

/**
 * 校验错误对象是否符合 §20.2 / §11.5 的 itemDisposition 契约。
 *
 * 规则：
 * 1. `retryable: true` 时不得携带 `itemDisposition` —— 可重试错误统一进入 `retryable_failed`。
 * 2. `retryable: false` 且 `scope='item'` 时必须携带 `itemDisposition`，缺失视为
 *    `ADAPTER_ERROR_DISPOSITION_MISSING`（适配器契约错误，核心不得猜测）。
 * 3. 若携带 `itemDisposition`，其值必须是三个合法枚举之一。
 * 4. `scope='job'`（默认 `'item'`）时不可重试错误可以省略 `itemDisposition`
 *    —— Job 级认证、限流、安全验证或内部错误按 Job 生命周期处理。
 */
export function assertItemDispositionContract(
  err: InkMigrateError,
  scope: 'job' | 'item' = 'item',
): void {
  if (err.retryable && err.itemDisposition !== undefined) {
    throw new Error(
      `retryable=true errors must not carry itemDisposition (code=${err.code})`,
    );
  }
  if (scope === 'job' && err.itemDisposition !== undefined) {
    throw new Error(
      `job-level errors must not carry itemDisposition; it is reserved for item-level non-retryable errors (code=${err.code})`,
    );
  }
  if (err.itemDisposition !== undefined && !isItemDisposition(err.itemDisposition)) {
    throw new Error(
      `itemDisposition must be one of permanent_failed|unsupported|blocked, got: ${String(err.itemDisposition)} (code=${err.code})`,
    );
  }
  if (
    !err.retryable &&
    scope === 'item' &&
    err.itemDisposition === undefined
  ) {
    throw new Error(
      `${ADAPTER_ERROR_DISPOSITION_MISSING}: item-level non-retryable error missing itemDisposition (code=${err.code})`,
    );
  }
}

export type InkMigrateErrorObject = InkMigrateError & Error;

/**
 * 将纯数据形态的 `InkMigrateError` 转换为同时携带领域字段的 `Error` 实例，
 * 便于在 `throw` 链路中保留结构化信息。
 */
export function toInkMigrateError(err: InkMigrateError): InkMigrateErrorObject {
  const e = new Error(err.userMessage) as InkMigrateErrorObject;
  e.code = err.code;
  e.category = err.category;
  e.retryable = err.retryable;
  if (err.itemDisposition !== undefined) e.itemDisposition = err.itemDisposition;
  if (err.technicalMessage !== undefined) e.technicalMessage = err.technicalMessage;
  e.cause = err.cause;
  return e;
}
