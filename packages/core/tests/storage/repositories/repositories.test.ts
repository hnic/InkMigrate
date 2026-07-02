import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeMemoryDb } from '../../helpers/db.js';
import type { DB } from '../../../src/index.js';
import { SourceInstances } from '../../../src/storage/repositories/source-instances.js';
import { TargetInstances } from '../../../src/storage/repositories/target-instances.js';
import { MigrationJobs } from '../../../src/storage/repositories/migration-jobs.js';
import { SourceItems } from '../../../src/storage/repositories/source-items.js';
import { TargetArtifacts } from '../../../src/storage/repositories/target-artifacts.js';
import { MigrationAttempts } from '../../../src/storage/repositories/migration-attempts.js';

let db: DB;
beforeEach(() => {
  db = makeMemoryDb();
});
afterEach(() => db.close());

function seedInstancesAndJob() {
  new SourceInstances(db).create({
    id: 's1',
    adapterKind: 'toutiao',
    adapterVersion: '1.0.0',
    adapterApiVersion: '1.0.0',
    configHash: 'h',
    createdAt: 't',
    updatedAt: 't',
  });
  new TargetInstances(db).create({
    id: 't1',
    adapterKind: 'obsidian',
    adapterVersion: '1.0.0',
    adapterApiVersion: '1.0.0',
    configHash: 'h',
    createdAt: 't',
    updatedAt: 't',
  });
  new MigrationJobs(db).create({
    id: 'j1',
    sourceInstanceId: 's1',
    targetInstanceId: 't1',
    status: 'created',
    currentStage: 'preflight',
    createdAt: 't',
    updatedAt: 't',
  });
}

