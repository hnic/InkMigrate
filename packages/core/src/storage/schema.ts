import type { Database } from 'better-sqlite3';
import { SOURCE_CONTENT_KINDS } from '../domain/models.js';
import {
  ARTIFACT_STATUSES,
  CLEANUP_JOB_STATUS,
  ITEM_FINAL_STATES,
  ITEM_PROCESSING_STATES,
  ITEM_RECOVERABLE_STATES,
  JOB_STATUS,
} from '../domain/states.js';

/**
 * §16 当前 Schema 版本（= 最新已应用的 Migration 版本，须与 database.ts 的
 * MIGRATIONS 注册表最大 version 一致）。每次新增 applySchemaVN 时递增。
 */
export const SCHEMA_VERSION = 3;

/**
 * openDatabase 迁移后完整性检查用的关键表清单。维护在 DDL 旁作为单一真相源：
 * 新增迁移建新表时必须同步更新，否则完整性检查会静默漏检新表。
 */
export const REQUIRED_TABLES = [
  'source_instances', 'target_instances', 'migration_jobs', 'source_items',
  'assets', 'target_artifacts', 'migration_attempts',
  'cleanup_plans', 'cleanup_jobs', 'cleanup_items', 'cleanup_action_attempts',
] as const;

/**
 * §16 全部表的最小字段契约 + CHECK 约束 + 部分唯一索引。
 * Migration 文件按 SCHEMA_VERSION 递增；此处为 v1。
 *
 * 注意事项：
 * - FK 生命周期由 openDatabase 管理（迁移期间 OFF，迁移后统一 ON）。
 *   本函数经 migrate() 包在事务中执行，PRAGMA foreign_keys 在事务内是 no-op，
 *   不应在此设置——且表重建迁移（v2/v3）本就要求 FK OFF 才能安全执行。
 * - §16.7 `migration_attempts` 与 §16.6 `target_artifacts` 含可空 `source_item_id`，
 *   因 SQLite 对 UNIQUE 中的 NULL 采用 distinct 语义，使用部分唯一索引分别约束。
 * - `schema_version` 表在 `database.ts#migrate` 中也会 IF NOT EXISTS 创建一次，
 *   目的是在 `applySchemaV1` 之前就能读取当前版本；此处 CREATE 保持幂等。
 */
