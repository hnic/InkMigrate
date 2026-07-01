import { Command } from 'commander';

export function createTargetCommand(): Command {
  const target = new Command('target').description('目标管理');

  target.command('list').description('列出已注册的目标适配器').action(() => {
    console.log('已注册目标：obsidian');
  });

  target
    .command('add <adapter>')
    .description('添加目标适配器实例')
    .requiredOption('--id <id>', '目标实例 ID')
    .action((adapter: string, opts: { id: string }) => {
      // N6: 占位命令——明确报错而非静默假装成功。
      console.error(`target add 尚未实现（v1 阶段占位）。`);
      console.error(`请手动编辑 inkmigrate.yaml，在 targets: 下添加：`);
      console.error(`  - id: ${opts.id}`);
      console.error(`    adapter: ${adapter}`);
      console.error(`    config: {}`);
      process.exit(1);
    });

  target
    .command('validate')
    .description('校验目标配置')
    .requiredOption('--target <id>', '目标实例 ID')
    .action((opts: { target: string }) => {
      void opts;
      // N6: 占位命令
      console.error(`target validate 尚未实现（v1 阶段占位）。`);
      console.error(`可运行 inkmigrate doctor --state-dir <dir> 做基本健康检查。`);
      process.exit(1);
    });

  return target;
}