describe('repositories', () => {
  describe('SourceInstances', () => {
    it('creates and reads a source instance', () => {
      new SourceInstances(db).create({
        id: 's1',
        adapterKind: 'toutiao',
        adapterVersion: '1.0.0',
        adapterApiVersion: '1.0.0',
        displayName: 'main',
        configHash: 'h',
        createdAt: 't',
        updatedAt: 't',
      });
      const row = new SourceInstances(db).get('s1');
      expect(row?.adapterKind).toBe('toutiao');
      expect(row?.displayName).toBe('main');
    });
    it('returns undefined for unknown id', () => {
      expect(new SourceInstances(db).get('missing')).toBeUndefined();
    });
  });

  describe('MigrationJobs', () => {
    it('creates and reads a job with default counts', () => {
      seedInstancesAndJob();
      const j = new MigrationJobs(db).get('j1');
      expect(j.id).toBe('j1');
      expect(j.scanCount).toBe(0);
      expect(j.status).toBe('created');
      expect(j.currentStage).toBe('preflight');
    });

    it('updateCounts writes the cached count columns', () => {
      seedInstancesAndJob();
      new MigrationJobs(db).updateCounts('j1', {
        scanCount: 100,
        verifiedCount: 80,
        degradedCount: 5,
        failedCount: 8,
        conflictCount: 4,
        skippedCount: 3,
      });
      const j = new MigrationJobs(db).get('j1');
      expect(j.scanCount).toBe(100);
      expect(j.verifiedCount).toBe(80);
      expect(j.failedCount).toBe(8);
      // candidateCount unchanged
      expect(j.candidateCount).toBe(0);
    });

    it('updateStatus updates status, current_stage, pause reason, timestamps', () => {
      seedInstancesAndJob();
      // 走合法路径 created → running → paused（状态机守卫要求合法转换）
      new MigrationJobs(db).updateStatus('j1', {
        status: 'running',
        currentStage: 'extracting',
        updatedAt: 'u1b',
      });
      new MigrationJobs(db).updateStatus('j1', {
        status: 'paused',
        currentStage: 'extracting',
        pauseReasonCode: 'auth_required',
        pausedAt: '2026-06-22T14:30:00+08:00',
        updatedAt: 'u2',
      });
      const j = new MigrationJobs(db).get('j1');
      expect(j.status).toBe('paused');
      expect(j.currentStage).toBe('extracting');
      expect(j.pauseReasonCode).toBe('auth_required');
    });

    it('updateStatus clears pause fields on resume (running) and rejects illegal transitions', () => {
      seedInstancesAndJob();
      const jobs = new MigrationJobs(db);
      jobs.updateStatus('j1', { status: 'running', currentStage: 'scanning', updatedAt: 'r1' });
      jobs.updateStatus('j1', { status: 'paused', pauseReasonCode: 'rate_limited', pausedAt: 'p1', updatedAt: 'r2' });
      // paused → running 恢复：应清空 pause_reason_code / paused_at（显式 SET 而非 COALESCE）
      jobs.updateStatus('j1', { status: 'running', currentStage: 'extracting', updatedAt: 'r3' });
      const resumed = jobs.get('j1');
      expect(resumed.status).toBe('running');
      // SQL NULL 经 better-sqlite3 返回为 JS null（类型标注为 optional string，运行时为 null）
      expect(resumed.pauseReasonCode).toBeNull();
      expect(resumed.pausedAt).toBeNull();
      // 终态不可再转换
      jobs.updateStatus('j1', { status: 'completed', currentStage: 'completed', updatedAt: 'r4' });
      expect(() =>
        jobs.updateStatus('j1', { status: 'running', currentStage: 'preflight', updatedAt: 'r5' }),
      ).toThrow(/非法 Job 状态转换/);
    });
  });

  describe('SourceItems', () => {
    it('creates and finds by fingerprint', () => {
      seedInstancesAndJob();
      new SourceItems(db).create({
        sourceInstanceId: 's1',
        externalId: 'e1',
        fingerprint: 'sha256:fp',
        stableKey: 'sk',
        itemKey: 'ik',
        stableShortId: 'sid',
        contentKind: 'article',
        discoveredAt: 't',
        status: 'discovered',
        createdAt: 't',
        updatedAt: 't',
      });
      const found = new SourceItems(db).findByFingerprint('s1', 'sha256:fp');
      expect(found?.stableKey).toBe('sk');
      expect(found?.id).toBe(1);
    });
    it('findByFingerprint returns undefined for missing', () => {
      seedInstancesAndJob();
      expect(
        new SourceItems(db).findByFingerprint('s1', 'sha256:missing'),
      ).toBeUndefined();
    });
    it('updateCommittedResult writes quality, degradations, hash after target verification', () => {
      seedInstancesAndJob();
      const items = new SourceItems(db);
      items.create({
        sourceInstanceId: 's1',
        fingerprint: 'sha256:fp',
        stableKey: 'sk',
        itemKey: 'ik',
        stableShortId: 'sid',
        contentKind: 'article',
        discoveredAt: 't',
        status: 'discovered',
        createdAt: 't',
        updatedAt: 't',
      });
      items.updateCommittedResult(1, {
        status: 'degraded',
        quality: 'degraded',
        degradationsJson: JSON.stringify([
          { code: 'body-missing', stage: 'extract', message: 'partial' },
        ]),
        sourceContentHash: 'sha256:abc',
        updatedAt: 't2',
      });
      const found = items.findByFingerprint('s1', 'sha256:fp');
      expect(found?.status).toBe('degraded');
      expect(found?.quality).toBe('degraded');
      expect(found?.sourceContentHash).toBe('sha256:abc');
    });
  });

  describe('TargetArtifacts', () => {
    it('creates a verified artifact', () => {
      seedInstancesAndJob();
      new SourceItems(db).create({
        sourceInstanceId: 's1',
        fingerprint: 'sha256:fp',
        stableKey: 'sk',
        itemKey: 'ik',
        stableShortId: 'sid',
        contentKind: 'article',
        discoveredAt: 't',
        status: 'discovered',
        createdAt: 't',
        updatedAt: 't',
      });
      new TargetArtifacts(db).create({
        migrationJobId: 'j1',
        sourceItemId: 1,
        artifactKind: 'note',
        targetInstanceId: 't1',
        relativePath: 'n.md',
        status: 'verified',
        targetContentHash: 'sha256:tc',
        writtenFileHash: 'sha256:wf',
        createdAt: 't',
        updatedAt: 't',
      });
      // not thrown + row exists
      const arts = new TargetArtifacts(db).listByJob('j1');
      expect(arts.length).toBe(1);
      expect(arts[0]?.artifactKind).toBe('note');
    });
  });

  describe('MigrationAttempts', () => {
    it('creates item-scope and job-scope attempts and lists by item', () => {
      seedInstancesAndJob();
      new SourceItems(db).create({
        sourceInstanceId: 's1',
        fingerprint: 'sha256:fp',
        stableKey: 'sk',
        itemKey: 'ik',
        stableShortId: 'sid',
        contentKind: 'article',
        discoveredAt: 't',
        status: 'discovered',
        createdAt: 't',
        updatedAt: 't',
      });
      const atts = new MigrationAttempts(db);
      atts.createItem({
        migrationJobId: 'j1',
        sourceItemId: 1,
        stage: 'extracting',
        actionCode: 'stage_attempt',
        attemptNo: 1,
        startedAt: 't',
        candidateQuality: 'full',
        createdAt: 't',
      });
      atts.createJob({
        migrationJobId: 'j1',
        stage: 'preflight',
        actionCode: 'stage_attempt',
        attemptNo: 1,
        startedAt: 't',
        createdAt: 't',
      });
      expect(atts.listByItem('j1', 1)).toHaveLength(1);
      expect(atts.listByJob('j1')).toHaveLength(2);
    });

    it('R3-H1: maxAttemptNo returns highest attempt_no for item (0 if none)', () => {
      seedInstancesAndJob();
      // 内联插入 source_item（repositories.test.ts 无 seedSourceItem helper）
      db.prepare(
        `INSERT INTO source_items(source_instance_id,fingerprint,stable_key,item_key,stable_short_id,content_kind,discovered_at,status,created_at,updated_at)
         VALUES('s1','fp','sk','ik','sid','article','t','discovered','t','t')`,
      ).run();
      const itemId = (
        db.prepare('SELECT id FROM source_items WHERE fingerprint=?').get('fp') as { id: number }
      ).id;
      const atts = new MigrationAttempts(db);
      expect(atts.maxAttemptNo('j1', itemId)).toBe(0); // 无历史
      atts.createItem({
        migrationJobId: 'j1', sourceItemId: itemId, stage: 'extracting',
        actionCode: 'stage_attempt', attemptNo: 1, startedAt: 't', createdAt: 't',
      });
      atts.createItem({
        migrationJobId: 'j1', sourceItemId: itemId, stage: 'verifying_target',
        actionCode: 'stage_attempt', attemptNo: 3, startedAt: 't', createdAt: 't',
      });
      expect(atts.maxAttemptNo('j1', itemId)).toBe(3); // 返回最大值
      // R3-H1: resume 时 nextAttemptNo = maxAttemptNo + 1 = 4，避免撞唯一索引
      expect(atts.maxAttemptNo('j1', itemId) + 1).toBe(4);
    });

    it('finishAttempt sets success, finishedAt, error fields', () => {
      seedInstancesAndJob();
      new MigrationAttempts(db).createJob({
        migrationJobId: 'j1',
        stage: 'preflight',
        actionCode: 'stage_attempt',
        attemptNo: 1,
        startedAt: 't',
        createdAt: 't',
      });
      new MigrationAttempts(db).finishAttempt(1, {
        success: false,
        finishedAt: 't2',
        errorCode: 'AUTH_REQUIRED',
        errorMessage: 'login expired',
      });
      const rows = new MigrationAttempts(db).listByJob('j1');
      expect(rows[0]?.success).toBe(0);
      expect(rows[0]?.error_code).toBe('AUTH_REQUIRED');
    });
  });
});
