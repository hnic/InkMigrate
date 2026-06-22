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
  displayName?: string;
  configHash: string;
  createdAt: string;
  updatedAt: string;
}

/** §16.2 target_instances 仓储。 */
export class TargetInstances {
  constructor(private db: DB) {}

  create(i: TargetInstanceInput): void {
    this.db
      .prepare(
        `INSERT INTO target_instances(id,adapter_kind,adapter_version,adapter_api_version,display_name,config_hash,created_at,updated_at)
         VALUES(@id,@adapterKind,@adapterVersion,@adapterApiVersion,@displayName,@configHash,@createdAt,@updatedAt)`,
      )
      .run({ displayName: null, ...i });
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