export function applySchemaV1(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- §16.1
CREATE TABLE IF NOT EXISTS source_instances (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  adapter_api_version TEXT NOT NULL,
  display_name TEXT,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- §16.2
CREATE TABLE IF NOT EXISTS target_instances (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  adapter_api_version TEXT NOT NULL,
  display_name TEXT,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- §16.3
CREATE TABLE IF NOT EXISTS migration_jobs (
  id TEXT PRIMARY KEY,
  source_instance_id TEXT NOT NULL
    REFERENCES source_instances(id) ON DELETE RESTRICT,
  target_instance_id TEXT NOT NULL
    REFERENCES target_instances(id) ON DELETE RESTRICT,
  plan_id TEXT,
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL DEFAULT 'preflight',
  pause_reason_code TEXT,
  paused_at TEXT,
  scan_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  degraded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- §16.4
CREATE TABLE IF NOT EXISTS source_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_instance_id TEXT NOT NULL
    REFERENCES source_instances(id) ON DELETE CASCADE,
  external_id TEXT,
  fingerprint TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  stable_short_id TEXT NOT NULL,
  canonical_url TEXT,
  original_url TEXT,
  title TEXT,
  content_kind TEXT NOT NULL,
  source_position INTEGER,
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL,
  quality TEXT,
  degradations_json TEXT NOT NULL DEFAULT '[]',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  source_content_hash TEXT,
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_fp
  ON source_items(source_instance_id, fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_sk
  ON source_items(source_instance_id, stable_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_ik
  ON source_items(source_instance_id, item_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_sid
  ON source_items(source_instance_id, stable_short_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_ext
  ON source_items(source_instance_id, external_id)
  WHERE external_id IS NOT NULL;

-- §16.5
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER NOT NULL
    REFERENCES source_items(id) ON DELETE CASCADE,
  external_id TEXT,
  original_url TEXT,
  source_hash TEXT,
  local_staging_path TEXT,
  target_path TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- §16.6
CREATE TABLE IF NOT EXISTS target_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_job_id TEXT NOT NULL
    REFERENCES migration_jobs(id) ON DELETE CASCADE,
  source_item_id INTEGER
    REFERENCES source_items(id) ON DELETE SET NULL,
  artifact_kind TEXT NOT NULL,
  target_instance_id TEXT NOT NULL
    REFERENCES target_instances(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL,
  target_content_hash TEXT,
  written_file_hash TEXT,
  status TEXT NOT NULL
    CHECK(status IN (${sqlList(ARTIFACT_STATUSES)})),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_instance_id, relative_path)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_target_artifacts_source_bound
  ON target_artifacts(migration_job_id, source_item_id, artifact_kind)
  WHERE source_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_target_artifacts_job_path
  ON target_artifacts(migration_job_id, artifact_kind, relative_path)
  WHERE source_item_id IS NULL;

-- §16.7
CREATE TABLE IF NOT EXISTS migration_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_job_id TEXT NOT NULL
    REFERENCES migration_jobs(id) ON DELETE CASCADE,
  attempt_scope TEXT NOT NULL
    CHECK(attempt_scope IN ('job', 'item')),
  source_item_id INTEGER
    REFERENCES source_items(id) ON DELETE CASCADE,
  target_artifact_id INTEGER
    REFERENCES target_artifacts(id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  action_code TEXT NOT NULL DEFAULT 'stage_attempt',
  attempt_no INTEGER NOT NULL,
  candidate_quality TEXT,
  candidate_degradations_json TEXT,
  candidate_source_content_hash TEXT,
  overwrite_policy TEXT,
  expected_written_file_hash TEXT,
  observed_prewrite_file_hash TEXT,
  result_written_file_hash TEXT,
  audit_metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  success INTEGER,
  error_code TEXT,
  error_message TEXT,
  http_status INTEGER,
  diagnostic_path TEXT,
  created_at TEXT NOT NULL,
  CHECK(
    (attempt_scope = 'job' AND source_item_id IS NULL)
    OR
    (attempt_scope = 'item' AND source_item_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_attempts_item
  ON migration_attempts(migration_job_id, source_item_id, stage, action_code, attempt_no)
  WHERE attempt_scope = 'item' AND source_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_attempts_job
  ON migration_attempts(migration_job_id, stage, action_code, attempt_no)
  WHERE attempt_scope = 'job' AND source_item_id IS NULL;

-- §16.8
CREATE TABLE IF NOT EXISTS cleanup_plans (
  id TEXT PRIMARY KEY,
  source_instance_id TEXT NOT NULL
    REFERENCES source_instances(id) ON DELETE RESTRICT,
  migration_job_id TEXT NOT NULL
    REFERENCES migration_jobs(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  excluded_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- §16.9
CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL
    REFERENCES cleanup_plans(id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- §16.10
CREATE TABLE IF NOT EXISTS cleanup_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL
    REFERENCES cleanup_jobs(id) ON DELETE CASCADE,
  source_item_id INTEGER NOT NULL
    REFERENCES source_items(id) ON DELETE RESTRICT,
  precheck_status TEXT NOT NULL,
  pre_action_state TEXT,
  action_status TEXT NOT NULL,
  post_action_state TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  action_started_at TEXT,
  action_finished_at TEXT,
  verified_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  diagnostic_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, source_item_id)
);

-- §16.11
CREATE TABLE IF NOT EXISTS cleanup_action_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cleanup_item_id INTEGER NOT NULL
    REFERENCES cleanup_items(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  pre_action_state TEXT,
  action_result TEXT,
  post_action_state TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  diagnostic_path TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(cleanup_item_id, attempt_no)
);
`);

  // 单独执行带参数的 INSERT，避免在模板字符串里拼接时间戳。
  // 版本登记与 database.ts#migrate 重复（migrate 在调用 m.apply 后会再插一次）：
  // applySchemaVN 必须自包含——测试与手工修复场景会脱离 migrate 直接调用本函数，
  // 此时版本登记只能由函数自身完成；ON CONFLICT DO NOTHING 保证双写幂等。
  db.prepare(
    `INSERT INTO schema_version(version, applied_at)
     VALUES (?, ?)
     ON CONFLICT(version) DO NOTHING`,
  ).run(1, new Date().toISOString());
}

/**
 * §16 Schema v2 迁移（M2）：为关键状态列补 CHECK 约束，匹配 target_artifacts.status
 * 已有的严谨度。SQLite 不支持 ALTER TABLE ADD CONSTRAINT，故用标准「重建表」模式：
 * 建新表（带 CHECK）→ 复制数据 → DROP 旧表 → RENAME。
 *
 * 仅对 migration_jobs.status 加 CHECK（最关键的状态机列）。现有数据均为合法值
 * （运行时守卫已强制），重建安全。索引/触发器在 IF NOT EXISTS 下保持幂等。
 */
export function applySchemaV2(db: Database): void {
  // migration_jobs: 重建以加 status CHECK
  db.exec(`
CREATE TABLE IF NOT EXISTS migration_jobs_v2 (
  id TEXT PRIMARY KEY,
  source_instance_id TEXT NOT NULL
    REFERENCES source_instances(id) ON DELETE RESTRICT,
  target_instance_id TEXT NOT NULL
    REFERENCES target_instances(id) ON DELETE RESTRICT,
  plan_id TEXT,
  status TEXT NOT NULL CHECK(status IN (${sqlList(JOB_STATUS)})),
  current_stage TEXT NOT NULL DEFAULT 'preflight',
  pause_reason_code TEXT,
  paused_at TEXT,
  scan_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  degraded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 显式列出列名：SELECT * 按位置绑定，未来若调整列序/同型列对调会静默错位拷贝。
INSERT INTO migration_jobs_v2(id, source_instance_id, target_instance_id, plan_id, status, current_stage, pause_reason_code, paused_at, scan_count, candidate_count, verified_count, degraded_count, failed_count, conflict_count, skipped_count, started_at, finished_at, created_at, updated_at)
SELECT id, source_instance_id, target_instance_id, plan_id, status, current_stage, pause_reason_code, paused_at, scan_count, candidate_count, verified_count, degraded_count, failed_count, conflict_count, skipped_count, started_at, finished_at, created_at, updated_at FROM migration_jobs;
DROP TABLE migration_jobs;
ALTER TABLE migration_jobs_v2 RENAME TO migration_jobs;
`);

  // v1 未建任何索引，此处为新增（同时覆盖表重建场景——若未来 v1 存在索引，
  // DROP TABLE 会连带删除，必须在重建后重新创建；IF NOT EXISTS 幂等）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_migration_jobs_source ON migration_jobs(source_instance_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_migration_jobs_target ON migration_jobs(target_instance_id);`);

  // L6: 补 FK 子列索引——SQLite 不自动索引 FK 子列，以下查询原为全表扫：
  // - migration_attempts 按 job/item 列表（listByJob/listByItem）
  // - target_artifacts 按 source_item 查最近 verified（findBySourceItem）
  //（cleanup_items 按 job+source_item 查询无需另建索引：UNIQUE(job_id, source_item_id)
  //  的隐式唯一索引已覆盖精确查询与 job_id 前缀扫描，再建纯属双份写放大。）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_migration_attempts_job ON migration_attempts(migration_job_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_target_artifacts_source_item ON target_artifacts(source_item_id);`);

  // SQLite 官方表重建流程：FK 关闭下重建后，用 foreign_key_check 验证引用完整性，
  // 有违规则直接失败（迁移整体在事务中会回滚），避免提交引用断裂的库。
  const fkViolationsV2 = db.pragma('foreign_key_check') as unknown[];
  if (fkViolationsV2.length > 0) {
    throw new Error(`foreign_key_check failed after v2 rebuild: ${JSON.stringify(fkViolationsV2)}`);
  }

  // 版本登记说明见 applySchemaV1 尾注（与 migrate 双写、ON CONFLICT 幂等）
  db.prepare(
    `INSERT INTO schema_version(version, applied_at)
     VALUES (?, ?)
     ON CONFLICT(version) DO NOTHING`,
  ).run(2, new Date().toISOString());
}

/**
 * 合法值常量，供 CHECK 约束引用（避免魔法字符串重复）。
 * 状态类清单均从 domain/states.ts 派生（单一真相源，同 CONTENT_KINDS 的做法）：
 * 此前 schema 手抄列表漏过 'external-link'，适配器一旦产出该值即被 CHECK 拒绝；
 * 新增状态时若只改 domain 不改这里，同样会在运行期拒绝写入。
 */
const SOURCE_ITEM_STATUSES = [
  ...new Set([
    ...ITEM_PROCESSING_STATES,
    ...ITEM_FINAL_STATES,
    ...ITEM_RECOVERABLE_STATES,
  ]),
];
// 与 domain/models.ts 的 SOURCE_CONTENT_KINDS 同源，避免两份列表漂移
// （此前 schema 漏了 'external-link'，适配器一旦产出该值会被 CHECK 拒绝）。
const CONTENT_KINDS = SOURCE_CONTENT_KINDS as readonly string[];
// 与 domain/models.ts 的 SourceItemQuality 取值一致（domain 暂无值清单导出，
// 此处为 schema 内单一引用点：DDL CHECK 与 v3 预检共用）。
const SOURCE_ITEM_QUALITIES = ['full', 'degraded'] as const;
const CLEANUP_ITEM_PRECHECK_STATUSES = [
  'favorited', 'not_favorited', 'unknown',
  'login_required', 'challenge_required', 'content_unavailable',
];
const CLEANUP_ITEM_ACTION_STATUSES = [
  'unfavorited_verified', 'already_unfavorited', 'state_unknown',
  'verification_failed', 'skipped',
  // 特殊中断态（来自 detectedState / 异常路径）
  'login_required', 'challenge_required', 'permanent_failed',
];

function sqlList(values: readonly string[]): string {
  // 单引号翻倍转义：当前输入是 domain 层编译期常量（简单 slug），但按 SQL 字面量
  // 规范转义可保证未来任何输入（含引号）不产生断裂/可注入的 CHECK 语句。
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
}

/**
 * 表重建前预检：存量数据若含新表 CHECK 不接受的值，裸跑 INSERT...SELECT 只会抛
 * 无行号的 "CHECK constraint failed"（事务回滚），生产库上几乎无法定位脏行。
 * 先查出违规模块行并在抛错信息中带具体行与取值，再由人工决定修复或放弃升级。
 */
function assertRowsWithinCheck(
  db: Database,
  table: string,
  columns: ReadonlyArray<{ col: string; values: readonly string[]; nullable?: boolean }>,
): void {
  const conds = columns
    .map(({ col, values, nullable }) =>
      nullable
        ? `(${col} IS NOT NULL AND ${col} NOT IN (${sqlList(values)}))`
        : `${col} NOT IN (${sqlList(values)})`,
    )
    .join(' OR ');
  const offenders = db
    .prepare(`SELECT * FROM ${table} WHERE ${conds} LIMIT 10`)
    .all();
  if (offenders.length > 0) {
    throw new Error(
      `表重建预检失败：${table} 存在将被新 CHECK 拒绝的存量行（前 10 条）：${JSON.stringify(offenders)}`,
    );
  }
}

/**
 * §16 Schema v3 迁移（R5）：为 source_items / cleanup_jobs / cleanup_items 的状态列
 * 补 CHECK 约束，匹配 migration_jobs.status 已有的严谨度。SQLite 不支持
 * ALTER TABLE ADD CONSTRAINT，用标准「重建表」模式。
 *
 * 仅对实际有写入的状态列加约束；assets（v1 阶段无写入）和 cleanup_plans（单一
 * 状态值 created）暂不加，避免无谓的重建风险。
 */
export function applySchemaV3(db: Database): void {
  // --- source_items: 加 content_kind + status + quality CHECK ---
  // 预检存量行满足新 CHECK，失败时带行与取值（裸 CHECK 失败无法定位脏数据）
  assertRowsWithinCheck(db, 'source_items', [
    { col: 'content_kind', values: CONTENT_KINDS },
    { col: 'status', values: SOURCE_ITEM_STATUSES },
    { col: 'quality', values: SOURCE_ITEM_QUALITIES, nullable: true },
  ]);
  db.exec(`
CREATE TABLE IF NOT EXISTS source_items_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_instance_id TEXT NOT NULL
    REFERENCES source_instances(id) ON DELETE CASCADE,
  external_id TEXT,
  fingerprint TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  stable_short_id TEXT NOT NULL,
  canonical_url TEXT,
  original_url TEXT,
  title TEXT,
  content_kind TEXT NOT NULL CHECK(content_kind IN (${sqlList(CONTENT_KINDS)})),
  source_position INTEGER,
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${sqlList(SOURCE_ITEM_STATUSES)})),
  quality TEXT CHECK(quality IS NULL OR quality IN (${sqlList(SOURCE_ITEM_QUALITIES)})),
  degradations_json TEXT NOT NULL DEFAULT '[]',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  source_content_hash TEXT,
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 显式列出列名：SELECT * 按位置绑定，未来若调整列序/同型列对调会静默错位拷贝。
INSERT INTO source_items_v3(id, source_instance_id, external_id, fingerprint, stable_key, item_key, stable_short_id, canonical_url, original_url, title, content_kind, source_position, discovered_at, status, quality, degradations_json, retry_count, last_error_code, last_error_message, source_content_hash, source_metadata_json, created_at, updated_at)
SELECT id, source_instance_id, external_id, fingerprint, stable_key, item_key, stable_short_id, canonical_url, original_url, title, content_kind, source_position, discovered_at, status, quality, degradations_json, retry_count, last_error_code, last_error_message, source_content_hash, source_metadata_json, created_at, updated_at FROM source_items;
DROP TABLE source_items;
ALTER TABLE source_items_v3 RENAME TO source_items;
`);
  // 重建 source_items 的索引和唯一约束（DROP TABLE 会删除它们）
  db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_fp
  ON source_items(source_instance_id, fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_sk
  ON source_items(source_instance_id, stable_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_ik
  ON source_items(source_instance_id, item_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_sid
  ON source_items(source_instance_id, stable_short_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_items_ext
  ON source_items(source_instance_id, external_id)
  WHERE external_id IS NOT NULL;
`);
  // target_artifacts.source_item_id 和 cleanup_items.source_item_id 的 FK 指向
  // source_items(id)，DROP+RENAME 后 FK 仍有效（SQLite FK 按表名解析）。
  // 但 migration_attempts.source_item_id 和 assets.source_item_id 同理。
  // 引用完整性由函数末尾的 foreign_key_check 显式验证（迁移在 FK=OFF 下执行，
  // 该 pragma 不依赖连接的 FK 开关，可直接使用）。

  // --- cleanup_jobs: 加 status CHECK ---
  assertRowsWithinCheck(db, 'cleanup_jobs', [
    { col: 'status', values: CLEANUP_JOB_STATUS },
  ]);
  db.exec(`
CREATE TABLE IF NOT EXISTS cleanup_jobs_v3 (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL
    REFERENCES cleanup_plans(id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${sqlList(CLEANUP_JOB_STATUS)})),
  candidate_count INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 显式列出列名：SELECT * 按位置绑定，未来若调整列序/同型列对调会静默错位拷贝。
INSERT INTO cleanup_jobs_v3(id, plan_id, plan_hash, action, status, candidate_count, processed_count, success_count, skipped_count, failed_count, unknown_count, started_at, finished_at, created_at, updated_at)
SELECT id, plan_id, plan_hash, action, status, candidate_count, processed_count, success_count, skipped_count, failed_count, unknown_count, started_at, finished_at, created_at, updated_at FROM cleanup_jobs;
DROP TABLE cleanup_jobs;
ALTER TABLE cleanup_jobs_v3 RENAME TO cleanup_jobs;
`);

  // --- cleanup_items: 加 precheck_status + action_status CHECK ---
  assertRowsWithinCheck(db, 'cleanup_items', [
    { col: 'precheck_status', values: CLEANUP_ITEM_PRECHECK_STATUSES },
    { col: 'action_status', values: CLEANUP_ITEM_ACTION_STATUSES },
  ]);
  db.exec(`
CREATE TABLE IF NOT EXISTS cleanup_items_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL
    REFERENCES cleanup_jobs(id) ON DELETE CASCADE,
  source_item_id INTEGER NOT NULL
    REFERENCES source_items(id) ON DELETE RESTRICT,
  precheck_status TEXT NOT NULL CHECK(precheck_status IN (${sqlList(CLEANUP_ITEM_PRECHECK_STATUSES)})),
  pre_action_state TEXT,
  action_status TEXT NOT NULL CHECK(action_status IN (${sqlList(CLEANUP_ITEM_ACTION_STATUSES)})),
  post_action_state TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  action_started_at TEXT,
  action_finished_at TEXT,
  verified_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  diagnostic_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, source_item_id)
);
-- 显式列出列名：SELECT * 按位置绑定，未来若调整列序/同型列对调会静默错位拷贝。
INSERT INTO cleanup_items_v3(id, job_id, source_item_id, precheck_status, pre_action_state, action_status, post_action_state, attempt_count, action_started_at, action_finished_at, verified_at, last_error_code, last_error_message, diagnostic_path, created_at, updated_at)
SELECT id, job_id, source_item_id, precheck_status, pre_action_state, action_status, post_action_state, attempt_count, action_started_at, action_finished_at, verified_at, last_error_code, last_error_message, diagnostic_path, created_at, updated_at FROM cleanup_items;
DROP TABLE cleanup_items;
ALTER TABLE cleanup_items_v3 RENAME TO cleanup_items;
`);
  // 重建后 cleanup_items 无需另建 (job_id, source_item_id) 索引：新表声明的
  // UNIQUE(job_id, source_item_id) 已自带隐式唯一索引（含 job_id 前缀扫描）

  // SQLite 官方表重建流程：FK 关闭下重建后，用 foreign_key_check 验证引用完整性，
  // 有违规则直接失败（迁移整体在事务中会回滚），避免提交引用断裂的库。
  const fkViolationsV3 = db.pragma('foreign_key_check') as unknown[];
  if (fkViolationsV3.length > 0) {
    throw new Error(`foreign_key_check failed after v3 rebuild: ${JSON.stringify(fkViolationsV3)}`);
  }

  // 版本登记说明见 applySchemaV1 尾注（与 migrate 双写、ON CONFLICT 幂等）
  db.prepare(
    `INSERT INTO schema_version(version, applied_at)
     VALUES (?, ?)
     ON CONFLICT(version) DO NOTHING`,
  ).run(3, new Date().toISOString());
}
