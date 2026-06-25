import type { DB } from '../storage/database.js';
import type {
  SourceAdapter,
  TargetAdapter,
  TargetContext,
} from '../adapters/adapter.js';
import type { SourceItem, SourceItemRef } from '../domain/models.js';
import type { ItemFinalState, FinalStateCounts } from '../domain/states.js';
import { MigrationJobs } from '../storage/repositories/migration-jobs.js';
import { SourceItems } from '../storage/repositories/source-items.js';
import { TargetArtifacts } from '../storage/repositories/target-artifacts.js';
import { MigrationAttempts } from '../storage/repositories/migration-attempts.js';
import {
  computeStableKey,
  deriveStableShortId,
  deriveItemKey,
} from '../domain/stable-keys.js';
import { acquireLock } from './locks.js';
import { reconcileJob, deriveFinalStateCounts } from './reconciliation.js';
import {
  generateMigrationReport,
  type ReportItemRow,
} from '../reports/migration-report.js';
import { isQualityUpgradeCandidate } from './quality-upgrade.js';
import { withRetry, DEFAULT_RETRY_POLICY } from './retry.js';
import { installSignalHandlers } from './signals.js';

export interface JobRunnerInput {
  db: DB;
  jobId: string;
  sourceAdapter: SourceAdapter;
  targetAdapter: TargetAdapter;
  sourceInstanceId: string;
  targetInstanceId: string;
  targetContext: TargetContext;
  workspaceDir: string;
  reportsDir: string;
  /**
   * 进度回调（可选）。在扫描完成、每条提取完成时触发。
   * 用于 GUI/CLI 实时显示进度。
   */
  onProgress?: (progress: JobProgress) => void;
}

/** 迁移进度信息，由 job-runner 在关键节点推送给调用方。 */
export interface JobProgress {
  phase: 'scanning' | 'migrating';
  jobId: string;
  /** 当前已处理条目数。 */
  current: number;
  /** 总条目数（scanning 阶段可能为 0）。 */
  total: number;
  /** 当前处理的条目标题（可选）。 */
  currentItem?: string;
  /** 累积状态计数。 */
  counts?: {
    verified?: number;
    degraded?: number;
    failed?: number;
    conflict?: number;
    skipped?: number;
  };
}

export interface JobRunnerResult {
  status: 'completed' | 'failed' | 'interrupted';
  scanCount: number;
  finalStateCounts: Record<string, number>;
  reconciliationOk: boolean;
  reconciliationReason?: string;
}

/**
 * §11 通用迁移管线 Job Runner。
 *
 * 阶段顺序（§11.1）：
 *   preflight → scanning → planning → extracting → normalizing →
 *   transferring_assets → writing_target → verifying_target →
 *   generating_indexes(v1.0 skipped) → reporting → completed
 *
 * 集成特性（v1.0-rc1 wiring）：
 * - §18.1/§18.2 retry：extract 包裹 withRetry + DEFAULT_RETRY_POLICY
 * - §18.3 信号处理：installSignalHandlers，第一次 Ctrl+C 优雅停止
 * - §16.7 migration_attempts：每条目创建 attempt 记录
 * - §16.6 target_artifacts lifecycle：planned → written → verified
 * - §11.9 recoverableCount：从 itemStates 统计 retryable_failed
 */
