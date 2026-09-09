import { parse } from 'yaml';
import { ConfigSchema, type InkMigrateConfig } from './schema.js';

/**
 * §10.3 配置加载与校验失败。
 *
 * `errors` 是一次启动中收集到的所有错误的可读字符串（§10.3 "启动前必须一次性
 * 列出全部错误"）。CLI 层捕获后非零退出。
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * §10.1 / §10.3 加载 YAML 字符串为强类型配置。
 *
 * 校验流程：
 * 1. 解析 YAML。
 * 2. Zod 校验整体结构（未知字段、类型、必填、enum 等）。
 * 3. 额外检查重复来源/目标 ID（§10.3）。
 *
 * 任一失败都聚合到 `ConfigValidationError.errors`，全部失败一次性抛出。
 */
export function loadConfigFromString(raw: string): InkMigrateConfig {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    // YAML 语法错误（缩进/制表符/未闭合引号等）同样走统一错误通道，
    // 避免 CLI 面对两种异常类型。
    throw new ConfigValidationError('config validation failed', [
      `<root>: YAML syntax error: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const result = ConfigSchema.safeParse(parsed);
  const errors: string[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
  }
  // §10.3 重复来源/目标 ID（Zod 不直接表达跨元素约束）。
  // 必须先确认 sources/targets 是数组，否则用户的 YAML 写错类型时会以原始
  // TypeError 形式抛出，绕过"一次性列出全部错误"契约。
  if (parsed && typeof parsed === 'object') {
    const p = parsed as {
      sources?: unknown;
      targets?: unknown;
    };
    if (Array.isArray(p.sources)) {
      // 元素可能是 null（如 `- ` 空列表项），用 ?. 保证 Zod 的错误仍能聚合上报
      for (const dup of findDuplicates(
        (p.sources as Array<{ id?: unknown } | null | undefined>).map((s) => s?.id),
      )) {
        errors.push(`sources: duplicate id "${dup}"`);
      }
    }
    if (Array.isArray(p.targets)) {
      for (const dup of findDuplicates(
        (p.targets as Array<{ id?: unknown } | null | undefined>).map((t) => t?.id),
      )) {
        errors.push(`targets: duplicate id "${dup}"`);
      }
    }
  }
  if (errors.length > 0) {
    throw new ConfigValidationError('config validation failed', errors);
  }
  if (!result.success) {
    // 理论上不可达（Zod 校验失败必产出 issue），保底防御：避免把 undefined
    // 静默当作配置返回给调用方。
    throw new ConfigValidationError('config validation failed', [
      '<root>: schema validation failed but no issues were reported',
    ]);
  }
  return result.data;
}

/** 收集全部重复的字符串 id（去重），供"一次性列出全部错误"使用。 */
function findDuplicates(ids: unknown[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
}
