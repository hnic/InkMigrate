import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCsv } from './csv-writer.js';
import { aggregateFailedCount, type FinalStateCounts } from '../domain/states.js';

export interface ReportItemRow {
  fingerprint: string;
  title: string;
  status: string;
  contentKind: string;
}

/** §15.10 未解析内部链接明细（来源笔记 / 链接文字 / 目标 URI）。 */
export interface UnresolvedLinkRow {
  note: string;
  text: string;
  url: string;
}

export interface ReportInput {
  reportsDir: string;
  jobId: string;
  scanCount: number;
  candidateCount: number;
  counts: FinalStateCounts;
  items: readonly ReportItemRow[];
  reconciliationOk: boolean;
  reconciliationReason?: string;
  /** §15.10：非空时输出 unresolved-links.csv。 */
  unresolvedLinks?: readonly UnresolvedLinkRow[];
}

/**
 * §21.2 生成迁移报告。
 *
 * 输出 summary.json / summary.md + items.csv / failed-items.csv /
 * degraded-items.csv / conflicts.csv（+ §15.10 unresolved-links.csv，如有）。
 *
 * failed_count = permanent_failed + unsupported + blocked（§11.9）。
 */
export function generateMigrationReport(i: ReportInput): void {
  const jobDir = join(i.reportsDir, i.jobId);
  mkdirSync(jobDir, { recursive: true });

  const failedCount = aggregateFailedCount(i.counts);

  // summary.json
  const summary: Record<string, unknown> = {
    job_id: i.jobId,
    scan_count: i.scanCount,
    candidate_count: i.candidateCount,
    verified_count: i.counts.verified,
    degraded_count: i.counts.degraded,
    failed_count: failedCount,
    permanent_failed_count: i.counts.permanent_failed,
    unsupported_count: i.counts.unsupported,
    blocked_count: i.counts.blocked,
    conflict_count: i.counts.conflict,
    skipped_count: i.counts.skipped,
    reconciliation_ok: i.reconciliationOk,
  };
  if (i.reconciliationReason !== undefined) {
    summary.reconciliation_reason = i.reconciliationReason;
  }
  writeFileSync(
    join(jobDir, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
    'utf8',
  );

  // summary.md
  const md = [
    `# 迁移报告 ${i.jobId}`,
    '',
    '## 计数',
    '',
    `| 状态 | 数量 |`,
    `|---|---|`,
    `| scan_count | ${i.scanCount} |`,
    `| candidate_count | ${i.candidateCount} |`,
    `| verified | ${i.counts.verified} |`,
    `| degraded | ${i.counts.degraded} |`,
    `| failed (合计) | ${failedCount} |`,
    `|   permanent_failed | ${i.counts.permanent_failed} |`,
    `|   unsupported | ${i.counts.unsupported} |`,
    `|   blocked | ${i.counts.blocked} |`,
    `| conflict | ${i.counts.conflict} |`,
    `| skipped | ${i.counts.skipped} |`,
    '',
    '## 对账',
    '',
    i.reconciliationOk
      ? '完整性方程成立，无悬挂状态。'
      : `对账失败：${i.reconciliationReason ?? '未知原因'}`,
    '',
  ].join('\n');
  writeFileSync(join(jobDir, 'summary.md'), md, 'utf8');

  // CSV 明细
  const failedStatuses = new Set([
    'permanent_failed',
    'unsupported',
    'blocked',
  ]);
  const itemsArr = i.items as unknown as Record<string, unknown>[];
  writeCsv(join(jobDir, 'items.csv'), itemsArr);
  writeCsv(
    join(jobDir, 'failed-items.csv'),
    itemsArr.filter((it) => failedStatuses.has(String(it['status']))),
  );
  writeCsv(
    join(jobDir, 'degraded-items.csv'),
    itemsArr.filter((it) => it['status'] === 'degraded'),
  );
  writeCsv(
    join(jobDir, 'conflicts.csv'),
    itemsArr.filter((it) => it['status'] === 'conflict'),
  );

  // §15.10 未解析内部链接（Evernote 等来源保留原链接时的对账明细）
  if (i.unresolvedLinks !== undefined && i.unresolvedLinks.length > 0) {
    writeCsv(
      join(jobDir, 'unresolved-links.csv'),
      i.unresolvedLinks as unknown as Record<string, unknown>[],
    );
  }
}
