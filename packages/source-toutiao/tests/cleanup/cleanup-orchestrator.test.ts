import { describe, it, expect, vi } from 'vitest';
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
      sleepFn: async () => {}, // 失败会触发 backoff 等待，注入避免真等 10 分钟
    });

    expect(result.successCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.unknownCount).toBe(1);
    // 失败那条：首次 failed+1 → backoff → 重试（receipt 耗尽仍失败）回退后 +1 = 1
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

  it('节奏控制：条目间按 intervalMs±抖动等待（注入 sleepFn 断言不真等）', async () => {
    const db = seedDb(3);
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
    ]);
    const sleeps: number[] = [];
    const sleepSpy = async (ms: number) => { sleeps.push(ms); };

    await runCleanupUnfavorite({
      db,
      sourceAdapter: adapter,
      sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID,
      workspaceDir: '/tmp/ws',
      intervalMs: 2000,
      sleepFn: sleepSpy,
    });

    // 3 条候选 → 条目间等待 2 次（最后一条后不等待）
    expect(sleeps.length).toBe(2);
    // 每次 sleep 落在 2000×[0.6, 1.4] = [1200, 2800] 区间
    for (const s of sleeps) {
      expect(s).toBeGreaterThanOrEqual(1200);
      expect(s).toBeLessThanOrEqual(2800);
    }

    db.close();
  });

  it('默认上限：不传 maxItems 且候选 >200 时只处理 200 条', async () => {
    const db = seedDb(205);
    const adapter = mockAdapter(
      Array.from({ length: 205 }, () => ({ success: true, wasCollected: true, isCollected: false })),
    );
    const sleepSpy = async () => {}; // 不真等

    const result = await runCleanupUnfavorite({
      db,
      sourceAdapter: adapter,
      sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID,
      workspaceDir: '/tmp/ws',
      sleepFn: sleepSpy,
      // 故意不传 maxItems，验证默认 200
    });

    expect(result.successCount).toBe(200); // 只处理 200，剩余 5 条留待下次

    db.close();
  });

  it('取消时 processed_count 反映实际处理数且 status=interrupted（非 completed）', async () => {
    // §缺陷2：取消时应如实记录已处理条目数，并把 Job 标为 interrupted，
    // 不能把 processedCount 写成 candidateCount、状态写死 completed。
    const db = seedDb(3);
    let callCount = 0;
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false }, // 不应被处理
    ]);
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

    expect(callCount).toBe(2);
    const job = db
      .prepare(`SELECT status, candidate_count AS candidateCount, processed_count AS processedCount FROM cleanup_jobs ORDER BY created_at DESC LIMIT 1`)
      .get() as { status: string; candidateCount: number; processedCount: number };
    expect(job.candidateCount).toBe(3);
    expect(job.processedCount).toBe(2); // 实际处理数，而非 candidateCount
    expect(job.status).toBe('interrupted'); // 不是 'completed'

    db.close();
  });

  it('重试仍失败终止任务时 processed_count 反映实际处理数且 status=interrupted', async () => {
    // §缺陷2：失败终止路径同样应如实记录。第 1 条重试仍失败→终止，只处理 1 条。
    const db = seedDb(2);
    const adapter = mockAdapter([
      { success: false, wasCollected: true, isCollected: true, reason: 'still collected after click' },
      { success: false, wasCollected: true, isCollected: true, reason: 'still collected after click' },
      { success: true, wasCollected: true, isCollected: false }, // 不应被消费
    ]);
    const wrapped: SourceAdapter = {
      ...adapter,
      cleanup: {
        supportedActions: ['unfavorite'],
        executeAction: async (ref: SourceItemRef) => adapter.cleanup!.executeAction(ref),
      },
    } as unknown as SourceAdapter;

    await runCleanupUnfavorite({
      db, sourceAdapter: wrapped, sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID, workspaceDir: '/tmp/ws', sleepFn: async () => {},
    });

    const job = db
      .prepare(`SELECT status, candidate_count AS candidateCount, processed_count AS processedCount FROM cleanup_jobs ORDER BY created_at DESC LIMIT 1`)
      .get() as { status: string; candidateCount: number; processedCount: number };
    expect(job.candidateCount).toBe(2);
    expect(job.processedCount).toBe(1); // 只处理了第 1 条（重试仍失败）就终止
    expect(job.status).toBe('interrupted');

    db.close();
  });

  it('取消时跳过条目间等待（不等满）', async () => {
    const db = seedDb(3);
    let callCount = 0;
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
    ]);
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
    const sleepSpy = vi.fn(async () => {});

    await runCleanupUnfavorite({
      db,
      sourceAdapter: wrapped,
      sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID,
      workspaceDir: '/tmp/ws',
      intervalMs: 60000, // 故意大，若取消未跳过等待会拖慢测试
      sleepFn: sleepSpy,
      isCancelled: () => callCount >= 2,
    });

    // 第 1 条处理完（callCount=1）→ isCancelled 仍 false → 第 1→2 条之间等待 1 次
    // 第 2 条处理完（callCount=2）→ isCancelled 转 true → 第 2→3 条之间的等待被跳过
    expect(sleepSpy).toHaveBeenCalledTimes(1);

    db.close();
  });

  it('只清理 article：video 等非文章类型不进入候选', async () => {
    const db = seedDb(2); // 2 条 article
    const ts = '2026-06-01T00:00:00Z';
    // 额外插入 1 条 video（status=verified），验证它被候选过滤排除
    db.prepare(
      `INSERT INTO source_items(
         source_instance_id, fingerprint, stable_key, item_key, stable_short_id,
         canonical_url, title, content_kind, discovered_at, status, created_at, updated_at)
       VALUES (?, 'fp-v', 'sk-v', 'ik-v', 'sid-v',
         'https://www.toutiao.com/video/999/', '视频', 'video', ?, 'verified', ?, ?)`,
    ).run(SOURCE_INSTANCE_ID, ts, ts, ts);

    const executeCount = { n: 0 };
    const adapter = mockAdapter([
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
    ]);
    const wrapped: SourceAdapter = {
      ...adapter,
      cleanup: {
        supportedActions: ['unfavorite'],
        executeAction: async (ref: SourceItemRef) => {
          executeCount.n++;
          // 若 video 被错误纳入候选，canonicalUrl 会含 /video/
          expect(ref.canonicalUrl).not.toContain('/video/');
          return adapter.cleanup!.executeAction(ref);
        },
      },
    } as unknown as SourceAdapter;

    const result = await runCleanupUnfavorite({
      db, sourceAdapter: wrapped, sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID, workspaceDir: '/tmp/ws', sleepFn: async () => {},
    });

    // 只处理 2 条 article，video 被排除
    expect(executeCount.n).toBe(2);
    expect(result.successCount).toBe(2);

    db.close();
  });

  it('失败重试：首次失败→等待→重试成功，不计入失败终止', async () => {
    const db = seedDb(2);
    // 第 1 条：先失败（风控），重试时成功；第 2 条：成功
    const adapter = mockAdapter([
      { success: false, wasCollected: true, isCollected: true, reason: 'still collected after click' },
      { success: true, wasCollected: true, isCollected: false },
      { success: true, wasCollected: true, isCollected: false },
    ]);
    const sleeps: number[] = [];

    const result = await runCleanupUnfavorite({
      db, sourceAdapter: adapter, sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID, workspaceDir: '/tmp/ws',
      sleepFn: async (ms) => { sleeps.push(ms); }, // 不真等 10 分钟
    });

    // 第 1 条重试成功 + 第 2 条成功 → 2 条都成功
    expect(result.successCount).toBe(2);
    expect(result.failedCount).toBe(0);
    // 失败后触发了等待（backoff），sleep 被调用
    expect(sleeps.length).toBeGreaterThan(0);

    db.close();
  });

  it('重试仍失败→终止任务：第 1 条重试还失败，第 2 条不处理', async () => {
    const db = seedDb(2);
    // 第 1 条：失败→重试仍失败（持续风控）；第 2 条本应成功但因终止不被处理
    const adapter = mockAdapter([
      { success: false, wasCollected: true, isCollected: true, reason: 'still collected after click' },
      { success: false, wasCollected: true, isCollected: true, reason: 'still collected after click' },
      { success: true, wasCollected: true, isCollected: false }, // 第 2 条（不应被消费）
    ]);
    let executeCount = 0;
    const wrapped: SourceAdapter = {
      ...adapter,
      cleanup: {
        supportedActions: ['unfavorite'],
        executeAction: async (ref: SourceItemRef) => {
          executeCount++;
          return adapter.cleanup!.executeAction(ref);
        },
      },
    } as unknown as SourceAdapter;

    const result = await runCleanupUnfavorite({
      db, sourceAdapter: wrapped, sourceInstanceId: SOURCE_INSTANCE_ID,
      migrationJobId: MIGRATION_JOB_ID, workspaceDir: '/tmp/ws', sleepFn: async () => {},
    });

    // 第 1 条：2 次 execute（首次+重试）都失败 → 终止；第 2 条不处理
    expect(executeCount).toBe(2);
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(1); // 终止前落库的第 1 条（重试回退后最终计 1 次失败）

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
