import { Command } from 'commander';

export function createSourceCommand(): Command {
  const source = new Command('source').description('来源管理');

  source.command('list').description('列出已注册的来源适配器').action(() => {
    console.log('已注册来源：toutiao');
  });

  source
    .command('add <adapter>')
    .description('添加来源适配器实例')
    .requiredOption('--id <id>', '来源实例 ID')
    .action((adapter: string, opts: { id: string }) => {
      // N6: 占位命令——v1 阶段尚未实现交互式配置编辑。明确报错而非静默假装成功，
      // 指引手动编辑 yaml 的替代方式。
      console.error(`source add 尚未实现（v1 阶段占位）。`);
      console.error(`请手动编辑 inkmigrate.yaml，在 sources: 下添加：`);
      console.error(`  - id: ${opts.id}`);
      console.error(`    adapter: ${adapter}`);
      console.error(`    config: {}`);
      process.exit(1);
    });

  source
    .command('validate')
    .description('校验来源配置')
    .requiredOption('--source <id>', '来源实例 ID')
    .action((opts: { source: string }) => {
      void opts;
      // N6: 占位命令
      console.error(`source validate 尚未实现（v1 阶段占位）。`);
      console.error(`可运行 inkmigrate doctor --state-dir <dir> 做基本健康检查。`);
      process.exit(1);
    });

  return source;
}
