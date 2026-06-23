import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCsv } from '@inkmigrate/core';

export interface CleanupReportItem {
  sourceItemId: number;
  externalId?: string;
  title: string;
  preState: string;
  actionStatus: string;
  postState?: string;
  errorCode?: string;
}

export interface CleanupReportInput {
  reportsDir: string;
  cleanupJobId: string;
  planCount: number;
  processedCount: number;
  successCount: number;
  alreadyUnfavoritedCount: number;
  skippedCount: number;
  failedCount: number;
  unknownCount: number;
  loginPauseCount: number;
  items: readonly CleanupReportItem[];
}

/** §14.15 生成清理报告。 */
export function generateCleanupReport(i: CleanupReportInput): void {
  const dir = join(i.reportsDir, i.cleanupJobId);
  mkdirSync(dir, { recursive: true });

  const summary = {
    cleanup_job_id: i.cleanupJobId, plan_count: i.planCount, processed_count: i.processedCount,
    success_count: i.successCount, already_unfavorited_count: i.alreadyUnfavoritedCount,
    skipped_count: i.skippedCount, failed_count: i.failedCount, unknown_count: i.unknownCount,
    login_pause_count: i.loginPauseCount,
  };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const md = [
    `# 清理报告 ${i.cleanupJobId}`, '', '| 指标 | 数量 |', '|---|---|',
    `| 计划数 | ${i.planCount} |`, `| 处理数 | ${i.processedCount} |`,
    `| 成功 | ${i.successCount} |`, `| 原已取消 | ${i.alreadyUnfavoritedCount} |`,
    `| 跳过 | ${i.skippedCount} |`, `| 失败 | ${i.failedCount} |`,
    `| 未知 | ${i.unknownCount} |`, `| 登录暂停 | ${i.loginPauseCount} |`, '',
  ].join('\n');
  writeFileSync(join(dir, 'summary.md'), md, 'utf8');

  const arr = i.items as unknown as Record<string, unknown>[];
  writeCsv(join(dir, 'success.csv'), arr.filter((it) => it['actionStatus'] === 'unfavorited_verified'));
  writeCsv(join(dir, 'failed.csv'), arr.filter((it) => ['permanent_failed', 'verification_failed'].includes(String(it['actionStatus']))));
  writeCsv(join(dir, 'unknown.csv'), arr.filter((it) => it['actionStatus'] === 'action_result_unknown'));
  writeCsv(join(dir, 'skipped.csv'), arr.filter((it) => ['already_unfavorited', 'state_unknown', 'skipped'].includes(String(it['actionStatus']))));
}
