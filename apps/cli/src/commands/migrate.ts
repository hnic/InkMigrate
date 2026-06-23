import { Command } from 'commander';

export function createMigrateCommand(): Command {
  return new Command('migrate')
    .description('执行迁移 Job（扫描→提取→写入→验证→报告）')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--target <id>', '目标实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option('--dry-run', '不写入目标（仅扫描+提取+计划）')
    .action((opts: { source: string; target: string; stateDir: string; dryRun?: boolean }) => {
      console.log(
        `Stage 4 占位：将迁移 ${opts.source} → ${opts.target}（stateDir=${opts.stateDir}）`,
      );
      if (opts.dryRun) console.log('Dry-run 模式：不写入目标。');
      console.log('完整实现需要真实浏览器会话。');
    });
}
