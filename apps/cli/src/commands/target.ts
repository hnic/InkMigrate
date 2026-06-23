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
      console.log(
        `Stage 4 占位：将添加目标 ${adapter} (id=${opts.id}) 到 inkmigrate.yaml`,
      );
    });

  target
    .command('validate')
    .description('校验目标配置')
    .requiredOption('--target <id>', '目标实例 ID')
    .action((opts: { target: string }) => {
      console.log(`Stage 4 占位：将校验目标 ${opts.target} 的配置`);
    });

  return target;
}
