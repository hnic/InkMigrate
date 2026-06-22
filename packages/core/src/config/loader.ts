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
  const parsed = parse(raw);
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
      const dupSrc = findDuplicate(
        (p.sources as Array<{ id?: unknown }>).map((s) => s.id),
      );
      if (dupSrc) errors.push(`sources: duplicate id "${dupSrc}"`);
    }
    if (Array.isArray(p.targets)) {
      const dupTgt = findDuplicate(
        (p.targets as Array<{ id?: unknown }>).map((t) => t.id),
      );
      if (dupTgt) errors.push(`targets: duplicate id "${dupTgt}"`);
    }
  }
  if (errors.length > 0) {
    throw new ConfigValidationError('config validation failed', errors);
  }
  return result.data as InkMigrateConfig;
}

function findDuplicate(ids: unknown[]): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}
