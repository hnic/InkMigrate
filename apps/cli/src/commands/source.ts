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
      console.log(
        `Stage 4 占位：将添加来源 ${adapter} (id=${opts.id}) 到 inkmigrate.yaml`,
      );
    });

  source
    .command('validate')
    .description('校验来源配置')
    .requiredOption('--source <id>', '来源实例 ID')
    .action((opts: { source: string }) => {
      console.log(`Stage 4 占位：将校验来源 ${opts.source} 的配置`);
    });

  return source;
}
