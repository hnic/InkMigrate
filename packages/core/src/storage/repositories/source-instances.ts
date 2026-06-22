import type { DB } from '../database.js';

export interface SourceInstanceInput {
  id: string;
  adapterKind: string;
  adapterVersion: string;
  adapterApiVersion: string;
  displayName?: string;
  configHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceInstanceRow {
  id: string;
  adapterKind: string;
  adapterVersion: string;
  adapterApiVersion: string;
  displayName?: string;
  configHash: string;
  createdAt: string;
  updatedAt: string;
}

/** §16.1 source_instances 仓储。 */
export class SourceInstances {
  constructor(private db: DB) {}

  create(i: SourceInstanceInput): void {
    this.db
      .prepare(
        `INSERT INTO source_instances(id,adapter_kind,adapter_version,adapter_api_version,display_name,config_hash,created_at,updated_at)
         VALUES(@id,@adapterKind,@adapterVersion,@adapterApiVersion,@displayName,@configHash,@createdAt,@updatedAt)`,
      )
      .run({ displayName: null, ...i });
  }

  get(id: string): SourceInstanceRow | undefined {
    return this.db
      .prepare(
        `SELECT id, adapter_kind AS adapterKind, adapter_version AS adapterVersion,
                adapter_api_version AS adapterApiVersion, display_name AS displayName,
                config_hash AS configHash, created_at AS createdAt, updated_at AS updatedAt
         FROM source_instances WHERE id=?`,
      )
      .get(id) as SourceInstanceRow | undefined;
  }
}
