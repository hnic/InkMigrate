import type { DB, SourceAdapter, SourceItemRef, CleanupContext } from '@inkmigrate/core';
import {
  CleanupPlans,
  CleanupJobs,
  CleanupItems,
  CleanupAttempts,
  ACTION_STATUS_UNFAVORITED,
} from '@inkmigrate/core';
import { decideCleanupAction, type PreActionState } from './cleanup-state-machine.js';

export interface CleanupProgress {
  phase: 'cleanup';
  current: number;
  total: number;
  currentItem?: string;
}

export interface CleanupLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CleanupOrchestratorOptions {
  db: DB;
  /** 已 prepare 完毕的源适配器（含 .cleanup）。调用方负责 prepare/close。 */
  sourceAdapter: SourceAdapter;
  sourceInstanceId: string;
  /** 关联的迁移任务 ID（满足 cleanup_plans.migration_job_id FK）。 */
  migrationJobId: string;
  workspaceDir: string;
  maxItems?: number;
  onProgress?: (p: CleanupProgress) => void;
  onLog?: (entry: CleanupLogEntry) => void;
  /** 取消检查回调（可选）。循环每轮检查，返回 true 时优雅终止并落库部分结果。 */
  isCancelled?: () => boolean;
}

export interface CleanupOrchestratorResult {
  jobId: string;
  planId: string;
  successCount: number;
  skippedCount: number;
  failedCount: number;
  unknownCount: number;
}

/** 每种失败原因只打印前几条样例，避免日志刷屏。 */
const REASON_SAMPLE_LIMIT = 3;

/** adapter inspectActionState 返回的连字符状态 → state-machine 的下划线状态。 */
function toPreActionState(state: 'favorited' | 'not-favorited' | 'unknown'): PreActionState {
  switch (state) {
    case 'favorited': return 'favorited';
    case 'not-favorited': return 'not_favorited';
    case 'unknown': return 'unknown';
  }
}

/** §14.5–§14.15 清理编排器：串联 inspect → decide(state-machine) → execute → 落库。
 *
 * 这是此前缺失的"编排者"——cleanup-state-machine / verifier 等纯函数已实现但从未被
 * 串联进运行时。本函数首次将它们接入，并把结果持久化到 cleanup_plans/jobs/items/
 * action_attempts 四张表（此前 GUI 路径只在内存计数，导致清理后无法区分已清理/待清理，
 * 反复重选同一批条目）。
 */
