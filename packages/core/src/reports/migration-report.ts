import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCsv } from './csv-writer.js';
import {
  aggregateFailedCount,
  FAILED_FINAL_STATES,
  type FinalStateCounts,
  type ItemFinalState,
} from '../domain/states.js';

export interface ReportItemRow {
  fingerprint: string;
  title: string;
  /** 保持 string：runtime 侧 itemStates 来自存储读取的宽类型 string[]。 */
  status: string;
  contentKind: string;
}

// 与 domain 词表建立编译期关联（satisfies）：状态字面量重命名时这里编译报错，
// 避免 degraded/conflicts.csv 的过滤条件静默失效产出空报表
const DEGRADED_STATE = 'degraded' satisfies ItemFinalState;
const CONFLICT_STATE = 'conflict' satisfies ItemFinalState;

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
  // jobId 会拼接进文件系统路径，拒绝含路径字符的输入（防穿越写报告）
  if (!/^[A-Za-z0-9_-]+$/.test(i.jobId)) {
    throw new Error(
      `invalid jobId (path characters rejected): ${JSON.stringify(i.jobId)}`,
    );
  }
  const jobDir = join(i.reportsDir, i.jobId);
  // 写序列失败时附上 jobId 与 artifact 名：本函数连写 7+ 个文件，裸 errno
  // 无法定位是哪个产物失败，且半套产物混入下次重跑会生成误导性审计报告
  const writeArtifact = (name: string, write: () => void): void => {
    try {
      write();
    } catch (err) {
      throw new Error(
        `failed to write report artifact ${name} for job ${i.jobId}: ${String(err)}`,
        { cause: err },
      );
    }
  };
  writeArtifact('dir', () => mkdirSync(jobDir, { recursive: true }));

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
  writeArtifact('summary.json', () =>
    writeFileSync(
      join(jobDir, 'summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
      'utf8',
    ),
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
  writeArtifact('summary.md', () =>
    writeFileSync(join(jobDir, 'summary.md'), md, 'utf8'),
  );

  // CSV 明细（failed 口径与 domain.aggregateFailedCount 同源，避免字面量漂移）
  const failedStatuses = new Set<string>(FAILED_FINAL_STATES);
  writeArtifact('items.csv', () => writeCsv(join(jobDir, 'items.csv'), i.items));
  writeArtifact('failed-items.csv', () =>
    writeCsv(
      join(jobDir, 'failed-items.csv'),
      i.items.filter((it) => failedStatuses.has(it.status)),
    ),
  );
  writeArtifact('degraded-items.csv', () =>
    writeCsv(
      join(jobDir, 'degraded-items.csv'),
      i.items.filter((it) => it.status === DEGRADED_STATE),
    ),
  );
  writeArtifact('conflicts.csv', () =>
    writeCsv(
      join(jobDir, 'conflicts.csv'),
      i.items.filter((it) => it.status === CONFLICT_STATE),
    ),
  );

  // §15.10 未解析内部链接（Evernote 等来源保留原链接时的对账明细）
  // 局部常量承接窄化：回调闭包内对参数属性的 !== undefined 判定不会延续
  const unresolved = i.unresolvedLinks;
  if (unresolved !== undefined && unresolved.length > 0) {
    writeArtifact('unresolved-links.csv', () =>
      writeCsv(join(jobDir, 'unresolved-links.csv'), unresolved),
    );
  }
}
