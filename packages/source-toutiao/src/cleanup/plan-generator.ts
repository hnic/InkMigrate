import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeCsv } from '@inkmigrate/core';

export interface CleanupCandidate {
  sourceItemId: number;
  externalId?: string;
  canonicalUrl?: string;
  title: string;
}

export interface ExcludedItem {
  sourceItemId: number;
  reason: string;
}

export interface PlanInput {
  reportsDir: string;
  sourceInstanceId: string;
  migrationJobId: string;
  action: string;
  candidates: readonly CleanupCandidate[];
  excluded: readonly ExcludedItem[];
  databaseSnapshotVersion: number;
  configHash: string;
}

export interface PlanResult {
  planId: string;
  planHash: string;
  candidateCount: number;
  excludedCount: number;
}

/** §14.5 生成不可变清理计划。 */
export function generateCleanupPlan(i: PlanInput): PlanResult {
  const planId = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = new Date().toISOString();
  const hashInput = JSON.stringify({
    planId, sourceInstanceId: i.sourceInstanceId, migrationJobId: i.migrationJobId,
    action: i.action, candidates: i.candidates, excluded: i.excluded,
    databaseSnapshotVersion: i.databaseSnapshotVersion, configHash: i.configHash,
  });
  const planHash = `sha256:${createHash('sha256').update(hashInput).digest('hex')}`;
  const cleanupDir = join(i.reportsDir, 'cleanup');
  mkdirSync(cleanupDir, { recursive: true });

  const planJson = {
    planId, sourceInstanceId: i.sourceInstanceId, migrationJobId: i.migrationJobId,
    action: i.action, createdAt, candidateCount: i.candidates.length,
    excludedCount: i.excluded.length, databaseSnapshotVersion: i.databaseSnapshotVersion,
    planHash, configHash: i.configHash, items: i.candidates,
  };
  writeFileSync(join(cleanupDir, `unfavorite-plan-${planId}.json`), JSON.stringify(planJson, null, 2) + '\n', 'utf8');
  writeCsv(join(cleanupDir, `unfavorite-plan-${planId}.csv`), i.candidates as unknown as Record<string, unknown>[]);

  const md = [
    `# 清理计划 ${planId}`, '', `- 来源：${i.sourceInstanceId}`, `- Migration Job：${i.migrationJobId}`,
    `- 动作：${i.action}`, `- 候选数：${i.candidates.length}`, `- 排除数：${i.excluded.length}`,
    `- 计划哈希：${planHash}`, `- 配置哈希：${i.configHash}`, '',
  ].join('\n');
  writeFileSync(join(cleanupDir, `unfavorite-plan-${planId}.md`), md, 'utf8');

  return { planId, planHash, candidateCount: i.candidates.length, excludedCount: i.excluded.length };
}
