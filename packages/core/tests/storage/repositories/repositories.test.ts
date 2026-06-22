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
