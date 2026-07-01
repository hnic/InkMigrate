import { sourceContentHash } from '../security/hashes.js';
import type { DB } from '../storage/database.js';

/**
 * 稳定序列化：按 key 排序，消除对象键顺序对哈希的影响。
 * 提取自 engine/CLI 共用，避免 ensureInstance 逻辑分叉（H5）。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
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
  return sourceContentHash(JSON.stringify(stableStringify(config)));
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
  const existing = db
    .prepare(`SELECT config_hash AS configHash FROM ${table} WHERE id = ?`)
    .get(id) as { configHash: string } | undefined;
  const nowTs = new Date().toISOString();
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO ${table}(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(id, adapterKind, '1.0.0', '1.0.0', configHash, nowTs, nowTs);
  } else if (existing.configHash !== configHash) {
    db.prepare(
      `UPDATE ${table} SET config_hash = ?, updated_at = ? WHERE id = ?`,
    ).run(configHash, nowTs, id);
  }
}
