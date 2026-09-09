import { createHash, randomUUID } from 'node:crypto';
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
  // planId 用 crypto 随机后缀：Math.random 的 4 位 base36 仅 ~168 万取值，
  // 同毫秒并发生成会碰撞并静默覆盖此前的审计文件。
  const planId = `cleanup-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  // planHash 只覆盖 内容 + 元数据（不含 planId/createdAt），同输入可复算，
  // 满足"不可变计划"的可验证性；planId 只用于文件名，不参与哈希。
  const hashInput = JSON.stringify({
    sourceInstanceId: i.sourceInstanceId, migrationJobId: i.migrationJobId,
    action: i.action, candidates: i.candidates, excluded: i.excluded,
    databaseSnapshotVersion: i.databaseSnapshotVersion, configHash: i.configHash,
  });
  const planHash = `sha256:${createHash('sha256').update(hashInput).digest('hex')}`;
  const cleanupDir = join(i.reportsDir, 'cleanup');
  // 文件名从 action 派生（清洗非法字符），避免将来新增动作时报告仍标 unfavorite
  const actionSlug = i.action.replace(/[^a-zA-Z0-9-]/g, '_') || 'action';
  try {
    mkdirSync(cleanupDir, { recursive: true });

    const planJson = {
      planId, sourceInstanceId: i.sourceInstanceId, migrationJobId: i.migrationJobId,
      action: i.action, createdAt, candidateCount: i.candidates.length,
      excludedCount: i.excluded.length, databaseSnapshotVersion: i.databaseSnapshotVersion,
      planHash, configHash: i.configHash, items: i.candidates,
      // excluded 完整落地：planHash 覆盖该字段，且排除原因是审计追溯的关键证据
      excluded: i.excluded,
    };
    writeFileSync(join(cleanupDir, `${actionSlug}-plan-${planId}.json`), JSON.stringify(planJson, null, 2) + '\n', 'utf8');
    // 映射为普通对象再写 CSV，让编译器持续检查列结构（writeCsv 自身做 null 安全序列化）
    const csvRows = i.candidates.map((c) => ({
      sourceItemId: c.sourceItemId,
      externalId: c.externalId ?? '',
      canonicalUrl: c.canonicalUrl ?? '',
      title: c.title,
    }));
    writeCsv(join(cleanupDir, `${actionSlug}-plan-${planId}.csv`), csvRows);

    const md = [
      `# 清理计划 ${planId}`, '', `- 来源：${i.sourceInstanceId}`, `- Migration Job：${i.migrationJobId}`,
      `- 动作：${i.action}`, `- 候选数：${i.candidates.length}`, `- 排除数：${i.excluded.length}`,
      `- 计划哈希：${planHash}`, `- 配置哈希：${i.configHash}`, '',
    ].join('\n');
    writeFileSync(join(cleanupDir, `${actionSlug}-plan-${planId}.md`), md, 'utf8');
  } catch (err) {
    // 部分写入（JSON 有而 CSV/MD 缺）的目录会被审计步骤误当完整计划，
    // 失败必须带 planId/目录上下文重抛
    throw new Error(
      `生成清理计划报告失败 (planId=${planId}, dir=${cleanupDir}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { planId, planHash, candidateCount: i.candidates.length, excludedCount: i.excluded.length };
}
