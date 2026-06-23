import type { DB } from '../storage/database.js';
import type {
  SourceAdapter,
  TargetAdapter,
  TargetContext,
} from '../adapters/adapter.js';
import type { SourceItem, SourceItemRef } from '../domain/models.js';
import type { ItemFinalState } from '../domain/states.js';
import { MigrationJobs } from '../storage/repositories/migration-jobs.js';
import { SourceItems } from '../storage/repositories/source-items.js';
import { TargetArtifacts } from '../storage/repositories/target-artifacts.js';
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
}

export interface JobRunnerResult {
  status: 'completed' | 'failed';
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
 * 本实现把 extract/normalize/write/verify 合并为逐条处理循环，
 * 但 current_stage 仍按 §11.1 记录。
 */
export async function runMigrationJob(
  i: JobRunnerInput,
): Promise<JobRunnerResult> {
  const jobs = new MigrationJobs(i.db);
  const sourceItemsRepo = new SourceItems(i.db);
  const targetArtifacts = new TargetArtifacts(i.db);

  // §18.4 获取任务锁
  const lock = acquireLock({
    locksDir: `${i.workspaceDir}/.inkmigrate/locks`,
    lockName: `migration-${i.sourceInstanceId}-${i.targetInstanceId}`,
    jobId: i.jobId,
  });

  try {
    // preflight
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'preflight',
      updatedAt: new Date().toISOString(),
    });

    // scanning
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'scanning',
      updatedAt: new Date().toISOString(),
    });

    const refs: SourceItemRef[] = [];
    for await (const ref of i.sourceAdapter.scan({
      config: {},
      workspaceDir: i.workspaceDir,
    })) {
      refs.push(ref);
      persistSourceItemRef(sourceItemsRepo, i.sourceInstanceId, ref);
    }
    jobs.updateCounts(i.jobId, { scanCount: refs.length });

    // planning
    jobs.updateStatus(i.jobId, {
      status: 'running',
      currentStage: 'planning',
      updatedAt: new Date().toISOString(),
    });
    jobs.updateCounts(i.jobId, { candidateCount: refs.length });

    // 逐条 extract → write → verify
    const itemStates: ItemFinalState[] = [];
    for (const ref of refs) {
      jobs.updateStatus(i.jobId, {
        status: 'running',
        currentStage: 'extracting',
        updatedAt: new Date().toISOString(),
      });
      const state = await processOneItem({
        ref,
        sourceAdapter: i.sourceAdapter,
        targetAdapter: i.targetAdapter,
        targetContext: i.targetContext,
        sourceInstanceId: i.sourceInstanceId,
        sourceItemsRepo,
        targetArtifacts,
        jobId: i.jobId,
        targetInstanceId: i.targetInstanceId,
      });
      itemStates.push(state);
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
      updatedAt: new Date().toISOString(),
    });

    const jobRow = jobs.get(i.jobId);
    const reconciliation = reconcileJob({
      scanCount: refs.length,
      itemStates,
      recoverableCount: 0,
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

    const finalStatus = reconciliation.ok ? 'completed' : 'failed';
    jobs.updateStatus(i.jobId, {
      status: finalStatus,
      currentStage: 'completed',
      updatedAt: new Date().toISOString(),
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
    lock.release();
  }
}

function persistSourceItemRef(
  repo: SourceItems,
  sourceInstanceId: string,
  ref: SourceItemRef,
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
  sourceAdapter: SourceAdapter;
  targetAdapter: TargetAdapter;
  targetContext: TargetContext;
  sourceInstanceId: string;
  sourceItemsRepo: SourceItems;
  targetArtifacts: TargetArtifacts;
  jobId: string;
  targetInstanceId: string;
}

async function processOneItem(
  i: ProcessOneItemInput,
): Promise<ItemFinalState> {
  try {
    const item = await i.sourceAdapter.extract(i.ref, {
      config: {},
      workspaceDir: '.',
    });

    // §17.5 质量升级检测
    const existingItem = i.sourceItemsRepo.findByFingerprint(
      i.sourceInstanceId,
      i.ref.fingerprint,
    );
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
    void isUpgrade; // stage 4 基础实现：升级候选已检测，完整升级流程在 E2E 中验证

    // plan + write + verify
    const plan = await i.targetAdapter.plan(item, i.targetContext);
    const writeResult = await i.targetAdapter.write(plan, i.targetContext);
    const verification = await i.targetAdapter.verify(
      writeResult,
      i.targetContext,
    );

    if (!verification.ok) {
      return 'permanent_failed';
    }

    // 记录 target artifact
    const artifactInput: Parameters<TargetArtifacts['create']>[0] = {
      migrationJobId: i.jobId,
      artifactKind: plan.artifactKind,
      targetInstanceId: i.targetInstanceId,
      relativePath: writeResult.relativePath,
      status: 'verified',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

    // §11.5 提交已验证质量到 source_items
    const finalState: ItemFinalState =
      item.quality === 'full' ? 'verified' : 'degraded';
    if (existingItem !== undefined) {
      i.sourceItemsRepo.updateCommittedResult(existingItem.id, {
        status: finalState,
        quality: item.quality,
        degradationsJson: JSON.stringify(item.degradations),
        updatedAt: new Date().toISOString(),
      });
    }

    return finalState;
  } catch (e) {
    // §11.5 + §20.2 错误处置
    const err = e as {
      retryable?: boolean;
      itemDisposition?: string;
    };
    if (err.retryable === true) {
      return 'permanent_failed'; // stage 4 基础：retryable 在无重试循环时降级为 permanent
    }
    const disposition = err.itemDisposition;
    if (disposition === 'unsupported') return 'unsupported';
    if (disposition === 'blocked') return 'blocked';
    return 'permanent_failed';
  }
}