export async function runCleanupUnfavorite(
  opts: CleanupOrchestratorOptions,
): Promise<CleanupOrchestratorResult> {
  const { db, sourceAdapter, sourceInstanceId, migrationJobId, workspaceDir } = opts;
  const cleanup = sourceAdapter.cleanup;
  if (cleanup === undefined) {
    throw new Error('source adapter does not support cleanup');
  }

  // 1. 查候选：status='verified' 的条目，排除已成功取消收藏的（根治重跑）
  const alreadyDone = new CleanupItems(db).findUnfavoritedSourceItemIds(sourceInstanceId);
  const limit = opts.maxItems;
  const allRows = db
    .prepare(
      `SELECT id, canonical_url, title, external_id, content_kind, fingerprint, discovered_at, source_position
       FROM source_items
       WHERE source_instance_id = ? AND status = 'verified'
       ORDER BY source_position ASC`,
    )
    .all(sourceInstanceId) as Array<{
      id: number;
      canonical_url: string | null;
      title: string | null;
      external_id: string | null;
      content_kind: string;
      fingerprint: string;
      discovered_at: string;
      source_position: number | null;
    }>;
  const rows = (limit !== undefined ? allRows.slice(0, limit) : allRows)
    .filter((r) => !alreadyDone.has(r.id));

  if (rows.length === 0) {
    opts.onLog?.({ level: 'info', message: alreadyDone.size > 0 ? '没有需要清理的条目（均已成功取消收藏）' : '没有已迁移的条目可清理' });
    return { jobId: '', planId: '', successCount: 0, skippedCount: 0, failedCount: 0, unknownCount: 0 };
  }

  const now = () => new Date().toISOString();
  const ts = now();

  // 2. 建 plan + job
  const planId = `cleanup-plan-${Date.now()}`;
  const jobId = `cleanup-${Date.now()}`;
  new CleanupPlans(db).create({
    id: planId,
    sourceInstanceId,
    migrationJobId,
    action: 'unfavorite',
    planHash: `ph-${Date.now()}`,
    configHash: `ch-${workspaceDir.length}`,
    candidateCount: rows.length,
    excludedCount: alreadyDone.size,
    status: 'created',
    createdAt: ts,
  });
  new CleanupJobs(db).create({
    id: jobId,
    planId,
    planHash: `ph-${Date.now()}`,
    action: 'unfavorite',
    status: 'running',
    candidateCount: rows.length,
    startedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  });

  opts.onLog?.({ level: 'info', message: `开始取消收藏，共 ${rows.length} 条${alreadyDone.size > 0 ? `（已排除 ${alreadyDone.size} 条成功项）` : ''}...` });

  const ctx: CleanupContext = { config: {}, workspaceDir };
  // 失败原因聚合（采样 + 汇总），保留既有可观测性
  const failReasons = new Map<string, number>();

  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let unknownCount = 0;
  const itemsRepo = new CleanupItems(db);
  const attemptsRepo = new CleanupAttempts(db);

  for (let i = 0; i < rows.length; i++) {
    // 取消检查（GUI 终止按钮）：在处理新条目前退出，已处理的落库不丢
    if (opts.isCancelled?.()) {
      opts.onLog?.({ level: 'warn', message: `任务已终止：已处理 ${i}/${rows.length} 条` });
      break;
    }
    const row = rows[i]!;
    const titleShort = row.title?.substring(0, 50);
    opts.onProgress?.({
      phase: 'cleanup',
      current: i + 1,
      total: rows.length,
      ...(titleShort !== undefined ? { currentItem: titleShort } : {}),
    });

    const ref: SourceItemRef = {
      sourceInstanceId,
      contentKind: row.content_kind as SourceItemRef['contentKind'],
      discoveredAt: row.discovered_at || ts,
      fingerprint: row.fingerprint || '',
      sourceMetadata: {},
      ...(row.canonical_url ? { canonicalUrl: row.canonical_url, originalUrl: row.canonical_url } : {}),
      ...(row.title ? { title: row.title } : {}),
      ...(row.source_position !== null ? { sourcePosition: row.source_position } : {}),
      ...(row.external_id ? { externalId: row.external_id } : {}),
    };

    const actionStartedAt = now();
    let precheckStatus: PreActionState = 'unknown';
    let actionStatus = 'unknown';
    let lastErrorCode: string | null = null;
    let lastErrorMessage: string | null = null;

    try {
      // a. inspect（pre-check）
      const stateResult = await cleanup.inspectActionState(ref, 'unfavorite', ctx);
      precheckStatus = toPreActionState(stateResult.state);

      // b. decide（接入 state-machine）
      const decision = decideCleanupAction({ preActionState: precheckStatus });

      if (decision.action === 'execute') {
        // c. execute
        const receipt = await cleanup.executeAction(ref, 'unfavorite', ctx);
        if (receipt.success && receipt.isCollected === false) {
          actionStatus = ACTION_STATUS_UNFAVORITED;
          successCount++;
        } else if (receipt.success && receipt.isCollected === undefined && receipt.wasCollected === true) {
          // 适配器未回报 isCollected 但操作成功，视为已取消
          actionStatus = ACTION_STATUS_UNFAVORITED;
          successCount++;
        } else {
          actionStatus = 'verification_failed';
          failedCount++;
          const reason = receipt.reason ?? 'still collected after click';
          lastErrorCode = reason;
          lastErrorMessage = reason;
          recordFailure(failReasons, reason, row.title, opts.onLog);
        }
      } else if (decision.action === 'skip') {
        actionStatus = decision.finalState ?? 'skipped';
        if (precheckStatus === 'not_favorited') skippedCount++;
        else unknownCount++;
      } else {
        // pause：登录/验证码挑战，记为失败需人工介入
        actionStatus = 'paused';
        failedCount++;
        lastErrorCode = decision.pauseReason ?? 'paused';
        lastErrorMessage = `需要人工介入：${decision.pauseReason}`;
        recordFailure(failReasons, decision.pauseReason ?? 'paused', row.title, opts.onLog);
      }
    } catch (e) {
      actionStatus = 'permanent_failed';
      failedCount++;
      const reason = `exception: ${e instanceof Error ? e.message : String(e)}`;
      lastErrorCode = reason;
      lastErrorMessage = reason;
      recordFailure(failReasons, reason, row.title, opts.onLog);
    }

    const actionFinishedAt = now();
    // d. 落库（UPSERT 支持断点续跑）
    itemsRepo.upsert({
      jobId,
      sourceItemId: row.id,
      precheckStatus,
      preActionState: precheckStatus,
      actionStatus,
      postActionState: actionStatus,
      actionStartedAt,
      actionFinishedAt,
      verifiedAt: actionStatus === ACTION_STATUS_UNFAVORITED ? actionFinishedAt : null,
      lastErrorCode,
      lastErrorMessage,
      createdAt: ts,
      updatedAt: actionFinishedAt,
    });
    // 审计日志（cleanup_item_id 由 UPSERT 产生，回查）
    const itemRow = itemsRepo.listByJob(jobId).find((it) => it.sourceItemId === row.id);
    if (itemRow !== undefined) {
      attemptsRepo.create({
        cleanupItemId: itemRow.id,
        attemptNo: 1,
        preActionState: precheckStatus,
        actionResult: actionStatus,
        postActionState: actionStatus,
        startedAt: actionStartedAt,
        finishedAt: actionFinishedAt,
        errorCode: lastErrorCode,
        errorMessage: lastErrorMessage,
        createdAt: actionFinishedAt,
      });
    }
  }

  // 5. 收尾
  const finishedAt = now();
  new CleanupJobs(db).updateCounts(jobId, {
    processedCount: rows.length,
    successCount,
    skippedCount,
    failedCount,
    unknownCount,
  });
  new CleanupJobs(db).updateStatus(jobId, { status: 'completed', finishedAt, updatedAt: finishedAt });

  opts.onLog?.({
    level: failedCount > 0 ? 'warn' : 'info',
    message: `清理完成：成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}${unknownCount > 0 ? `，未知 ${unknownCount}` : ''}`,
  });
  if (failedCount > 0 && failReasons.size > 0) {
    const summary = Array.from(failReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}×${count}`)
      .join('，');
    opts.onLog?.({ level: 'warn', message: `失败原因汇总：${summary}` });
  }

  return { jobId, planId, successCount, skippedCount, failedCount, unknownCount };
}

function recordFailure(
  failReasons: Map<string, number>,
  reason: string,
  title: string | null,
  onLog?: (e: CleanupLogEntry) => void,
): void {
  const prev = failReasons.get(reason) ?? 0;
  failReasons.set(reason, prev + 1);
  if (prev < REASON_SAMPLE_LIMIT && onLog) {
    onLog({
      level: 'warn',
      message: `取消收藏失败（${reason}）：${title?.substring(0, 50) ?? '(无标题)'}`,
    });
  }
}
