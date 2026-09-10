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

/** 条目处置契约的其余违规（可重试却携带处置 / Job 级携带处置 / 枚举值非法）。 */
export const ITEM_DISPOSITION_CONTRACT_VIOLATION =
  'ITEM_DISPOSITION_CONTRACT_VIOLATION';

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

/** 枚举词表守卫的通用构造器：判定体只写一份，词表之间不会各自漂移。 */
function makeEnumGuard<T extends string>(values: readonly T[]) {
  return (v: unknown): v is T =>
    typeof v === 'string' && (values as readonly string[]).includes(v);
}

export const isErrorCategory = makeEnumGuard(ERROR_CATEGORIES);
export const isItemDisposition = makeEnumGuard(ITEM_DISPOSITIONS);

/**
 * 校验错误对象是否符合 §20.2 / §11.5 的 itemDisposition 契约。
 *
 * 规则：
 * 1. `retryable: true` 时不得携带 `itemDisposition` —— 可重试错误统一进入 `recoverable_failed`。
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
    throwContractViolation(
      ITEM_DISPOSITION_CONTRACT_VIOLATION,
      `retryable=true errors must not carry itemDisposition (code=${err.code})`,
    );
  }
  if (scope === 'job' && err.itemDisposition !== undefined) {
    throwContractViolation(
      ITEM_DISPOSITION_CONTRACT_VIOLATION,
      `job-level errors must not carry itemDisposition; it is reserved for item-level non-retryable errors (code=${err.code})`,
    );
  }
  if (err.itemDisposition !== undefined && !isItemDisposition(err.itemDisposition)) {
    throwContractViolation(
      ITEM_DISPOSITION_CONTRACT_VIOLATION,
      `itemDisposition must be one of ${ITEM_DISPOSITIONS.join('|')}, got: ${String(err.itemDisposition)} (code=${err.code})`,
    );
  }
  if (
    !err.retryable &&
    scope === 'item' &&
    err.itemDisposition === undefined
  ) {
    throwContractViolation(
      ADAPTER_ERROR_DISPOSITION_MISSING,
      `${ADAPTER_ERROR_DISPOSITION_MISSING}: item-level non-retryable error missing itemDisposition (code=${err.code})`,
    );
  }
}

/**
 * 契约违规统一抛结构化内部错误（§11.5 要求"报告此码"，下游按 `err.code`
 * 分流而非对消息做字符串匹配）。scope='job'：违规报告本身是 Job 级错误，
 * 不携带 itemDisposition。
 */
function throwContractViolation(code: string, userMessage: string): never {
  throw toInkMigrateError(
    {
      code,
      category: 'internal',
      retryable: false,
      userMessage,
    },
    'job',
  );
}

export type InkMigrateErrorObject = InkMigrateError & Error;

/**
 * 将纯数据形态的 `InkMigrateError` 转换为同时携带领域字段的 `Error` 实例，
 * 便于在 `throw` 链路中保留结构化信息。
 *
 * 适配器边界拿到的常是 IPC/JSON 反序列化后的裸数据，TS 类型不提供运行时
 * 保证：先校验基础字段并复核处置契约（scope='job' 的调用方可豁免条目级
 * disposition 要求，见 {@link assertItemDispositionContract} 规则 4），
 * 再抬升为可信的领域错误。
 */
export function toInkMigrateError(
  err: InkMigrateError,
  scope: 'job' | 'item' = 'item',
): InkMigrateErrorObject {
  if (
    typeof err.code !== 'string' ||
    err.code === '' ||
    !isErrorCategory(err.category) ||
    typeof err.retryable !== 'boolean'
  ) {
    throw new TypeError(
      `malformed InkMigrateError payload (code=${String(err.code)}, category=${String(err.category)})`,
    );
  }
  assertItemDispositionContract(err, scope);
  const e = new Error(err.userMessage) as InkMigrateErrorObject;
  e.code = err.code;
  e.category = err.category;
  e.retryable = err.retryable;
  if (err.itemDisposition !== undefined) e.itemDisposition = err.itemDisposition;
  if (err.technicalMessage !== undefined) e.technicalMessage = err.technicalMessage;
  // 仅在存在时赋值：无条件赋值会产生可枚举的 cause: undefined，
  // JSON.stringify 时可能抛循环引用错误或泄漏技术细节，且 'cause' in e 误报
  if (err.cause !== undefined) e.cause = err.cause;
  return e;
}
