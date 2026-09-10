import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Database as DB, Options } from 'better-sqlite3';
import {
  SCHEMA_VERSION,
  applySchemaV1,
  applySchemaV2,
  applySchemaV3,
  REQUIRED_TABLES,
} from './schema.js';

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
 *
 * 打包模式：如果环境变量 BETTER_SQLITE3_BINDING 指向 .node 文件绝对路径，
 * 通过 nativeBinding 选项显式加载，绕过 require('bindings') 的 __dirname 遍历
 *（bundle 后 __dirname 不可靠）。
 */
export function openDatabase(opts: OpenDbOptions): DB {
  const bindingEnv = process.env.BETTER_SQLITE3_BINDING;
  const options = { ...opts.options };
  if (bindingEnv && options.nativeBinding === undefined) {
    // 提前校验而非让 new Database 抛出难溯源的 native 模块加载失败（相对路径/
    // 笔误路径都可能加载到错误的 .node 文件或直接报错，看不出是环境变量的问题）。
    if (!isAbsolute(bindingEnv) || !existsSync(bindingEnv)) {
      throw new Error(
        `BETTER_SQLITE3_BINDING must be an absolute path to an existing .node file, got: ${bindingEnv}`,
      );
    }
    options.nativeBinding = bindingEnv;
  }
  const db = new Database(opts.path, options);
  // 迁移期间临时关闭 FK 检查：v3 的表重建（DROP+RENAME）在 foreign_keys=ON 下
  // 会因子表引用而失败（FOREIGN KEY constraint failed）。SQLite 的标准做法是
  // 表重建迁移在 FK 关闭时执行（见 SQLite docs "Making Other Kinds Of Table Schema Changes"）。
  // 迁移完成后重新开启 FK（migrate 内每个迁移各自在事务中保证原子性）。
  // 仅当 schema_version 表已存在且有未应用的迁移时才需要关 FK（全新库无需）。
  try {
    // 数值校验：该值直接内插进 pragma 语句，非有限数字（JS 调用方/反序列化配置
    // 可绕过 TS 类型）会产生费解的 SQLite 语法错误或注入任意 pragma 文本。
    const busyMs = opts.busyTimeoutMs ?? 5000;
    if (!Number.isFinite(busyMs) || busyMs < 0) {
      throw new Error(
        `openDatabase: busyTimeoutMs must be a non-negative finite number, got ${JSON.stringify(opts.busyTimeoutMs)}`,
      );
    }
    db.pragma(`busy_timeout = ${busyMs}`);
    // WAL 需要写 DB 头：readonly 连接（非 WAL 库）会抛 SQLITE_READONLY，跳过。
    if (opts.wal !== false && opts.path !== ':memory:' && !options.readonly) {
      db.pragma('journal_mode = WAL');
    }
    if (tableExists(db, 'schema_version') && getCurrentSchemaVersion(db) < SCHEMA_VERSION) {
      db.pragma('foreign_keys = OFF');
      try {
        migrate(db);
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
      // 全新库或已是最新版本：SQLite 连接级 FK 默认 OFF，迁移（含 v2/v3 在空表上的
      // 重建 DDL）在 FK OFF 下安全执行，迁移完成后统一开启 FK。
      migrate(db);
      db.pragma('foreign_keys = ON');
    }
    // M-1/R3-M4: 迁移后完整性检查——确认全部业务表存在。防止损坏库（schema_version
    // 存在但表缺失）静默"成功"（CREATE IF NOT EXISTS 不重建已缺失的表）。
    for (const t of REQUIRED_TABLES) {
      if (!tableExists(db, t)) {
        throw new Error(`数据库完整性检查失败：关键表 ${t} 不存在（数据库可能已损坏）`);
      }
    }
    // 引用完整性兜底：已是最新版本的库不执行任何迁移体（v2/v3 的 foreign_key_check
    // 只在重建时跑），漂移/损坏库中的孤儿行在此暴露，而非带着 FK 违规静默运行。
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `数据库完整性检查失败：foreign_key_check 发现 ${fkViolations.length} 处引用完整性违规（数据库可能已损坏）`,
      );
    }
  } catch (e) {
    // M-1: 上面的 pragma / migrate / 完整性检查任一失败时关闭 DB，避免泄漏连接
    db.close();
    throw e;
  }
  return db;
}

function tableExists(db: DB, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { c: number };
  return row.c > 0;
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
 * 每个迁移事务用 BEGIN IMMEDIATE（先取写锁再读版本）：CLI 与 Engine/GUI 是不同
 * 进程、可能并发打开同一 SQLite 文件（见 instance-helpers 的并发说明）。若版本
 * 读取在事务外，两进程会算出相同的 current 并各自应用同一迁移——幂等 CREATE 被
 * ON CONFLICT 掩盖、非幂等步骤（如表重建）被静默双应用；WAL 下后写者还可能以
 * SQLITE_BUSY_SNAPSHOT 失败（busy_timeout 不解决该错误）。IMMEDIATE 把版本读取
 * 串行化在写锁之后，后取锁的一方会读到前者已提交的版本并跳过。
 *
 * 前置条件：包含表重建（DROP+RENAME）的迁移要求连接 foreign_keys = OFF，
 * 否则重建会因子表引用失败。openDatabase 已处理；直接调用方需自行保证
 *（注意 PRAGMA foreign_keys 在事务内是 no-op，必须在事务外切换）。
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

  // 降级预检（快速失败）；权威的版本判定在每个迁移事务内（见函数注释）。
  const currentVersion = getCurrentSchemaVersion(db);
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `migrate: database schema version ${currentVersion} is newer than supported ${SCHEMA_VERSION} (downgrade not supported)`,
    );
  }

  // 逐版本应用；是否需要应用在事务内以最新提交的版本判定（并发安全的断点续跑）
  for (const m of MIGRATIONS) {
    const txn = db.transaction(() => {
      if (m.version <= getCurrentSchemaVersion(db)) return;
      m.apply(db);
      db.prepare(
        `INSERT INTO schema_version(version, applied_at) VALUES (?, ?)
         ON CONFLICT(version) DO NOTHING`,
      ).run(m.version, new Date().toISOString());
    });
    txn.immediate();
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
