import { createHash } from 'node:crypto';

/**
 * §4 / §13.4 的字段分隔符。使用 NUL 是为了让来源实例 ID 和指纹拼接时不会出现
 * 歧义（例如 `'ab' + 'c'` 与 `'a' + 'bc'`）。
 */
const SEP = '\0';

export interface FingerprintInput {
  externalId?: string;
  canonicalUrl?: string;
  originalUrl?: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  /** 适配器在缺少结构化身份字段时的原始指纹输入 */
  raw?: string;
}

/**
 * §12.6 / §15.4：来源适配器决定 fingerprint 输入字段的优先级（外部 ID、URL、
 * 标题+作者+发布时间哈希等）；本函数只对适配器给出的输入做稳定哈希。
 *
 * 输出格式固定为 `sha256:<64 位小写十六进制>`。`undefined` 字段一律视为空串，
 * 因此同一逻辑输入的部分分片与完整对象产生相同指纹。
 */
export function computeFingerprint(input: FingerprintInput): string {
  // 规范化：各字段 trim，避免首尾空白让同一条目产出不同指纹；
  // 纯空白的字段与缺省一样落入下方"全空"防御。
  const parts = [
    input.externalId?.trim() ?? '',
    input.canonicalUrl?.trim() ?? '',
    input.originalUrl?.trim() ?? '',
    input.title?.trim() ?? '',
    input.author?.trim() ?? '',
    input.publishedAt?.trim() ?? '',
    input.raw?.trim() ?? '',
  ];
  // 防御：所有身份字段皆空时产出固定指纹，多个此类条目会指纹碰撞被当作同一条
  // 去重。core 作为通用库应在调用方漏传身份字段时显式报错，而非静默产出常量。
  if (parts.every((p) => p === '')) {
    throw new Error(
      'computeFingerprint: all identity fields are empty (supply at least one of externalId/canonicalUrl/originalUrl/title/author/publishedAt/raw)',
    );
  }
  // 防御：字段内含 NUL 会破坏 SEP 分隔的唯一性（字段边界歧义 → 不同条目指纹碰撞）
  if (parts.some((p) => p.includes(SEP))) {
    throw new Error(
      'computeFingerprint: identity fields must not contain NUL (\\0) characters',
    );
  }
  const h = createHash('sha256').update(parts.join(SEP)).digest('hex');
  return `sha256:${h}`;
}

/** §4 Stable Key = SHA-256(sourceInstanceId + "\\0" + fingerprint) hex 64 位小写。 */
export function computeStableKey(
  sourceInstanceId: string,
  fingerprint: string,
): string {
  // 防御：空实例 ID 会把所有来源折叠进同一身份空间；NUL 会移动字段边界造成
  // 跨条目碰撞（对应 computeFingerprint 的 NUL 防御）。
  if (sourceInstanceId === '' || sourceInstanceId.includes(SEP)) {
    throw new Error(
      'computeStableKey: sourceInstanceId must be non-empty and must not contain NUL (\\0)',
    );
  }
  if (fingerprint === '' || fingerprint.includes(SEP)) {
    throw new Error(
      'computeStableKey: fingerprint must be non-empty and must not contain NUL (\\0)',
    );
  }
  return createHash('sha256')
    .update(sourceInstanceId + SEP + fingerprint)
    .digest('hex');
}

const STABLE_KEY_RE = /^[0-9a-f]{64}$/;

function assertStableKey(stableKey: string, caller: string): void {
  if (!STABLE_KEY_RE.test(stableKey)) {
    throw new Error(
      `${caller}: stableKey must be 64-char lowercase hex (from computeStableKey)`,
    );
  }
}

/** §4 Item Key：用于附件目录、诊断目录；默认 `im-` + Stable Key 前 16 位。 */
export function deriveItemKey(stableKey: string, len = 16): string {
  assertStableKey(stableKey, 'deriveItemKey');
  if (!Number.isInteger(len) || len <= 0 || len > stableKey.length) {
    throw new Error(`deriveItemKey: invalid prefix length ${len}`);
  }
  return `im-${stableKey.slice(0, len)}`;
}

/** §4 Stable Short ID：用于笔记文件名后缀；默认 Stable Key 前 10 位。 */
export function deriveStableShortId(stableKey: string, len = 10): string {
  assertStableKey(stableKey, 'deriveStableShortId');
  if (!Number.isInteger(len) || len <= 0 || len > stableKey.length) {
    throw new Error(`deriveStableShortId: invalid prefix length ${len}`);
  }
  return stableKey.slice(0, len);
}

/** §4 `inkmigrate_id` = `im:<sourceInstanceId>:<stableKey>`，Vault 内唯一。 */
export function buildInkmigrateId(
  sourceInstanceId: string,
  stableKey: string,
): string {
  return `im:${sourceInstanceId}:${stableKey}`;
}

/**
 * §13.4 / §4 受控的延长阶梯。
 *
 * - `STABLE_SHORT_ID_LADDER`：Stable Short ID 用，`10 → 16 → 完整`。
 * - `ITEM_KEY_LADDER`：Item Key 用，`16 → 24 → 完整`。
 *
 * 阶梯之外的中间长度（例如 11、17）不被规格接受，因此 `pickNonCollidingLength`
 * 只在阶梯值之间跳跃，不做单位步进。
 */
export const STABLE_SHORT_ID_LADDER = [10, 16] as const;
export const ITEM_KEY_LADDER = [16, 24] as const;

/**
 * §13.4 在 `ladder` 给出的离散延长阶梯上挑选第一个不与 `existingPrefixes`
 * 冲突的 Stable Key 前缀长度。
 *
 * - `ladder` 必须是升序整数数组；返回值必为其中之一，或 `stableKey.length`（完整值）。
 * - 所有阶梯值都冲突时，升级到完整值并返回 `stableKey.length`。
 * - 不使用临时递增序号；只延长稳定键前缀本身。
 *
 * `existingPrefixes` 的契约：
 * - 元素必须是已持久化的、按所选长度截断的短 ID / item key（传入完整 stable
 *   key 或任意其他长度的截断无法检出真前缀冲突）；
 * - 同一批次内，调用方每选定一个前缀必须先追加进集合再评估下一条；
 * - 接受 `ReadonlySet`（O(1) 查询，大批量推荐）或数组（内部转 Set，避免 O(n·m) 扫描）。
 *
 * 调用方负责把选定长度持久化（写入 `source_items.stable_short_id` /
 * `source_items.item_key` 等），避免后续重跑时再次延长。
 */
export function pickNonCollidingLength(
  stableKey: string,
  ladder: readonly number[],
  existingPrefixes: ReadonlySet<string> | readonly string[],
): number {
  if (ladder.length === 0) {
    throw new Error('pickNonCollidingLength: ladder must not be empty');
  }
  // 校验升序
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i]! <= ladder[i - 1]!) {
      throw new Error(
        `pickNonCollidingLength: ladder must be strictly ascending, got [${ladder.join(', ')}]`,
      );
    }
  }
  const existing =
    existingPrefixes instanceof Set
      ? (existingPrefixes as Set<string>)
      : new Set(existingPrefixes);
  for (const len of ladder) {
    if (len >= stableKey.length) {
      // 已超过完整值，完整键天然唯一，无需继续
      return stableKey.length;
    }
    const prefix = stableKey.slice(0, len);
    if (!existing.has(prefix)) return len;
  }
  // 所有阶梯值都冲突：升级到完整值
  return stableKey.length;
}
