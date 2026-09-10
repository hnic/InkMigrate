import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORTS_DIR_NAME, REPORT_FILENAME, errorMessage } from '../util.js';

/**
 * Job ID 白名单：字母数字开头，允许 `.` `_` `-`，但不能以 `.` 结尾——
 * Windows 解析路径时会剥离段尾的点，`a.` 会静默读到 `a` 的报告。
 * 字符集允许连续点，`..` 仍需显式排除。
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

export function createReportCommand(): Command {
  return new Command('report')
    .description('显示迁移报告')
    .requiredOption('--job <id>', 'Job ID')
    .option('--reports-dir <path>', '报告目录', REPORTS_DIR_NAME)
    .action((opts: { job: string; reportsDir: string }) => {
      // Job ID 会拼进文件路径，先校验格式，防止 `..` 等片段逃逸报告目录
      if (!JOB_ID_PATTERN.test(opts.job) || opts.job.includes('..')) {
        console.error(`非法的 Job ID：${opts.job}`);
        process.exitCode = 1;
        return;
      }
      const summaryPath = join(opts.reportsDir, opts.job, REPORT_FILENAME);
      let content: string;
      try {
        content = readFileSync(summaryPath, 'utf8');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const detail = errorMessage(e);
        console.error(
          code === 'ENOENT'
            ? `未找到报告：${summaryPath}`
            : `读取报告失败：${summaryPath}：${detail}`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(content);
    });
}
