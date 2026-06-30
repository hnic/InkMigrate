import type { DB } from '../storage/database.js';
import type {
  SourceAdapter,
  TargetAdapter,
  TargetContext,
  IndexEntryInput,
} from '../adapters/adapter.js';
import type { SourceItemRef } from '../domain/models.js';
import type { ItemFinalState, ItemRecoverableState, FinalStateCounts } from '../domain/states.js';
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
import { withJitter, ITEM_INTERVAL_JITTER } from './jitter.js';
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
   * §18.1 条目间基准等待毫秒（叠加 ±40% 抖动，防风控）。默认 1500。
   * 作为 JobRunnerInput 的一级字段而非塞进 targetContext.config bag——后者是
   * Record<string,unknown>，强转读取无类型保障、易踩坑。CLI/engine 显式传入。
   */
  intervalMs?: number;
  /**
   * 进度回调（可选）。在扫描完成、每条提取完成时触发。
   * 用于 GUI/CLI 实时显示进度。
   */
  onProgress?: (progress: JobProgress) => void;
  /**
   * 取消检查回调（可选）。循环每轮迭代检查；返回 true 时优雅中断，
   * 走与 SIGINT 相同的中断收尾路径（剩余条目标记 skipped，status='interrupted'）。
   * 用于 GUI 的"终止"按钮（cancel.cancel RPC 设置进程级 flag）。
   */
  isCancelled?: () => boolean;
  /**
   * 日志回调（可选）。用于把 job-runner 内部的诊断信息（限流、条目失败、降级等）
   * 转发到 GUI 日志面板。不传时回退到 console.warn（CLI 场景）。
   */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
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
  /** 当前 Job 阶段（preflight/scanning/planning/extracting/reporting）。 */
  stage?: string;
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
  status: 'completed' | 'failed' | 'interrupted' | 'paused';
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

  // 日志：优先走 onLog 回调（GUI 日志面板可见），无回调时回退 console.warn（CLI 场景）
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    const prefixed = `[job ${i.jobId}] ${message}`;
    if (i.onLog !== undefined) {
      i.onLog(level, prefixed);
    } else {
      console.warn(prefixed);
    }
  };

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
      // 第二次中断：立即退出。finally 不会执行，故此处同步释放锁，
      // 否则锁文件心跳时间戳可能仍很新（默认 1s 刷新），下次启动 isStaleLock
      //（60s 阈值）会判定非陈旧而抛 LockConflictError，锁被永久卡住。
      lock.release();
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
    if (i.onProgress !== undefined) {
      i.onProgress({ phase: 'scanning', jobId: i.jobId, current: 0, total: 0, stage: 'scanning' });
    }
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

    // 通知前端进入迁移阶段
    if (i.onProgress !== undefined) {
      i.onProgress({ phase: 'migrating', jobId: i.jobId, current: 0, total: refs.length, stage: 'extracting' });
    }

    // 逐条 extract → write → verify
    // §18.1 条目间速率控制：默认每条之间等待 1500ms，避免触发风控
    // §18.2 限流（429/503）时 Job 进入 paused
    // intervalMs 优先读 JobRunnerInput 一级字段（类型化契约）；历史调用方若仍
    // 塞进 targetContext.config bag 则回退读取，保持向后兼容。
    const configRecord = i.targetContext.config as Record<string, unknown>;
    const intervalMs =
      i.intervalMs ?? (configRecord['intervalMs'] as number | undefined) ?? 1500;
    // itemStates 同时持有完成终态（ItemFinalState，进等式）与可恢复态
    // （interrupted/retryable_failed，不进等式，仅用于 recoverableCount 统计）。
    // 规格 §11.1：限流未处理条目归 interrupted（可恢复），不另设终态。
    const itemStates: (ItemFinalState | ItemRecoverableState)[] = [];
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
    let rateLimited = false;
    try {
    for (let idx = 0; idx < refs.length; idx++) {
      const ref = refs[idx]!;
      // §18.3 检查中断标志——完成当前条目后停止
      // SIGINT（CLI Ctrl+C）或 cancel.cancel RPC（GUI 终止按钮）都会触发
      if (interrupted || i.isCancelled?.()) break;

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
        ...(i.onLog !== undefined ? { onLog: i.onLog } : {}),
      }).catch((e): ItemFinalState => {
        // §18.2 限流检测：processOneItem 抛出 __rateLimited 时 Job 进入 paused
        const rlErr = e as { __rateLimited?: boolean; httpStatus?: number };
        if (rlErr.__rateLimited === true) {
          log('warn', `限流检测 (${rlErr.httpStatus})，Job 进入 paused`);
          throw e; // 向上传播到 runMigrationJob 的 try 块
        }
        // 契约上 processOneItem 内部 catch 已返回 ItemFinalState，不应走到这里。
        // 若到达此分支，说明 processOneItem 的错误契约被违反（开始抛出未被内部
        // catch 覆盖的非限流错误）。用 error 级别记录让该"不该发生"的路径可见，
        // 便于诊断；归为 permanent_failed 保证 resume 时跳过、不卡在同一条。
        log('error', `processOneItem 未被内部 catch 覆盖的错误（归为 permanent_failed）：${(e as Error).message ?? e}`);
        return 'permanent_failed';
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

      // §18.1 最后一条不需要等待；条目间等待叠加抖动（±40%，落在 [0.6×, 1.4×]），
      // 避免固定间隔被风控识别为自动化
      if (idx < refs.length - 1 && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, withJitter(intervalMs, ITEM_INTERVAL_JITTER)));
      }
    }
    } catch (e) {
      // §18.2 捕获限流信号
      const rlErr = e as { __rateLimited?: boolean };
      if (rlErr.__rateLimited === true) {
        rateLimited = true;
      } else {
        throw e; // 非限流错误继续向上传播
      }
    }

    // §18.2 如果被限流，把 Job 标记为 paused 并返回
    if (rateLimited) {
      jobs.updateStatus(i.jobId, {
        status: 'paused',
        currentStage: 'extracting',
        pauseReasonCode: 'rate_limited',
        pausedAt: now(),
        updatedAt: now(),
      });
      // §13 限流未处理条目标记为可恢复态 interrupted（规格 §11.1：rate_limited 是 Job 级
      // paused 的 pause_reason，非条目终态；未处理条目归 interrupted，completed 前须为 0，
      // 断点续跑可恢复，且与用户主动 skipped 区分）。
      const processed = itemStates.length;
      for (let idx = processed; idx < refs.length; idx++) {
        itemStates.push('interrupted');
      }
      return {
        status: 'paused',
        scanCount: refs.length,
        finalStateCounts: deriveFinalStateCounts(itemStates) as unknown as Record<string, number>,
        reconciliationOk: false,
        reconciliationReason: 'rate_limited',
      };
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

    // §13.8 索引生成阶段（generating_indexes）：仅当 Job 未被限流/中断时执行。
    // 索引是 Job 级 artifact（artifact_kind='index'），非关键路径——失败不影响迁移状态。
    // 仅在目标适配器实现 renderIndex 时执行。
    if (!rateLimited && !interrupted && i.targetAdapter.renderIndex !== undefined) {
      try {
        jobs.updateStatus(i.jobId, {
          status: 'running',
          currentStage: 'generating_indexes',
          updatedAt: now(),
        });
        // 收集 verified 笔记条目（含来源元数据），构造 indexEntries
        const verifiedRows = targetArtifacts.listVerifiedNotesForIndex(
          i.jobId,
          i.sourceInstanceId,
        );
        const indexEntries: IndexEntryInput[] = verifiedRows.map((r) => {
          let meta: Record<string, unknown> = {};
          try {
            meta = JSON.parse(r.sourceMetadataJson) as Record<string, unknown>;
          } catch {
            meta = {};
          }
          const collections = Array.isArray(meta.displayCollection)
            ? (meta.displayCollection as string[])
            : typeof meta.displayCollection === 'string'
              ? [meta.displayCollection as string]
              : [];
          const entry: IndexEntryInput = {
            title: r.title ?? '(无标题)',
            relativePath: r.relativePath,
            contentKind: r.contentKind,
            collections,
          };
          return entry;
        });
        // §13.8 重跑保护：传入上一轮已落库的 index artifact 哈希
        const knownIndexArtifacts = targetArtifacts
          .listIndexArtifacts(i.jobId)
          .filter((a): a is { relativePath: string; writtenFileHash: string } => a.writtenFileHash !== undefined);
        // 索引目录的路径段必须与笔记实际写入路径一致（<importSubdir>/<seg>/_索引/）。
        // 笔记路径由 ref.sourceInstanceId 决定，可能与 i.sourceInstanceId（DB 键）不同，
        // 故从第一条笔记的 relativePath 反解路径段，避免索引目录与笔记分目录错配。
        const importSubdir = (i.targetContext.targetConfig as { importSubdir?: string }).importSubdir ?? 'Imports/InkMigrate';
        const pathSeg = indexEntries.length > 0
          ? indexEntries[0]!.relativePath.replace(`${importSubdir}/`, '').split('/')[0] ?? i.sourceInstanceId
          : i.sourceInstanceId;
        const indexCtx: TargetContext = {
          ...targetContextWithJobId,
          sourceInstanceId: pathSeg,
          indexEntries,
          ...(knownIndexArtifacts.length > 0 ? { knownIndexArtifacts } : {}),
        };
        const indexResults = await i.targetAdapter.renderIndex(indexCtx);
        // 落库为 artifact_kind='index'（job 级，sourceItemId 留空）
        const idxTs = now();
        for (const r of indexResults) {
          targetArtifacts.create({
            migrationJobId: i.jobId,
            artifactKind: 'index',
            targetInstanceId: i.targetInstanceId,
            relativePath: r.relativePath,
            targetContentHash: r.targetContentHash,
            writtenFileHash: r.writtenFileHash,
            status: 'verified',
            verifiedAt: idxTs,
            createdAt: idxTs,
            updatedAt: idxTs,
          });
        }
      } catch (e) {
        // 索引生成失败不阻断迁移（索引非发布门槛）
        log('warn', `索引生成失败（不影响迁移结果）：${(e as Error).message ?? e}`);
      }
    }

    // reporting
    if (i.onProgress !== undefined) {
      i.onProgress({ phase: 'migrating', jobId: i.jobId, current: refs.length, total: refs.length, stage: 'reporting', currentItem: '生成报告中...' });
    }
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'reporting',
      updatedAt: now(),
    });

    const jobRow = jobs.get(i.jobId);
    // §11.9 recoverableCount 从 itemStates 统计（retryable_failed / interrupted 可恢复）
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
  /** 日志回调（可选），把条目级诊断（失败/降级/冲突）转发到调用方。 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

async function processOneItem(
  i: ProcessOneItemInput,
): Promise<ItemFinalState> {
  const now = () => new Date().toISOString();
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    const prefixed = `[job ${i.jobId}] ${message}`;
    if (i.onLog !== undefined) i.onLog(level, prefixed);
    else console.warn(prefixed);
  };
  const existingItem = i.sourceItemsRepo.findByFingerprint(
    i.sourceInstanceId,
    i.ref.fingerprint,
  );

  // §17.2 幂等：已 verified 的条目直接跳过（断点续跑场景）
  if (existingItem !== undefined && existingItem.status === 'verified') {
    return 'verified';
  }

  try {
    // §18.1/§18.2 retry-wrapped extract
    // migration_attempts 记录在下方成功/失败分支内联创建（携带准确的 stage/actionCode）。
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

    // §13.9 查询上次成功写入的 expectedWrittenFileHash（用于 conflict 检测）
    let expectedWrittenFileHash: string | undefined;
    if (existingItem?.id !== undefined) {
      const prevArtifact = i.targetArtifacts.findBySourceItem(existingItem.id);
      if (prevArtifact !== undefined && prevArtifact.status === 'verified') {
        expectedWrittenFileHash = prevArtifact.writtenFileHash;
      }
    }

    // write（支持 writeWithExpectedHash 的适配器用它做 conflict 检测）
    const writeResult = i.targetAdapter.writeWithExpectedHash !== undefined
      ? await i.targetAdapter.writeWithExpectedHash(plan, i.targetContext, expectedWrittenFileHash)
      : await i.targetAdapter.write(plan, i.targetContext);

    // verify
    const verification = await i.targetAdapter.verify(
      writeResult,
      i.targetContext,
    );

    if (!verification.ok) {
      // verify 失败 → conflict（用户修改导致 hash 不匹配）
      if (existingItem?.id !== undefined) {
        // 记录失败的 attempt 并闭环（finishAttempt 标记结束）
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
          success: false,
          finishedAt: now(),
          errorCode: 'VERIFICATION_FAILED',
          errorMessage: 'verification failed (possible user-modified mismatch)',
        });
      }
      return 'conflict';
    }

    // §16.7 + §16.6 + §11.5 三步写入封装在事务中，确保幂等原子性
    const finalState: ItemFinalState =
      item.quality === 'full' ? 'verified' : 'degraded';
    if (finalState === 'degraded') {
      // 内容质量降级：用户应知道部分内容不完整（如图片缺失、正文残缺）
      log('warn', `内容质量降级（非完整提取）：${i.ref.title?.substring(0, 40) ?? '(无标题)'}`);
    }

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

      // 3. 更新 source_items 状态为 verified/degraded + source_content_hash
      if (existingItem !== undefined) {
        const updateInput: Parameters<SourceItems['updateCommittedResult']>[1] = {
          status: finalState,
          quality: item.quality,
          degradationsJson: JSON.stringify(item.degradations),
          updatedAt: now(),
        };
        // §16.4 持久化 source_content_hash（plan 计算的标准化正文哈希）
        if (plan.sourceContentHash !== undefined) {
          updateInput.sourceContentHash = plan.sourceContentHash;
        }
        i.sourceItemsRepo.updateCommittedResult(existingItem.id, updateInput);
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

    // 诊断日志：条目失败（限流/降级/冲突等），转发到调用方日志面板
    log('warn', `条目处理失败: ${errCode} - ${errMsg}`);

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

    // §13.9 / H1 跨 Job 并发路径冲突：target_artifacts 的 UNIQUE(target_instance_id,
    // relative_path) 约束被触发——另一并发 Job 已占用该路径。归为 conflict
    //（与用户修改导致的冲突同语义：保护已有数据，不静默覆盖），交由续跑/人工处理。
    // better-sqlite3 在违反唯一约束时 errCode 形如 'SQLITE_CONSTRAINT_UNIQUE'。
    if (typeof err.code === 'string' && err.code.includes('CONSTRAINT')) {
      log('warn', `路径并发冲突（UNIQUE 约束），标记为 conflict：${errMsg}`);
      return 'conflict';
    }

    // §18.2 检测限流信号（429/503），向上抛出以触发 Job paused
    const httpStatus = (e as { httpStatus?: number }).httpStatus;
    if (httpStatus === 429 || httpStatus === 503) {
      throw { __rateLimited: true, httpStatus, message: errMsg };
    }

    // 导航超时、网络错误等临时性故障也标记为 permanent_failed，
    // 这样 resume 时会跳过（不会卡在同一条上反复超时）
    return 'permanent_failed';
  }
}
