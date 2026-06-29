import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeMemoryDb } from '../../helpers/db.js';
import type { DB } from '../../../src/index.js';
import { SourceInstances } from '../../../src/storage/repositories/source-instances.js';
import { TargetInstances } from '../../../src/storage/repositories/target-instances.js';
import { MigrationJobs } from '../../../src/storage/repositories/migration-jobs.js';
import { SourceItems } from '../../../src/storage/repositories/source-items.js';
import { CleanupPlans } from '../../../src/storage/repositories/cleanup-plans.js';
import { CleanupJobs } from '../../../src/storage/repositories/cleanup-jobs.js';
import { CleanupItems, ACTION_STATUS_UNFAVORITED } from '../../../src/storage/repositories/cleanup-items.js';
import { CleanupAttempts } from '../../../src/storage/repositories/cleanup-attempts.js';

let db: DB;
beforeEach(() => {
  db = makeMemoryDb();
});
afterEach(() => db.close());

/** 构造满足 FK 链的最小种子：source_instance + target_instance + migration_job。 */
function seedBase() {
  new SourceInstances(db).create({
    id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
    adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
  });
  new TargetInstances(db).create({
    id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
    adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
  });
  new MigrationJobs(db).create({
    id: 'j1', sourceInstanceId: 's1', targetInstanceId: 't1',
    status: 'completed', currentStage: 'completed', createdAt: 't', updatedAt: 't',
  });
}

/** 构造一个 plan + job（依赖 seedBase），返回 { planId, jobId }。 */
function seedPlanAndJob() {
  seedBase();
  const planId = 'cp1';
  const jobId = 'cj1';
  new CleanupPlans(db).create({
    id: planId, sourceInstanceId: 's1', migrationJobId: 'j1',
    action: 'unfavorite', planHash: 'ph', configHash: 'ch',
    candidateCount: 3, excludedCount: 0, status: 'created', createdAt: 't',
  });
  new CleanupJobs(db).create({
    id: jobId, planId, planHash: 'ph', action: 'unfavorite',
    status: 'running', candidateCount: 3, createdAt: 't', updatedAt: 't',
  });
  return { planId, jobId };
}

/** 插入一条 source_item，返回其自增 id。 */
function seedSourceItem(pos: number): number {
  new SourceItems(db).create({
    sourceInstanceId: 's1',
    fingerprint: `fp${pos}`,
    stableKey: `sk${pos}`,
    itemKey: `ik${pos}`,
    stableShortId: `ssi${pos}`,
    canonicalUrl: `https://example.com/${pos}`,
    title: `item ${pos}`,
    contentKind: 'article',
    discoveredAt: '2026-01-01T00:00:00.000Z',
    status: 'verified',
    createdAt: 't',
    updatedAt: 't',
  });
  const row = db.prepare('SELECT id FROM source_items WHERE fingerprint=?').get(`fp${pos}`) as { id: number };
  return row.id;
}

