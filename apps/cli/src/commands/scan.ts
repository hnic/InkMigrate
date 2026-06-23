import { Command } from 'commander';

export function createScanCommand(): Command {
  return new Command('scan')
    .description('扫描来源收藏，保存 SourceItemRef 到数据库')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { source: string; stateDir: string }) => {
      console.log(
        `Stage 4 占位：将扫描来源 ${opts.source}（stateDir=${opts.stateDir}）`,
      );
      console.log('完整实现需要真实浏览器会话（stage 3 的 Playwright 接入）。');
    });
}
