import Database from 'better-sqlite3';
import type { Database as DB, Options } from 'better-sqlite3';
import { SCHEMA_VERSION, applySchemaV1 } from './schema.js';

export interface OpenDbOptions {
  /** 文件路径，或 ':memory:'。 */
  path: string;
  /** 文件库默认启用 WAL；内存库与单元测试可传 false 关闭。 */
  wal?: boolean;
  busyTimeoutMs?: number;
  /** 测试或诊断时可注入额外 Options（如 readonly）。 */
  options?: Options;
}

/**
 * §16 打开 SQLite 并启用 WAL、Foreign Keys、Busy Timeout 与 Schema Migration。
 * 调用方负责 `db.close()`。返回的 `DB` 是 better-sqlite3 原生实例。
 */
export function openDatabase(opts: OpenDbOptions): DB {
  const db = new Database(opts.path, opts.options ?? {});
  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  if (opts.wal !== false && opts.path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * §16 应用 Schema Migration。当前仅 v1；后续版本按 SCHEMA_VERSION 递增。
 * 失败必须回滚并停止（better-sqlite3 是同步 API，事务回滚由调用方包裹）。
 */
export function migrate(db: DB): void {
  // 先确保 schema_version 表存在，便于读取当前版本。
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const current = getCurrentSchemaVersion(db);
  if (current < SCHEMA_VERSION) {
    applySchemaV1(db);
  }
}

/** 返回当前已应用的最高 Schema 版本；全新数据库为 0。 */
export function getCurrentSchemaVersion(db: DB): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

export { SCHEMA_VERSION };
export default Database;
export type { DB };
