import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function createReportCommand(): Command {
  return new Command('report')
    .description('显示迁移报告')
    .requiredOption('--job <id>', 'Job ID')
    .option('--reports-dir <path>', '报告目录', 'reports')
    .action((opts: { job: string; reportsDir: string }) => {
      // Job ID 会拼进文件路径，先校验格式，防止 `..` 等片段逃逸报告目录
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.job) || opts.job.includes('..')) {
        console.error(`非法的 Job ID：${opts.job}`);
        process.exitCode = 1;
        return;
      }
      const summaryPath = join(opts.reportsDir, opts.job, 'summary.md');
      let content: string;
      try {
        content = readFileSync(summaryPath, 'utf8');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        console.error(
          code === 'ENOENT'
            ? `未找到报告：${summaryPath}`
            : `读取报告失败：${summaryPath}：${e instanceof Error ? e.message : String(e)}`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(content);
    });
}
