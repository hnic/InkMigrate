import type { Database } from 'better-sqlite3';

/**
 * §16 当前 Schema 版本。每次 Migration 递增；本常量代表 v1.0 阶段 1 的初始 schema。
 */
export const SCHEMA_VERSION = 2;

/**
 * §16 全部表的最小字段契约 + CHECK 约束 + 部分唯一索引。
 * Migration 文件按 SCHEMA_VERSION 递增；此处为 v1。
 *
 * 注意事项：
 * - 启动连接时已开启 `PRAGMA foreign_keys = ON`，下方 FK 子句才实际生效。
 * - §16.7 `migration_attempts` 与 §16.6 `target_artifacts` 含可空 `source_item_id`，
 *   因 SQLite 对 UNIQUE 中的 NULL 采用 distinct 语义，使用部分唯一索引分别约束。
 * - `schema_version` 表在 `database.ts#migrate` 中也会 IF NOT EXISTS 创建一次，
 *   目的是在 `applySchemaV1` 之前就能读取当前版本；此处 CREATE 保持幂等。
 */
export function applySchemaV1(db: Database): void {
  db.exec(`
PRAGMA foreign_keys = ON;

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
    CHECK(status IN ('planned','written','verified','conflict','superseded','invalid')),
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

  // 单独执行带参数的 INSERT，避免在模板字符串里拼接时间戳
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
  status TEXT NOT NULL CHECK(status IN ('created','running','paused','interrupted','completed','failed')),
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

INSERT INTO migration_jobs_v2 SELECT * FROM migration_jobs;
DROP TABLE migration_jobs;
ALTER TABLE migration_jobs_v2 RENAME TO migration_jobs;
`);

  // 重建后索引丢失，重新创建（IF NOT EXISTS 幂等）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_migration_jobs_source ON migration_jobs(source_instance_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_migration_jobs_target ON migration_jobs(target_instance_id);`);

  db.prepare(
    `INSERT INTO schema_version(version, applied_at)
     VALUES (?, ?)
     ON CONFLICT(version) DO NOTHING`,
  ).run(2, new Date().toISOString());
}
