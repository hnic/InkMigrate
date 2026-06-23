import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createReportCommand(): Command {
  return new Command('report')
    .description('显示迁移报告')
    .requiredOption('--job <id>', 'Job ID')
    .option('--reports-dir <path>', '报告目录', 'reports')
    .action((opts: { job: string; reportsDir: string }) => {
      const summaryPath = join(opts.reportsDir, opts.job, 'summary.md');
      if (!existsSync(summaryPath)) {
        console.error(`未找到报告：${summaryPath}`);
        process.exit(1);
      }
      console.log(readFileSync(summaryPath, 'utf8'));
    });
}