describe('cleanup repositories', () => {
  describe('CleanupPlans', () => {
    it('creates and reads a plan', () => {
      seedBase();
      new CleanupPlans(db).create({
        id: 'cp1', sourceInstanceId: 's1', migrationJobId: 'j1',
        action: 'unfavorite', planHash: 'ph', configHash: 'ch',
        candidateCount: 10, excludedCount: 2, status: 'created', createdAt: 't',
      });
      const p = new CleanupPlans(db).get('cp1');
      expect(p?.action).toBe('unfavorite');
      expect(p?.candidateCount).toBe(10);
      expect(p?.excludedCount).toBe(2);
      expect(p?.migrationJobId).toBe('j1');
    });
    it('returns undefined for unknown id', () => {
      expect(new CleanupPlans(db).get('missing')).toBeUndefined();
    });
  });

  describe('CleanupJobs', () => {
    it('creates a job with default counts', () => {
      const { jobId } = seedPlanAndJob();
      const j = new CleanupJobs(db).get(jobId);
      expect(j?.status).toBe('running');
      expect(j?.successCount).toBe(0);
      expect(j?.processedCount).toBe(0);
    });

    it('updateCounts writes the count columns', () => {
      const { jobId } = seedPlanAndJob();
      new CleanupJobs(db).updateCounts(jobId, {
        successCount: 5, skippedCount: 2, failedCount: 1, unknownCount: 0, processedCount: 8,
      });
      const j = new CleanupJobs(db).get(jobId);
      expect(j?.successCount).toBe(5);
      expect(j?.processedCount).toBe(8);
    });

    it('updateStatus sets status and finished_at', () => {
      const { jobId } = seedPlanAndJob();
      new CleanupJobs(db).updateStatus(jobId, { status: 'completed', finishedAt: '2026-01-02', updatedAt: '2026-01-02' });
      const j = new CleanupJobs(db).get(jobId);
      expect(j?.status).toBe('completed');
      expect(j?.finishedAt).toBe('2026-01-02');
    });
  });

  describe('CleanupItems', () => {
    it('inserts and lists items by job', () => {
      const { jobId } = seedPlanAndJob();
      const itemId = seedSourceItem(1);
      new CleanupItems(db).upsert({
        jobId, sourceItemId: itemId,
        precheckStatus: 'favorited', actionStatus: ACTION_STATUS_UNFAVORITED,
        createdAt: 't', updatedAt: 't',
      });
      const items = new CleanupItems(db).listByJob(jobId);
      expect(items).toHaveLength(1);
      expect(items[0]!.actionStatus).toBe(ACTION_STATUS_UNFAVORITED);
    });

    it('UPSERT updates existing item instead of duplicating', () => {
      const { jobId } = seedPlanAndJob();
      const itemId = seedSourceItem(1);
      const repo = new CleanupItems(db);
      // 第一次：失败
      repo.upsert({
        jobId, sourceItemId: itemId,
        precheckStatus: 'favorited', actionStatus: 'verification_failed',
        lastErrorCode: 'still collected', createdAt: 't', updatedAt: 't1',
      });
      // 第二次：成功（重试场景）
      repo.upsert({
        jobId, sourceItemId: itemId,
        precheckStatus: 'favorited', actionStatus: ACTION_STATUS_UNFAVORITED,
        lastErrorCode: null, createdAt: 't', updatedAt: 't2',
      });
      const items = repo.listByJob(jobId);
      expect(items).toHaveLength(1); // 不重复
      expect(items[0]!.actionStatus).toBe(ACTION_STATUS_UNFAVORITED);
      expect(items[0]!.lastErrorCode).toBeNull();
    });

    it('findUnfavoritedSourceItemIds returns only successfully unfavorited items (cross-job)', () => {
      const { jobId: jobId1 } = seedPlanAndJob();
      const item1 = seedSourceItem(1); // 第一次清理成功
      const item2 = seedSourceItem(2); // 第一次清理失败
      const item3 = seedSourceItem(3); // 未清理

      new CleanupItems(db).upsert({
        jobId: jobId1, sourceItemId: item1,
        precheckStatus: 'favorited', actionStatus: ACTION_STATUS_UNFAVORITED,
        createdAt: 't', updatedAt: 't',
      });
      new CleanupItems(db).upsert({
        jobId: jobId1, sourceItemId: item2,
        precheckStatus: 'favorited', actionStatus: 'verification_failed',
        lastErrorCode: 'err', createdAt: 't', updatedAt: 't',
      });

      const done = new CleanupItems(db).findUnfavoritedSourceItemIds('s1');
      expect(done.has(item1)).toBe(true);  // 成功 → 排除
      expect(done.has(item2)).toBe(false); // 失败 → 不排除
      expect(done.has(item3)).toBe(false); // 未清理 → 不排除
    });

    it('findUnfavoritedSourceItemIds 也排除 already_unfavorited（本就未收藏，对目标已是终态）', () => {
      // §缺陷：already_unfavorited 表示条目在源侧本就未收藏（或内容已删除），
      // 对"取消收藏"目标已是终态。此前只排除 unfavorited_verified，导致重跑反复
      // 重新打开这些页面（纯浪费 + 加剧风控暴露）。
      const { jobId: jobId1 } = seedPlanAndJob();
      const item1 = seedSourceItem(1); // 成功取消
      const item2 = seedSourceItem(2); // 本就未收藏（skipped）
      const item3 = seedSourceItem(3); // 内容删除（skipped, content_unavailable）
      const item4 = seedSourceItem(4); // 未清理

      new CleanupItems(db).upsert({
        jobId: jobId1, sourceItemId: item1,
        precheckStatus: 'favorited', actionStatus: ACTION_STATUS_UNFAVORITED,
        createdAt: 't', updatedAt: 't',
      });
      new CleanupItems(db).upsert({
        jobId: jobId1, sourceItemId: item2,
        precheckStatus: 'not_favorited', actionStatus: 'already_unfavorited',
        createdAt: 't', updatedAt: 't',
      });
      new CleanupItems(db).upsert({
        jobId: jobId1, sourceItemId: item3,
        precheckStatus: 'content_unavailable', actionStatus: 'already_unfavorited',
        lastErrorCode: 'content_unavailable', createdAt: 't', updatedAt: 't',
      });

      const done = new CleanupItems(db).findUnfavoritedSourceItemIds('s1');
      expect(done.has(item1)).toBe(true); // 成功取消 → 排除
      expect(done.has(item2)).toBe(true); // 本就未收藏 → 排除（§缺陷修复）
      expect(done.has(item3)).toBe(true); // 内容删除 → 排除（§缺陷修复）
      expect(done.has(item4)).toBe(false); // 未清理 → 不排除
    });
  });

  describe('CleanupAttempts', () => {
    it('creates an attempt log', () => {
      const { jobId } = seedPlanAndJob();
      const itemId = seedSourceItem(1);
      // 先建 item 拿到自增 id
      new CleanupItems(db).upsert({
        jobId, sourceItemId: itemId,
        precheckStatus: 'favorited', actionStatus: ACTION_STATUS_UNFAVORITED,
        createdAt: 't', updatedAt: 't',
      });
      const itemRow = new CleanupItems(db).listByJob(jobId)[0]!;

      new CleanupAttempts(db).create({
        cleanupItemId: itemRow.id, attemptNo: 1,
        preActionState: 'favorited', actionResult: ACTION_STATUS_UNFAVORITED,
        startedAt: 't1', finishedAt: 't2', createdAt: 't2',
      });
      const attempts = db.prepare('SELECT * FROM cleanup_action_attempts WHERE cleanup_item_id=?').all(itemRow.id);
      expect(attempts).toHaveLength(1);
    });
  });
});
