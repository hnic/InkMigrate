import type { DB } from '../database.js';

export interface TargetInstanceInput {
  id: string;
  adapterKind: string;
  adapterVersion: string;
  adapterApiVersion: string;
  displayName?: string;
  configHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface TargetInstanceRow {
  id: string;
  adapterKind: string;
  adapterVersion: string;
  adapterApiVersion: string;
  /** display_name 可空：better-sqlite3 将 SQL NULL 映射为 JS null（非 undefined）。 */
  displayName: string | null;
  configHash: string;
  createdAt: string;
  updatedAt: string;
}

/** §16.2 target_instances 仓储。config_hash 等审计列的就地刷新（配置变更）
 *  走 runtime/instance-helpers 的 ensureInstance 原子 upsert，仓储只提供 create/get。 */
export class TargetInstances {
  constructor(private db: DB) {}

  /** id 为主键：重复 id 会抛 UNIQUE 约束错误。生产注册/刷新走
   *  runtime/instance-helpers 的 ensureInstance（原子 upsert），不走本方法。 */
  create(i: TargetInstanceInput): void {
    this.db
      .prepare(
        `INSERT INTO target_instances(id,adapter_kind,adapter_version,adapter_api_version,display_name,config_hash,created_at,updated_at)
         VALUES(@id,@adapterKind,@adapterVersion,@adapterApiVersion,@displayName,@configHash,@createdAt,@updatedAt)`,
      )
      // ?? 归一：显式传入的 undefined 不能覆盖 null 默认值（better-sqlite3 拒绝 undefined 绑定值）。
      .run({ ...i, displayName: i.displayName ?? null });
  }

  get(id: string): TargetInstanceRow | undefined {
    return this.db
      .prepare(
        `SELECT id, adapter_kind AS adapterKind, adapter_version AS adapterVersion,
                adapter_api_version AS adapterApiVersion, display_name AS displayName,
                config_hash AS configHash, created_at AS createdAt, updated_at AS updatedAt
         FROM target_instances WHERE id=?`,
      )
      .get(id) as TargetInstanceRow | undefined;
  }
}
