import { Command } from 'commander';

/** 已注册（可经 inkmigrate.yaml 接线）的来源适配器，新增/下线时在此维护。 */
const REGISTERED_SOURCE_ADAPTERS = ['toutiao', 'evernote'] as const;

export function createSourceCommand(): Command {
  const source = new Command('source').description('来源管理');

  source.command('list').description('列出已注册的来源适配器').action(() => {
    console.log(`已注册来源：${REGISTERED_SOURCE_ADAPTERS.join('、')}`);
  });

  source
    .command('add <adapter>')
    .description('添加来源适配器实例')
    .requiredOption('--id <id>', '来源实例 ID')
    .action((adapter: string, opts: { id: string }) => {
      // N6: 占位命令——v1 阶段尚未实现交互式配置编辑。明确报错而非静默假装成功，
      // 指引手动编辑 yaml 的替代方式。
      // id/adapter 会拼进下方 YAML 示例，先校验格式，避免特殊字符生成错误配置
      if (!/^[A-Za-z0-9_-]+$/.test(opts.id) || !/^[A-Za-z0-9_-]+$/.test(adapter)) {
        console.error(
          `非法的实例 ID 或适配器名（仅允许字母、数字、_、-）：${opts.id} / ${adapter}`,
        );
        process.exit(1);
      }
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
      // N6: 占位命令
      console.error(`source validate 尚未实现（v1 阶段占位，来源实例：${opts.source}）。`);
      console.error(`可运行 inkmigrate doctor --state-dir <dir> 做基本健康检查。`);
      process.exit(1);
    });

  return source;
}