export async function runMigrationJob(
  i: JobRunnerInput,
): Promise<JobRunnerResult> {
  const jobs = new MigrationJobs(i.db);
  const sourceItemsRepo = new SourceItems(i.db);
  const targetArtifacts = new TargetArtifacts(i.db);
  const attempts = new MigrationAttempts(i.db);
  const now = () => new Date().toISOString();

  // §18.4 获取任务锁
  const lock = acquireLock({
    locksDir: `${i.workspaceDir}/.inkmigrate/locks`,
    lockName: `migration-${i.sourceInstanceId}-${i.targetInstanceId}`,
    jobId: i.jobId,
  });

  // §18.3 信号处理
  let interrupted = false;
  const uninstallSignals = installSignalHandlers({
    onFirstInterrupt: async () => {
      interrupted = true;
    },
    onSecondInterrupt: () => {
      process.exit(130);
    },
  });

  // §13.9 注入 jobId 到 targetContext，让 Obsidian frontmatter 记录正确的 migration_job_id
  // __migrationJobId 是 ObsidianTargetConfigSchema 中声明的可选内部键，不会破坏 strict 校验
  const targetContextWithJobId: TargetContext = {
    ...i.targetContext,
    targetConfig: {
      ...i.targetContext.targetConfig,
      __migrationJobId: i.jobId,
    },
  };

  try {
    // preflight
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'preflight',
      updatedAt: now(),
    });

    // §8.2 prepare source adapter (launch browser for real adapters)
    await i.sourceAdapter.prepare({
      config: {},
      workspaceDir: i.workspaceDir,
    });

    // scanning
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'scanning',
      updatedAt: now(),
    });

    const refs: SourceItemRef[] = [];
    for await (const ref of i.sourceAdapter.scan({
      config: {},
      workspaceDir: i.workspaceDir,
    })) {
      refs.push(ref);
      persistSourceItemRef(sourceItemsRepo, i.sourceInstanceId, ref, refs.length - 1);
      // 扫描阶段实时推送进度
      if (i.onProgress !== undefined) {
        i.onProgress({
          phase: 'scanning',
          jobId: i.jobId,
          current: refs.length,
          total: 0,
        });
      }
    }
    jobs.updateCounts(i.jobId, { scanCount: refs.length });

    // planning
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'planning',
      updatedAt: now(),
    });
    jobs.updateCounts(i.jobId, { candidateCount: refs.length });

    // 逐条 extract → write → verify
    // §18.1 条目间速率控制：默认每条之间等待 1500ms，避免触发风控
    const configRecord = i.targetContext.config as Record<string, unknown>;
    const intervalMs = (configRecord['intervalMs'] as number | undefined) ?? 1500;
    const itemStates: ItemFinalState[] = [];
    // 增量状态计数器（避免每条目全量重扫 itemStates）
    const progressCounts: FinalStateCounts = {
      verified: 0,
      degraded: 0,
      permanent_failed: 0,
      unsupported: 0,
      blocked: 0,
      conflict: 0,
      skipped: 0,
    };
    for (let idx = 0; idx < refs.length; idx++) {
      const ref = refs[idx]!;
      // §18.3 检查中断标志——完成当前条目后停止
      if (interrupted) break;

      jobs.updateStatus(i.jobId, {
        status: 'running',
        currentStage: 'extracting',
        updatedAt: now(),
      });
      const state = await processOneItem({
        ref,
        db: i.db,
        sourceAdapter: i.sourceAdapter,
        targetAdapter: i.targetAdapter,
        targetContext: targetContextWithJobId,
        sourceInstanceId: i.sourceInstanceId,
        sourceItemsRepo,
        targetArtifacts,
        attempts,
        jobId: i.jobId,
        targetInstanceId: i.targetInstanceId,
        workspaceDir: i.workspaceDir,
        retryPolicy: DEFAULT_RETRY_POLICY,
      });
      itemStates.push(state);

      // 迁移阶段实时推送进度 + 增量计数器（O(1) 而非每条全量重扫）
      if (i.onProgress !== undefined) {
        if (state in progressCounts) {
          progressCounts[state as keyof FinalStateCounts]++;
        }

        i.onProgress({
          phase: 'migrating',
          jobId: i.jobId,
          current: idx + 1,
          total: refs.length,
          ...(() => {
            const ref = refs[idx];
            return ref?.title !== undefined ? { currentItem: ref.title.substring(0, 60) } : {};
          })(),
          counts: {
            verified: progressCounts.verified,
            degraded: progressCounts.degraded,
            failed: progressCounts.permanent_failed + progressCounts.unsupported + progressCounts.blocked,
            conflict: progressCounts.conflict,
            skipped: progressCounts.skipped,
          },
        });
      }

      // §18.1 最后一条不需要等待
      if (idx < refs.length - 1 && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    // §18.3 如果被中断，把未处理条目标记为 interrupted
    if (interrupted) {
      const processed = itemStates.length;
      for (let idx = processed; idx < refs.length; idx++) {
        itemStates.push('skipped');
      }
    }

    // 更新缓存计数
    const counts = deriveFinalStateCounts(itemStates);
    jobs.updateCounts(i.jobId, {
      verifiedCount: counts.verified,
      degradedCount: counts.degraded,
      failedCount:
        counts.permanent_failed + counts.unsupported + counts.blocked,
      conflictCount: counts.conflict,
      skippedCount: counts.skipped,
    });

    // reporting
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'reporting',
      updatedAt: now(),
    });

    const jobRow = jobs.get(i.jobId);
    // §11.9 recoverableCount 从 itemStates 统计
    const recoverableCount = (itemStates as string[]).filter(
      (s) => s === 'retryable_failed' || s === 'interrupted',
    ).length;

    const reconciliation = reconcileJob({
      scanCount: refs.length,
      itemStates,
      recoverableCount,
      cachedCounts: {
        verified_count: jobRow.verifiedCount,
        degraded_count: jobRow.degradedCount,
        failed_count: jobRow.failedCount,
        conflict_count: jobRow.conflictCount,
        skipped_count: jobRow.skippedCount,
      },
    });

    const reportItems: ReportItemRow[] = refs.map((ref, idx) => ({
      fingerprint: ref.fingerprint,
      title: ref.title ?? `(item ${idx + 1})`,
      status: itemStates[idx]!,
      contentKind: ref.contentKind,
    }));
    const reportInput: Parameters<typeof generateMigrationReport>[0] = {
      reportsDir: i.reportsDir,
      jobId: i.jobId,
      scanCount: refs.length,
      candidateCount: refs.length,
      counts,
      items: reportItems,
      reconciliationOk: reconciliation.ok,
    };
    if (reconciliation.reason !== undefined) {
      reportInput.reconciliationReason = reconciliation.reason;
    }
    generateMigrationReport(reportInput);

    // 确定 final status
    let finalStatus: 'completed' | 'failed' | 'interrupted';
    if (interrupted) {
      finalStatus = 'interrupted';
    } else {
      finalStatus = reconciliation.ok ? 'completed' : 'failed';
    }
    jobs.updateStatus(i.jobId, {
      status: finalStatus,
      currentStage: 'completed',
      updatedAt: now(),
    });

    const result: JobRunnerResult = {
      status: finalStatus,
      scanCount: refs.length,
      finalStateCounts: counts as unknown as Record<string, number>,
      reconciliationOk: reconciliation.ok,
    };
    if (reconciliation.reason !== undefined) {
      result.reconciliationReason = reconciliation.reason;
    }
    return result;
  } finally {
    // §8.2 close source adapter (close browser for real adapters)
    await i.sourceAdapter.close().catch(() => {
      // close 失败不应阻塞 finally 中的其他清理
    });
    uninstallSignals();
    lock.release();
  }
}

