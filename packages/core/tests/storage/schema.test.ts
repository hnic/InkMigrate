import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeMemoryDb } from '../helpers/db.js';
import { migrate, getCurrentSchemaVersion, SCHEMA_VERSION } from '../../src/storage/database.js';
import { applySchemaV1, applySchemaV2 } from '../../src/storage/schema.js';
import { openDatabase, type DB } from '../../src/index.js';

let db: DB;
beforeEach(() => {
  db = makeMemoryDb();
});
afterEach(() => db.close());

function seedInstancesAndJob() {
  db.prepare(
    `INSERT INTO source_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
     VALUES('s1','a','1','1.0.0','h','t','t')`,
  ).run();
  db.prepare(
    `INSERT INTO target_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
     VALUES('t1','a','1','1.0.0','h','t','t')`,
  ).run();
  db.prepare(
    `INSERT INTO migration_jobs(id,source_instance_id,target_instance_id,status,current_stage,created_at,updated_at)
     VALUES('j1','s1','t1','created','preflight','t','t')`,
  ).run();
}

/** Seed source_item + cleanup_plans → cleanup_jobs → cleanup_items chain with id=1. */
function seedFullCleanupChain() {
  db.prepare(
    `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
     VALUES('s1','e1','fp','sk','ik','sid','article','t','verified','t','t')`,
  ).run();
  db.prepare(
    `INSERT INTO cleanup_plans(id,source_instance_id,migration_job_id,action,plan_hash,config_hash,candidate_count,excluded_count,status,created_at)
     VALUES('cp1','s1','j1','unfavorite','ph','ch',1,0,'executed','t')`,
  ).run();
  db.prepare(
    `INSERT INTO cleanup_jobs(id,plan_id,plan_hash,action,status,candidate_count,created_at,updated_at)
     VALUES('cj1','cp1','ph','unfavorite','completed',1,'t','t')`,
  ).run();
  db.prepare(
    `INSERT INTO cleanup_items(job_id,source_item_id,precheck_status,action_status,created_at,updated_at)
     VALUES('cj1',1,'favorited','unfavorited_verified','t','t')`,
  ).run();
}

