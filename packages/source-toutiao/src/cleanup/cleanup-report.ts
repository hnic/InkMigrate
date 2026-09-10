import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeCsv,
  ACTION_STATUS_UNFAVORITED,
  ACTION_STATUS_ALREADY_UNFAVORITED,
  ACTION_STATUS_VERIFICATION_FAILED,
  ACTION_STATUS_PERMANENT_FAILED,
} from '@inkmigrate/core';

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
  try {
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

    /** 按状态筛选报告条目（writeCsv 泛型直接接受 CleanupReportItem，无需 cast）。 */
    const pick = (statuses: readonly string[]): readonly CleanupReportItem[] =>
      i.items.filter((it) => statuses.includes(it.actionStatus));
    // 状态口径与编排器 attemptOnce 落库的 actionStatus 一致：
    // - 未知是 state_unknown（此前误写 action_result_unknown——运行时从不产生该值，
    //   导致 unknown.csv 恒为空、未知项全部漏进 skipped.csv，与 summary 计数矛盾）；
    // - 登录墙/风控挑战受控中断的条目（login_required/challenge_required）单列
    //   paused.csv，保证每个已处理条目恰好出现在一个 CSV，行数能对上 processed_count。
    // 注：state_unknown/skipped/login_required/challenge_required 在 core 尚无常量
    //（schema CLEANUP_ITEM_ACTION_STATUSES 未导出为常量集），保持字面量并需与
    // 编排器落库口径同步；unfavorited/already/verification/permanent 已有常量，必须引用。
    const success = pick([ACTION_STATUS_UNFAVORITED]);
    const failed = pick([ACTION_STATUS_PERMANENT_FAILED, ACTION_STATUS_VERIFICATION_FAILED]);
    const unknown = pick(['state_unknown']);
    const skipped = pick([ACTION_STATUS_ALREADY_UNFAVORITED, 'skipped']);
    const paused = pick(['login_required', 'challenge_required']);
    // 分桶完整性校验：桶并集必须覆盖全部条目。任何未覆盖的 actionStatus
    //（新增状态 / 拼写漂移）此前会被静默丢出所有 CSV 且无信号——与
    // unknown.csv 历史 bug 同类失败模式，改为响亮失败。
    const pickedCount = success.length + failed.length + unknown.length + skipped.length + paused.length;
    if (pickedCount !== i.items.length) {
      throw new Error(
        `报告分桶不完整：items=${i.items.length}，分桶合计=${pickedCount}，` +
          `存在未覆盖的 actionStatus（桶定义与编排器落库口径不一致）`,
      );
    }
    writeCsv(join(dir, 'success.csv'), success);
    writeCsv(join(dir, 'failed.csv'), failed);
    writeCsv(join(dir, 'unknown.csv'), unknown);
    writeCsv(join(dir, 'skipped.csv'), skipped);
    writeCsv(join(dir, 'paused.csv'), paused);
  } catch (e) {
    // 调用方在 job 已落库后写报告；fs 失败需带上目录上下文重抛，
    // 否则部分写入的报告目录无从定位。cause 保留原始错误的类型（EACCES/ENOSPC 等）与堆栈
    throw new Error(
      `清理报告写入失败（目录 ${dir}）：${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}
