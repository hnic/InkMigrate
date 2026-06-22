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
  const parts = [
    input.externalId ?? '',
    input.canonicalUrl ?? '',
    input.originalUrl ?? '',
    input.title ?? '',
    input.author ?? '',
    input.publishedAt ?? '',
    input.raw ?? '',
  ];
  const h = createHash('sha256').update(parts.join(SEP)).digest('hex');
  return `sha256:${h}`;
}

/** §4 Stable Key = SHA-256(sourceInstanceId + "\\0" + fingerprint) hex 64 位小写。 */
export function computeStableKey(
  sourceInstanceId: string,
  fingerprint: string,
): string {
  return createHash('sha256')
    .update(sourceInstanceId + SEP + fingerprint)
    .digest('hex');
}

/** §4 Item Key：用于附件目录、诊断目录；默认 `im-` + Stable Key 前 16 位。 */
export function deriveItemKey(stableKey: string, len = 16): string {
  return `im-${stableKey.slice(0, len)}`;
}

/** §4 Stable Short ID：用于笔记文件名后缀；默认 Stable Key 前 10 位。 */
export function deriveStableShortId(stableKey: string, len = 10): string {
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
 * 调用方负责把选定长度持久化（写入 `source_items.stable_short_id` /
 * `source_items.item_key` 等），避免后续重跑时再次延长。
 */
export function pickNonCollidingLength(
  stableKey: string,
  ladder: readonly number[],
  existingPrefixes: readonly string[],
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
  for (const len of ladder) {
    if (len >= stableKey.length) {
      // 已超过完整值，完整键天然唯一，无需继续
      return stableKey.length;
    }
    const prefix = stableKey.slice(0, len);
    if (!existingPrefixes.includes(prefix)) return len;
  }
  // 所有阶梯值都冲突：升级到完整值
  return stableKey.length;
}