describe('schema enforcement (§16.12, §24.5)', () => {
  describe('foreign_keys pragma', () => {
    it('foreign_keys is ON after openDatabase', () => {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });

  describe('FK RESTRICT enforcement', () => {
    it('migration_jobs.source_instance_id RESTRICT blocks source_instances delete', () => {
      seedInstancesAndJob();
      expect(() =>
        db.prepare(`DELETE FROM source_instances WHERE id='s1'`).run(),
      ).toThrow(/FOREIGN KEY/);
    });

    it('migration_jobs.target_instance_id RESTRICT blocks target_instances delete', () => {
      seedInstancesAndJob();
      expect(() =>
        db.prepare(`DELETE FROM target_instances WHERE id='t1'`).run(),
      ).toThrow(/FOREIGN KEY/);
    });

    it('cleanup_plans.source_instance_id RESTRICT blocks source_instances delete', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO cleanup_plans(id,source_instance_id,migration_job_id,action,plan_hash,config_hash,candidate_count,excluded_count,status,created_at)
         VALUES('cp1','s1','j1','unfavorite','ph','ch',1,0,'created','t')`,
      ).run();
      expect(() =>
        db.prepare(`DELETE FROM source_instances WHERE id='s1'`).run(),
      ).toThrow(/FOREIGN KEY/);
    });
  });

  describe('FK CASCADE enforcement', () => {
    it('deleting a source_item CASCADEs to assets', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','e1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO assets(source_item_id,original_url,status,created_at,updated_at)
         VALUES(1,'u','pending','t','t')`,
      ).run();
      db.prepare(`DELETE FROM source_items WHERE id=1`).run();
      const left = db
        .prepare(`SELECT COUNT(*) c FROM assets WHERE source_item_id=1`)
        .get() as { c: number };
      expect(left.c).toBe(0);
    });

    it('deleting a migration_job CASCADEs to migration_attempts', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
         VALUES('j1','job',NULL,'preflight','stage_attempt',1,'t','t')`,
      ).run();
      db.prepare(`DELETE FROM migration_jobs WHERE id='j1'`).run();
      const left = db
        .prepare(`SELECT COUNT(*) c FROM migration_attempts WHERE migration_job_id='j1'`)
        .get() as { c: number };
      expect(left.c).toBe(0);
    });

    it('deleting a cleanup_item CASCADEs to cleanup_action_attempts', () => {
      seedInstancesAndJob();
      seedFullCleanupChain();
      db.prepare(
        `INSERT INTO cleanup_action_attempts(cleanup_item_id,attempt_no,started_at,created_at)
         VALUES(1,1,'t','t')`,
      ).run();
      db.prepare(`DELETE FROM cleanup_items WHERE id=1`).run();
      const left = db
        .prepare(`SELECT COUNT(*) c FROM cleanup_action_attempts WHERE cleanup_item_id=1`)
        .get() as { c: number };
      expect(left.c).toBe(0);
    });
  });

  describe('FK RESTRICT on cleanup_items.source_item_id (§16.10)', () => {
    it('cleanup_items.source_item_id RESTRICT blocks source_items delete', () => {
      seedInstancesAndJob();
      seedFullCleanupChain();
      expect(() =>
        db.prepare(`DELETE FROM source_items WHERE id=1`).run(),
      ).toThrow(/FOREIGN KEY/);
    });
  });

  describe('FK SET NULL on migration_attempts.target_artifact_id (§16.7)', () => {
    it('deleting a target_artifact SET NULLs migration_attempts.target_artifact_id', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','e1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
         VALUES('j1',1,'note','t1','n.md','verified','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,target_artifact_id,stage,action_code,attempt_no,started_at,created_at)
         VALUES('j1','item',1,1,'writing_target','stage_attempt',1,'t','t')`,
      ).run();
      db.prepare(`DELETE FROM target_artifacts WHERE id=1`).run();
      const row = db
        .prepare(`SELECT target_artifact_id taid FROM migration_attempts WHERE id=1`)
        .get() as { taid: number | null };
      expect(row.taid).toBeNull();
    });
  });

  describe('FK SET NULL enforcement', () => {
    it('deleting a source_item SET NULLs target_artifacts.source_item_id', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','e1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
         VALUES('j1',1,'note','t1','x.md','verified','t','t')`,
      ).run();
      db.prepare(`DELETE FROM source_items WHERE id=1`).run();
      const row = db
        .prepare(`SELECT source_item_id sid FROM target_artifacts WHERE id=1`)
        .get() as { sid: number | null };
      expect(row.sid).toBeNull();
    });
  });

  describe('CHECK constraints', () => {
    it('target_artifacts.status CHECK rejects unknown value', () => {
      seedInstancesAndJob();
      expect(() =>
        db.prepare(
          `INSERT INTO target_artifacts(migration_job_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
           VALUES('j1','note','t1','x.md','bogus','t','t')`,
        ).run(),
      ).toThrow(/CHECK/);
    });

    it('target_artifacts.status CHECK accepts all six spec values', () => {
      seedInstancesAndJob();
      for (const s of [
        'planned',
        'written',
        'verified',
        'conflict',
        'superseded',
        'invalid',
      ]) {
        db.prepare(
          `INSERT INTO target_artifacts(migration_job_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
           VALUES('j1','note','t1','p-${s}.md',?, 't','t')`,
        ).run(s);
      }
      const n = db
        .prepare(`SELECT COUNT(*) c FROM target_artifacts`)
        .get() as { c: number };
      expect(n.c).toBe(6);
    });

    it('migration_attempts.attempt_scope CHECK rejects unknown value', () => {
      seedInstancesAndJob();
      expect(() =>
        db.prepare(
          `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
           VALUES('j1','batch',NULL,'preflight','stage_attempt',1,'t','t')`,
        ).run(),
      ).toThrow(/CHECK/);
    });

    it('migration_attempts compound CHECK rejects item scope with NULL source_item_id', () => {
      seedInstancesAndJob();
      expect(() =>
        db.prepare(
          `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
           VALUES('j1','item',NULL,'preflight','stage_attempt',1,'t','t')`,
        ).run(),
      ).toThrow(/CHECK/);
    });

    it('migration_attempts compound CHECK rejects job scope with non-NULL source_item_id', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','e1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      expect(() =>
        db.prepare(
          `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
           VALUES('j1','job',1,'preflight','stage_attempt',1,'t','t')`,
        ).run(),
      ).toThrow(/CHECK/);
    });

    it('M2: migration_jobs.status CHECK rejects unknown value', () => {
      seedInstancesAndJob();
      expect(() =>
        db.prepare(
          `UPDATE migration_jobs SET status='bogus' WHERE id='j1'`,
        ).run(),
      ).toThrow(/CHECK/);
    });

    it('M2: migration_jobs.status CHECK accepts all six lifecycle values', () => {
      seedInstancesAndJob();
      for (const s of ['created', 'running', 'paused', 'interrupted', 'completed', 'failed']) {
        db.prepare(`UPDATE migration_jobs SET status=? WHERE id='j1'`).run(s);
      }
      const row = db
        .prepare(`SELECT status FROM migration_jobs WHERE id='j1'`)
        .get() as { status: string };
      expect(row.status).toBe('failed');
    });

    it('R5: source_items.status CHECK rejects unknown value', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','fp','sk','ik','sid','article','t','verified','t','t')`,
      ).run();
      expect(() =>
        db.prepare(`UPDATE source_items SET status='bogus' WHERE fingerprint='fp'`).run(),
      ).toThrow(/CHECK/);
    });

    it('R5: source_items.content_kind CHECK rejects unknown value', () => {
      seedInstancesAndJob();
      expect(() =>
        db.prepare(
          `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
           VALUES('s1','fp','sk','ik','sid','bogus_kind','t','verified','t','t')`,
        ).run(),
      ).toThrow(/CHECK/);
    });

    it('R5: source_items.quality CHECK accepts NULL, full, degraded; rejects others', () => {
      seedInstancesAndJob();
      // NULL 合法
      db.prepare(
        `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,quality,created_at,updated_at)
         VALUES('s1','fp1','sk1','ik1','sid1','article','t','verified',NULL,'t','t')`,
      ).run();
      // full / degraded 合法
      let n = 2;
      for (const q of ['full', 'degraded']) {
        db.prepare(
          `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,quality,created_at,updated_at)
           VALUES('s1',@fp,@sk,@ik,@sid,'article','t','verified',@q,'t','t')`,
        ).run({ fp: `fp${n}`, sk: `sk${n}`, ik: `ik${n}`, sid: `sid${n}`, q });
        n++;
      }
      // 非法值被拒
      expect(() =>
        db.prepare(
          `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,quality,created_at,updated_at)
           VALUES('s1','fp-x','sk-x','ik-x','sid-x','article','t','verified','bogus','t','t')`,
        ).run(),
      ).toThrow(/CHECK/);
    });
  });

  describe('schema version migration (M2 v1→v2)', () => {
    it('fresh db reaches SCHEMA_VERSION after migrate', () => {
      migrate(db);
      expect(getCurrentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    });

    it('R18: v1 文件库升级到 v2 不丢数据且 CHECK 生效', async () => {
      // 用文件库（表重建迁移需文件库才能真实体现 DROP/RENAME）。
      // 直接用原始 better-sqlite3 实例手动建 v1，不经 openDatabase（避免自动跑到 v2）。
      const dir = mkdtempSync(join(tmpdir(), 'inkmigrate-v1-upgrade-'));
      const rawDb = new Database(join(dir, 'v1.sqlite'));
      try {
        rawDb.pragma('foreign_keys = ON');
        // 手动建 v1 schema（模拟一个 v1 时代的库）
        applySchemaV1(rawDb);
        // applySchemaV1 插入 schema_version=1，但 openDatabase 的 migrate 会再插一次（ON CONFLICT）
        // 为模拟真实 v1 库，确认当前版本是 1
        const v1Version = rawDb
          .prepare('SELECT MAX(version) AS v FROM schema_version')
          .get() as { v: number };
        expect(v1Version.v).toBe(1);

        // 插入真实 v1 数据
        rawDb.prepare(
          `INSERT INTO source_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
           VALUES('s1','toutiao','1.0.0','1.0.0','h','t','t')`,
        ).run();
        rawDb.prepare(
          `INSERT INTO target_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
           VALUES('t1','obsidian','1.0.0','1.0.0','h','t','t')`,
        ).run();
        rawDb.prepare(
          `INSERT INTO migration_jobs(id,source_instance_id,target_instance_id,status,current_stage,scan_count,verified_count,created_at,updated_at)
           VALUES('j1','s1','t1','running','extracting',10,3,'t','t')`,
        ).run();
        rawDb.close();

        // 现在用 openDatabase 打开这个 v1 库——会自动触发 migrate 升级到 v2
        const upgraded = openDatabase({ path: join(dir, 'v1.sqlite') });
        try {
          expect(getCurrentSchemaVersion(upgraded)).toBe(SCHEMA_VERSION);

          // 数据完整：job 仍在，字段值未丢
          const job = upgraded.prepare(
            `SELECT status, current_stage, scan_count, verified_count FROM migration_jobs WHERE id='j1'`,
          ).get() as { status: string; current_stage: string; scan_count: number; verified_count: number };
          expect(job.status).toBe('running');
          expect(job.current_stage).toBe('extracting');
          expect(job.scan_count).toBe(10);
          expect(job.verified_count).toBe(3);

          // CHECK 生效：非法 status 被拒
          expect(() =>
            upgraded.prepare(`UPDATE migration_jobs SET status='bogus' WHERE id='j1'`).run(),
          ).toThrow(/CHECK/);

          // v2 新增索引存在
          const idxCount = (
            upgraded
              .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
              .get() as { c: number }
          ).c;
          expect(idxCount).toBeGreaterThanOrEqual(2);
        } finally {
          upgraded.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('R5-fix: v2 文件库 + FK 数据升级到 v3 不丢数据、无 FK 违规、CHECK 生效', () => {
      // 复现真实 bug：v3 的表重建（DROP source_items）在 foreign_keys=ON 下因子表
      // FK 引用而失败（FOREIGN KEY constraint failed），导致 migrate.resumable 等只读
      // 操作每次 openDatabase 都报 FK 错。修复：迁移期间临时关闭 FK。
      const dir = mkdtempSync(join(tmpdir(), 'inkmigrate-v2-fk-'));
      try {
        // 用真实 applySchemaV1+V2 建 v2 库（FK ON）
        const raw = new Database(join(dir, 'v2fk.sqlite'));
        raw.pragma('foreign_keys = ON');
        applySchemaV1(raw);
        applySchemaV2(raw);
        // 插入有 FK 关系的数据（target_artifacts → source_items）
        raw.prepare(
          `INSERT INTO source_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
           VALUES('s1','a','1','1','h','t','t')`,
        ).run();
        raw.prepare(
          `INSERT INTO target_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
           VALUES('t1','a','1','1','h','t','t')`,
        ).run();
        raw.prepare(
          `INSERT INTO migration_jobs(id,source_instance_id,target_instance_id,status,current_stage,created_at,updated_at)
           VALUES('j1','s1','t1','completed','completed','t','t')`,
        ).run();
        raw.prepare(
          `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
           VALUES('s1','fp','sk','ik','sid','article','t','verified','t','t')`,
        ).run();
        raw.prepare(
          `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
           VALUES('j1',1,'note','t1','x.md','verified','t','t')`,
        ).run();
        expect(getCurrentSchemaVersion(raw)).toBe(2);
        raw.close();

        // openDatabase 触发 v3 迁移（FK 临时关闭）
        const upgraded = openDatabase({ path: join(dir, 'v2fk.sqlite') });
        try {
          expect(getCurrentSchemaVersion(upgraded)).toBe(3);
          // 数据完整
          expect(
            (upgraded.prepare('SELECT COUNT(*) c FROM source_items').get() as { c: number }).c,
          ).toBe(1);
          expect(
            (upgraded.prepare('SELECT COUNT(*) c FROM target_artifacts').get() as { c: number }).c,
          ).toBe(1);
          // 无 FK 违规
          const fkIssues = upgraded.pragma('foreign_key_check') as unknown[];
          expect(fkIssues).toHaveLength(0);
          // CHECK 生效（source_items.content_kind）
          expect(() =>
            upgraded
              .prepare("UPDATE source_items SET content_kind='bogus' WHERE fingerprint='fp'")
              .run(),
          ).toThrow(/CHECK/);
        } finally {
          upgraded.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('partial unique indexes (§16.6, §16.7)', () => {
    it('uq_migration_attempts_job prevents duplicate job-scope attempt', () => {
      seedInstancesAndJob();
      const ins = db.prepare(
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
         VALUES('j1','job',NULL,'preflight','stage_attempt',1,'t','t')`,
      );
      ins.run();
      expect(() => ins.run()).toThrow(/UNIQUE/);
    });

    it('uq_migration_attempts_item prevents duplicate item-scope attempt', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','e1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      const ins = db.prepare(
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
         VALUES('j1','item',1,'extracting','stage_attempt',1,'t','t')`,
      );
      ins.run();
      expect(() => ins.run()).toThrow(/UNIQUE/);
    });

    it('item-scope attempt does NOT collide with job-scope attempt of same (job,stage,action,attempt_no)', () => {
      // This is the §16.7 NULL-distinct problem the partial indexes solve.
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','e1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
         VALUES('j1','job',NULL,'preflight','stage_attempt',1,'t','t')`,
      ).run();
      expect(() =>
        db.prepare(
          `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
           VALUES('j1','item',1,'preflight','stage_attempt',1,'t','t')`,
        ).run(),
      ).not.toThrow();
    });

    it('uq_target_artifacts_job_path prevents duplicate job-scope artifact', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
         VALUES('j1',NULL,'index','t1','idx.md','verified','t','t')`,
      ).run();
      expect(() =>
        db.prepare(
          `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
           VALUES('j1',NULL,'index','t1','idx.md','verified','t','t')`,
        ).run(),
      ).toThrow(/UNIQUE/);
    });

    it('uq_target_artifacts_source_bound prevents duplicate source-bound artifact', () => {
      seedInstancesAndJob();
      db.prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','e1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
         VALUES('j1',1,'note','t1','a.md','verified','t','t')`,
      ).run();
      // same (job,item,kind) → conflict, even with different path
      expect(() =>
        db.prepare(
          `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,status,created_at,updated_at)
           VALUES('j1',1,'note','t1','b.md','verified','t','t')`,
        ).run(),
      ).toThrow(/UNIQUE/);
    });
  });

  describe('unique constraints (non-partial)', () => {
    it('source_items fingerprint unique per instance', () => {
      seedInstancesAndJob();
      const ins = db.prepare(
        `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      );
      ins.run();
      expect(() => ins.run()).toThrow(/UNIQUE/);
    });
  });

  describe('database transactions (§16.12)', () => {
    it('rolls back on error inside a transaction', () => {
      seedInstancesAndJob();
      const before = (
        db.prepare(`SELECT COUNT(*) c FROM source_items`).get() as { c: number }
      ).c;
      expect(() => {
        const tx = db.transaction(() => {
          db.prepare(
            `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
             VALUES('s1','fp','sk','ik','sid','article','t','discovered','t','t')`,
          ).run();
          // second insert with same fingerprint → UNIQUE violation → rollback
          db.prepare(
            `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
             VALUES('s1','fp','sk2','ik2','sid2','article','t','discovered','t','t')`,
          ).run();
        });
        tx();
      }).toThrow(/UNIQUE/);
      const after = (
        db.prepare(`SELECT COUNT(*) c FROM source_items`).get() as { c: number }
      ).c;
      expect(after).toBe(before); // first insert rolled back too
    });
  });

  describe('schema migration framework (§16 multi-version)', () => {
    it('fresh database migrates to current SCHEMA_VERSION', () => {
      // makeMemoryDb 已在 openDatabase 内调用 migrate；直接校验版本号
      expect(getCurrentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    });

    it('migrate is idempotent: re-running on an up-to-date db is a no-op', () => {
      const before = getCurrentSchemaVersion(db);
      migrate(db); // 已是最新版本，不应报错也不应重复写入
      expect(getCurrentSchemaVersion(db)).toBe(before);
      // schema_version 表里每个版本只有一行
      const rows = db
        .prepare(`SELECT version FROM schema_version WHERE version = ?`)
        .all(SCHEMA_VERSION) as Array<{ version: number }>;
      expect(rows.length).toBe(1);
    });

    it('rejects downgrade: db version newer than supported throws', () => {
      // 手动插入一个高于 SCHEMA_VERSION 的假版本，模拟"用旧代码打开新库"
      db.prepare(
        `INSERT INTO schema_version(version, applied_at) VALUES (?, ?)`,
      ).run(SCHEMA_VERSION + 5, new Date().toISOString());
      expect(() => migrate(db)).toThrow(/newer than supported.*downgrade/i);
    });

    it('getCurrentSchemaVersion returns 0 for a db without schema_version rows', () => {
      const fresh = makeMemoryDb();
      // 清空 schema_version 模拟极端情况（表存在但无行）
      fresh.exec(`DELETE FROM schema_version`);
      expect(getCurrentSchemaVersion(fresh)).toBe(0);
      fresh.close();
    });
  });
});
