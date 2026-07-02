import Database from 'better-sqlite3';
import type { Database as DB, Options } from 'better-sqlite3';
import { SCHEMA_VERSION, applySchemaV1, applySchemaV2, applySchemaV3 } from './schema.js';

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
  // 迁移期间临时关闭 FK 检查：v3 的表重建（DROP+RENAME）在 foreign_keys=ON 下
  // 会因子表引用而失败（FOREIGN KEY constraint failed）。SQLite 的标准做法是
  // 表重建迁移在 FK 关闭时执行（见 SQLite docs "Making Other Kinds Of Table Schema Changes"）。
  // 迁移完成后重新开启 FK（migrate 内每个迁移各自在事务中保证原子性）。
  // 仅当 schema_version 表已存在且有未应用的迁移时才需要关 FK（全新库无需）。
  const hasSchemaTable = db
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { c: number };
  try {
    if (hasSchemaTable.c > 0 && getCurrentSchemaVersion(db) < SCHEMA_VERSION) {
      db.pragma('foreign_keys = OFF');
      try {
        migrate(db);
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
      // 全新库或已是最新版本：FK 保持开启，migrate 安全（CREATE IF NOT EXISTS 不重建表）
      migrate(db);
      db.pragma('foreign_keys = ON');
    }
    // M-1/R3-M4: 迁移后完整性检查——确认全部业务表存在。防止损坏库（schema_version
    // 存在但表缺失）静默"成功"（CREATE IF NOT EXISTS 不重建已缺失的表）。
    const REQUIRED_TABLES = [
      'source_instances', 'target_instances', 'migration_jobs', 'source_items',
      'assets', 'target_artifacts', 'migration_attempts',
      'cleanup_plans', 'cleanup_jobs', 'cleanup_items', 'cleanup_action_attempts',
    ];
    for (const t of REQUIRED_TABLES) {
      const exists = db
        .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?")
        .get(t) as { c: number };
      if (exists.c === 0) {
        throw new Error(`数据库完整性检查失败：关键表 ${t} 不存在（数据库可能已损坏）`);
      }
    }
  } catch (e) {
    // M-1: migrate 或完整性检查失败时关闭 DB，避免泄漏处于不确定状态的连接
    db.close();
    throw e;
  }
  return db;
}

/**
 * §16 版本化迁移注册表。
 *
 * 每个版本 N 对应一个把 schema 从 N-1 升级到 N 的迁移函数。新增版本时只需在此
 * 追加一项，migrate() 会从当前版本逐版本应用到目标版本——不再需要每次手动改
 * migrate() 的分支逻辑（旧实现只支持 v1→v1，SCHEMA_VERSION 升到 2 时会静默失败）。
 *
 * 迁移函数必须幂等（CREATE 语句用 IF NOT EXISTS）且包裹在事务中执行。
 * key=1 对应 applySchemaV1（创建全部 v1 表，兼容全新库与已存在库）。
 */
const MIGRATIONS: ReadonlyArray<{ version: number; apply: (db: DB) => void }> = [
  { version: 1, apply: applySchemaV1 },
  { version: 2, apply: applySchemaV2 },
  { version: 3, apply: applySchemaV3 },
  // 版本 4 起在此追加：{ version: 4, apply: applySchemaV4 }, ...
];

/**
 * §16 应用 Schema Migration。从当前版本逐版本应用到 SCHEMA_VERSION。
 *
 * 逐版本而非单步：确保从任意旧版本（含跳版本场景）都能正确升级到目标版本。
 * 每个迁移在独立事务中执行；失败时事务回滚，schema_version 不递增，下次启动
 * 从断点续跑。better-sqlite3 是同步 API，事务回滚由 db.transaction 保证。
 *
 * 校验：注册表必须连续覆盖 1..SCHEMA_VERSION，缺失或乱序会抛错（fail-fast，
 * 避免生产库因迁移表配置错误而部分升级到不一致状态）。
 */
export function migrate(db: DB): void {
  // 先确保 schema_version 表存在，便于读取当前版本。
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  // 校验注册表完整性：连续覆盖 1..SCHEMA_VERSION
  for (let v = 1; v <= SCHEMA_VERSION; v++) {
    if (!MIGRATIONS.some((m) => m.version === v)) {
      throw new Error(
        `migrate: missing migration for version ${v} (MIGRATIONS must cover 1..${SCHEMA_VERSION})`,
      );
    }
  }

  const current = getCurrentSchemaVersion(db);
  // 当前版本高于目标（降级场景）→ 拒绝，避免静默使用新库于旧代码。
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `migrate: database schema version ${current} is newer than supported ${SCHEMA_VERSION} (downgrade not supported)`,
    );
  }

  // 逐版本应用从 current+1 到 SCHEMA_VERSION 的迁移
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const txn = db.transaction(() => {
      m.apply(db);
      db.prepare(
        `INSERT INTO schema_version(version, applied_at) VALUES (?, ?)
         ON CONFLICT(version) DO NOTHING`,
      ).run(m.version, new Date().toISOString());
    });
    txn();
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
