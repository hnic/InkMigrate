import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function createCleanupCommand(): Command {
  const cleanup = new Command('cleanup').description('源端清理：取消收藏');

  cleanup
    .command('status')
    .description('显示清理状态')
    .requiredOption('--source <id>', '来源实例 ID')
    .action((opts: { source: string }) => {
      console.log(`来源 ${opts.source} 的清理状态：v1.1 已启用取消收藏能力。`);
    });

  cleanup
    .command('plan')
    .description('生成不可变清理计划')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--action <action>', '清理动作（unfavorite）')
    .requiredOption('--migration-job <id>', '关联的 Migration Job ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option('--max-items <n>', '最大候选数', '100')
    .action((opts: { source: string; action: string; migrationJob: string; stateDir: string; maxItems: string }) => {
      console.log(`Stage 6 占位：将为来源 ${opts.source} 生成 ${opts.action} 清理计划。`);
      console.log(`  Migration Job: ${opts.migrationJob}`);
      console.log(`  State Dir: ${opts.stateDir}`);
      console.log(`  Max Items: ${opts.maxItems}`);
    });

  cleanup
    .command('unfavorite')
    .description('执行取消收藏清理计划')
    .requiredOption('--plan <id>', '清理计划 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option('--dry-run', '预演（不实际点击）')
    .option('--execute', '正式执行（需交互式确认）')
    .action((opts: { plan: string; stateDir: string; dryRun?: boolean; execute?: boolean }) => {
      if (!opts.dryRun && !opts.execute) {
        console.error('请指定 --dry-run 或 --execute。');
        process.exit(1);
      }
      if (opts.dryRun) {
        console.log(`Stage 6 占位：预演清理计划 ${opts.plan}（不实际点击）。`);
        return;
      }
      console.log(`Stage 6 占位：执行清理计划 ${opts.plan}。`);
      console.log('真实实现需要交互式终端输入确认短语 UNFAVORITE <count>。');
      console.log('不支持 --yes / --force / --no-confirm。');
    });

  cleanup
    .command('resume')
    .description('恢复中断的清理 Job')
    .requiredOption('--job <id>', '清理 Job ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { job: string; stateDir: string }) => {
      console.log(`Stage 6 占位：恢复清理 Job ${opts.job}。`);
    });

  cleanup
    .command('verify')
    .description('验证清理 Job 结果')
    .requiredOption('--job <id>', '清理 Job ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { job: string; stateDir: string }) => {
      console.log(`Stage 6 占位：验证清理 Job ${opts.job}。`);
    });

  cleanup
    .command('report')
    .description('显示清理报告')
    .requiredOption('--job <id>', '清理 Job ID')
    .option('--reports-dir <path>', '报告目录', 'reports')
    .action((opts: { job: string; reportsDir: string }) => {
      const path = join(opts.reportsDir, 'cleanup', opts.job, 'summary.md');
      if (existsSync(path)) {
        console.log(readFileSync(path, 'utf8'));
      } else {
        console.error(`未找到报告：${path}`);
        process.exit(1);
      }
    });

  return cleanup;
}