function persistSourceItemRef(
  repo: SourceItems,
  sourceInstanceId: string,
  ref: SourceItemRef,
  position: number,
): void {
  const existing = repo.findByFingerprint(sourceInstanceId, ref.fingerprint);
  if (existing !== undefined) return;
  const stableKey = computeStableKey(sourceInstanceId, ref.fingerprint);
  const input: Parameters<SourceItems['create']>[0] = {
    sourceInstanceId,
    fingerprint: ref.fingerprint,
    stableKey,
    itemKey: deriveItemKey(stableKey),
    stableShortId: deriveStableShortId(stableKey),
    contentKind: ref.contentKind,
    discoveredAt: ref.discoveredAt,
    sourcePosition: position,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (ref.externalId !== undefined) input.externalId = ref.externalId;
  if (ref.canonicalUrl !== undefined) input.canonicalUrl = ref.canonicalUrl;
  if (ref.originalUrl !== undefined) input.originalUrl = ref.originalUrl;
  if (ref.title !== undefined) input.title = ref.title;
  repo.create(input);
}

interface ProcessOneItemInput {
  ref: SourceItemRef;
  db: DB;
  sourceAdapter: SourceAdapter;
  targetAdapter: TargetAdapter;
  targetContext: TargetContext;
  sourceInstanceId: string;
  sourceItemsRepo: SourceItems;
  targetArtifacts: TargetArtifacts;
  attempts: MigrationAttempts;
  jobId: string;
  targetInstanceId: string;
  workspaceDir: string;
  retryPolicy: import('./retry.js').RetryPolicy;
}

async function processOneItem(
  i: ProcessOneItemInput,
): Promise<ItemFinalState> {
  const now = () => new Date().toISOString();
  const existingItem = i.sourceItemsRepo.findByFingerprint(
    i.sourceInstanceId,
    i.ref.fingerprint,
  );

  // §17.2 幂等：已 verified 的条目直接跳过（断点续跑场景）
  if (existingItem !== undefined && existingItem.status === 'verified') {
    return 'verified';
  }

  // §16.7 创建 migration_attempts 记录
  const attemptInput: Parameters<MigrationAttempts['createItem']>[0] = {
    migrationJobId: i.jobId,
    sourceItemId: existingItem?.id ?? 0,
    stage: 'extracting',
    actionCode: 'stage_attempt',
    attemptNo: 1,
    startedAt: now(),
    createdAt: now(),
  };
  // 如果 existingItem.id 是 undefined（尚未持久化），用 fallback
  // 实际上 persistSourceItemRef 在 scan 阶段已经创建了行，
  // 所以 existingItem 应该总是存在
  let attemptId: number | undefined;

  try {
    // §18.1/§18.2 retry-wrapped extract
    const item = await withRetry(
      () =>
        i.sourceAdapter.extract(i.ref, {
          config: {},
          workspaceDir: i.workspaceDir,
        }),
      i.retryPolicy,
    );

    // §17.5 质量升级检测
    const upgradeInput: Parameters<typeof isQualityUpgradeCandidate>[0] = {
      newQuality: item.quality,
      newDegradations: item.degradations,
    };
    if (
      existingItem?.quality === 'degraded' ||
      existingItem?.quality === 'full'
    ) {
      upgradeInput.previousQuality = existingItem.quality;
    }
    const isUpgrade = isQualityUpgradeCandidate(upgradeInput);
    // 质量升级候选已检测；actionCode 在 attempt 中会反映
    // 完整升级流程（target 重写 + verify + 状态提交）在后续 E2E 中验证

    // plan
    const plan = await i.targetAdapter.plan(item, i.targetContext);

    // write
    const writeResult = await i.targetAdapter.write(
      plan,
      i.targetContext,
    );

    // verify
    const verification = await i.targetAdapter.verify(
      writeResult,
      i.targetContext,
    );

    if (!verification.ok) {
      // verify 失败 → conflict（用户修改导致 hash 不匹配）
      if (existingItem?.id !== undefined) {
        // 记录失败的 attempt
        i.attempts.createItem({
          migrationJobId: i.jobId,
          sourceItemId: existingItem.id,
          stage: 'verifying_target',
          actionCode: isUpgrade ? 'quality_upgrade' : 'stage_attempt',
          attemptNo: 1,
          startedAt: now(),
          createdAt: now(),
        });
      }
      return 'conflict';
    }

    // §16.7 + §16.6 + §11.5 三步写入封装在事务中，确保幂等原子性
    const finalState: ItemFinalState =
      item.quality === 'full' ? 'verified' : 'degraded';

    const commitTxn = i.db.transaction(() => {
      // 1. 记录成功的 migration_attempt（createItem 返回 id）
      if (existingItem?.id !== undefined) {
        const attemptId = i.attempts.createItem({
          migrationJobId: i.jobId,
          sourceItemId: existingItem.id,
          stage: 'verifying_target',
          actionCode: isUpgrade ? 'quality_upgrade' : 'stage_attempt',
          attemptNo: 1,
          startedAt: now(),
          createdAt: now(),
        });
        i.attempts.finishAttempt(attemptId, {
          success: true,
          finishedAt: now(),
        });
      }

      // 2. 创建 target_artifacts
      const artifactInput: Parameters<TargetArtifacts['create']>[0] = {
        migrationJobId: i.jobId,
        artifactKind: plan.artifactKind,
        targetInstanceId: i.targetInstanceId,
        relativePath: writeResult.relativePath,
        status: 'verified',
        verifiedAt: now(),
        createdAt: now(),
        updatedAt: now(),
      };
      if (existingItem?.id !== undefined) {
        artifactInput.sourceItemId = existingItem.id;
      }
      if ('targetContentHash' in writeResult) {
        artifactInput.targetContentHash = (
          writeResult as { targetContentHash: string }
        ).targetContentHash;
      }
      artifactInput.writtenFileHash = writeResult.writtenFileHash;
      i.targetArtifacts.create(artifactInput);

      // 3. 更新 source_items 状态为 verified/degraded
      if (existingItem !== undefined) {
        i.sourceItemsRepo.updateCommittedResult(existingItem.id, {
          status: finalState,
          quality: item.quality,
          degradationsJson: JSON.stringify(item.degradations),
          updatedAt: now(),
        });
      }
    });
    commitTxn();

    return finalState;
  } catch (e) {
    // §11.5 + §20.2 错误处置：单条失败不中断整个 Job
    const err = e as {
      retryable?: boolean;
      itemDisposition?: string;
      code?: string;
      message?: string;
    };

    const errMsg = err.message?.substring(0, 200) ?? 'unknown error';
    const errCode = err.code ?? 'UNKNOWN';

    // 诊断日志
    console.warn(
      `[job ${i.jobId}] 条目处理失败: ${errCode} - ${errMsg}`,
    );

    // 持久化失败的 migration_attempt（完成生命周期闭环）
    if (existingItem?.id !== undefined) {
      try {
        const attemptId = i.attempts.createItem({
          migrationJobId: i.jobId,
          sourceItemId: existingItem.id,
          stage: 'extracting',
          actionCode: 'stage_attempt',
          attemptNo: 1,
          startedAt: now(),
          createdAt: now(),
        });
        i.attempts.finishAttempt(attemptId, {
          success: false,
          finishedAt: now(),
          errorCode: errCode,
          errorMessage: errMsg,
        });
      } catch {
        // 持久化失败不应影响错误分类
      }
    }

    // 显式 itemDisposition 优先
    const disposition = err.itemDisposition;
    if (disposition === 'unsupported') return 'unsupported';
    if (disposition === 'blocked') return 'blocked';
    // 导航超时、网络错误等临时性故障也标记为 permanent_failed，
    // 这样 resume 时会跳过（不会卡在同一条上反复超时）
    return 'permanent_failed';
  }
}
