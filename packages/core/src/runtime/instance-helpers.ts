import { sourceContentHash } from '../security/hashes.js';
import type { DB } from '../storage/database.js';

/**
 * 稳定序列化：按 key 排序，消除对象键顺序对哈希的影响。
 * 提取自 engine/CLI 共用，避免 ensureInstance 逻辑分叉（H5）。
 */
export function stableStringify(value: unknown): string {
  // JSON.stringify 对 undefined/function/symbol 返回 undefined（违反 string 返回
  // 契约），归一化为 'null'，避免 {a: undefined} 与 {a: () => {}} 哈希相同。
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  // 带 toJSON 的对象（Date 等）委托其标准序列化语义；否则走下方 keys 枚举会把它
  // 退化成 {}，仅 Date 不同的两个配置会产生相同哈希。
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return stableStringify((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
  return `{${entries.join(',')}}`;
}

/**
 * 计算适配器配置的稳定哈希，用于 source/target_instances.config_hash 审计列。
 * 配置变更（vaultPath、importSubdir 等）会改变哈希，使系统能识别「配置已变」
 * 而非误用旧 Job 的路径假设。
 */
export function computeConfigHash(config: Record<string, unknown>): string {
  // 直接哈希稳定序列化结果：stableStringify 已产出规范形字符串，再包一层
  // JSON.stringify 只添加引号转义，且会与任何直接哈希规范形的生产者分叉。
  return sourceContentHash(stableStringify(config));
}

/**
 * 确保实例记录存在（FK 约束要求）。只插入对应角色的表。
 * config_hash 反映该实例的配置指纹；若实例已存在但配置哈希变化（用户改了
 * vaultPath/importSubdir 等关键配置），更新 config_hash 以便后续审计/续跑
 * 能识别「配置已变」，而非误用旧 Job 的路径假设。
 *
 * H5: 提取自 CLI（原硬编码 config_hash='h'）与 Engine（计算真实哈希）的统一实现，
 * 消除二者分叉——CLI 创建的 instance 记录 'h'，随后 GUI 迁移看到哈希「变化」触发
 * 虚假 UPDATE 的审计损坏问题。
 */
export function ensureInstance(
  db: DB,
  id: string,
  adapterKind: string,
  role: 'source' | 'target',
  config: Record<string, unknown>,
): void {
  const table = role === 'source' ? 'source_instances' : 'target_instances';
  const configHash = computeConfigHash(config);
  const nowTs = new Date().toISOString();
  // 原子 upsert：CLI 与 Engine/GUI 是不同进程，可能并发写同一 SQLite 文件；先
  // SELECT 再 INSERT 的两步存在 TOCTOU——两进程都读到「不存在」时，后者的 INSERT
  // 撞唯一约束抛错而非落入更新路径。upsert 以单语句消除该窗口；config_hash 未变
  // 时保持 updated_at 不动（「配置未变不触碰」的审计语义）。
  db.prepare(
    `INSERT INTO ${table}(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       config_hash = excluded.config_hash,
       updated_at = CASE WHEN ${table}.config_hash = excluded.config_hash
                         THEN ${table}.updated_at
                         ELSE excluded.updated_at END`,
  ).run(id, adapterKind, '1.0.0', '1.0.0', configHash, nowTs, nowTs);
}
