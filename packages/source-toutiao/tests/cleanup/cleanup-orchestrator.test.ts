import { describe, it, expect } from 'vitest';
import { openDatabase, type DB, type SourceAdapter, type SourceItemRef, type CleanupActionReceipt } from '@inkmigrate/core';
import { runCleanupUnfavorite } from '../../src/cleanup/cleanup-orchestrator.js';

const SOURCE_INSTANCE_ID = 'src-test';
const MIGRATION_JOB_ID = 'mig-test-1';
const TARGET_INSTANCE_ID = 'tgt-test';

/** 建内存库并 seed 必要的父表行 + N 条 status='verified' 的 source_items。 */
function seedDb(itemCount: number): DB {
  const db = openDatabase({ path: ':memory:' });
  const ts = '2026-06-01T00:00:00Z';
  db.prepare(
    `INSERT INTO source_instances(id, adapter_kind, adapter_version, adapter_api_version, config_hash, created_at, updated_at)
     VALUES (?, 'toutiao', '1.0.0', '1.0.0', 'h', ?, ?)`,
  ).run(SOURCE_INSTANCE_ID, ts, ts);
  db.prepare(
    `INSERT INTO target_instances(id, adapter_kind, adapter_version, adapter_api_version, config_hash, created_at, updated_at)
     VALUES (?, 'obsidian', '1.0.0', '1.0.0', 'h', ?, ?)`,
  ).run(TARGET_INSTANCE_ID, ts, ts);
  db.prepare(
    `INSERT INTO migration_jobs(id, source_instance_id, target_instance_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'completed', ?, ?)`,
  ).run(MIGRATION_JOB_ID, SOURCE_INSTANCE_ID, TARGET_INSTANCE_ID, ts, ts);

  const ins = db.prepare(
    `INSERT INTO source_items(
       source_instance_id, fingerprint, stable_key, item_key, stable_short_id,
       canonical_url, title, content_kind, discovered_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'article', ?, 'verified', ?, ?)`,
  );
  for (let i = 0; i < itemCount; i++) {
    ins.run(
      SOURCE_INSTANCE_ID,
      `fp-${i}`,
      `sk-${i}`,
      `ik-${i}`,
      `sid-${i}`,
      `https://www.toutiao.com/article/${i}/`,
      `标题${i}`,
      ts,
      ts,
      ts,
    );
  }
  return db;
}

interface MockReceiptSpec {
  /** 该 source_item 的 canonical_url 片段，用于匹配；按顺序消费。 */
  match: string;
  receipt: CleanupActionReceipt;
}

/**
 * 构造 mock 适配器：executeAction 按 receipts 队列顺序返回（无视 ref）。
 * 模拟"一次导航执行"——不启浏览器，专注验证编排器的 receipt→四类映射与落库。
 */
function mockAdapter(receipts: CleanupActionReceipt[]): SourceAdapter {
  let cursor = 0;
  return {
    kind: 'toutiao',
    version: '1.0.0',
    adapterApiVersion: '1.0.0',
    capabilities: { authMode: 'cookie', supportsSourceCleanup: true, supportedSourceKinds: ['toutiao'] } as never,
    validateConfig: async () => ({ ok: true }),
    prepare: async () => {},
    close: async () => {},
    cleanup: {
      supportedActions: ['unfavorite'],
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      executeAction: async (_ref: SourceItemRef): Promise<CleanupActionReceipt> => {
        return receipts[cursor++] ?? { success: false, reason: 'exhausted' };
      },
    },
  } as unknown as SourceAdapter;
}

describe('runCleanupUnfavorite', () => {
  it('按 receipt 映射 成功/跳过/未知/失败 四类计数', async () => {
    const db = seedDb(4);
    // 4 条候选 → 4 种 receipt：成功 / 跳过(本就未收藏) / 未知(not found) / 失败(still collected)
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },                     // 成功
      { success: true, wasCollected: false, isCollected: false },                    // 跳过
      { success: false, wasCollected: false, isCollected: false, reason: 'collect button not found' }, // 未知
      { success: false, wasCollected: true, isCollected: true, reason: 'still collected after click' }, // 失败
    ]);

    const result = await runCleanupUnfavorite({
      db,
      sourceAdapter: adapter,
      sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID,
      workspaceDir: '/tmp/ws',
    });

    expect(result.successCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.unknownCount).toBe(1);
    expect(result.failedCount).toBe(1);

    db.close();
  });

  it('成功项落库 action_status=unfavorited_verified（续跑契约）', async () => {
    const db = seedDb(1);
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },
    ]);

    await runCleanupUnfavorite({
      db,
      sourceAdapter: adapter,
      sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID,
      workspaceDir: '/tmp/ws',
    });

    const rows = db
      .prepare(`SELECT action_status AS s FROM cleanup_items WHERE job_id = ?`)
      .all(result_jobId(db)) as Array<{ s: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.s).toBe('unfavorited_verified');

    db.close();
  });

  it('续跑过滤：已成功的 source_item 在下次运行被排除（根治重跑）', async () => {
    const db = seedDb(2);
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
    ]);

    // 第一次：2 条都成功
    const r1 = await runCleanupUnfavorite({
      db, sourceAdapter: adapter, sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID, workspaceDir: '/tmp/ws',
    });
    expect(r1.successCount).toBe(2);

    // 第二次：候选已被 findUnfavoritedSourceItemIds 全部排除 → 0 条
    const r2 = await runCleanupUnfavorite({
      db, sourceAdapter: mockAdapter([]), sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID, workspaceDir: '/tmp/ws',
    });
    expect(r2.successCount).toBe(0);

    db.close();
  });

  it('isCancelled 在处理新条目前优雅终止，已处理项仍落库', async () => {
    const db = seedDb(3);
    let callCount = 0;
    // 第 2 次调用后置取消标志
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
    ]);
    // 包一层计数
    const wrapped: SourceAdapter = {
      ...adapter,
      cleanup: {
        supportedActions: ['unfavorite'],
        executeAction: async (ref: SourceItemRef) => {
          const r = await adapter.cleanup!.executeAction(ref);
          callCount++;
          return r;
        },
      },
    } as unknown as SourceAdapter;

    await runCleanupUnfavorite({
      db,
      sourceAdapter: wrapped,
      sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID,
      workspaceDir: '/tmp/ws',
      isCancelled: () => callCount >= 2,
    });

    expect(callCount).toBe(2); // 第 2 条处理完后，下轮检测到取消，第 3 条不处理
    db.close();
  });
});

/** 从库里查出本次 cleanup job id（取最新一条）。 */
function result_jobId(db: DB): string {
  return (
    db
      .prepare(`SELECT id FROM cleanup_jobs ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
}
