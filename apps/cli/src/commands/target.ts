import { Command } from 'commander';

/** 已注册（可经 inkmigrate.yaml 接线）的目标适配器，新增/下线时在此维护。 */
const REGISTERED_TARGET_ADAPTERS = ['obsidian'] as const;

export function createTargetCommand(): Command {
  const target = new Command('target').description('目标管理');

  target.command('list').description('列出已注册的目标适配器').action(() => {
    console.log(`已注册目标：${REGISTERED_TARGET_ADAPTERS.join('、')}`);
  });

  target
    .command('add <adapter>')
    .description('添加目标适配器实例')
    .requiredOption('--id <id>', '目标实例 ID')
    .action((adapter: string, opts: { id: string }) => {
      // N6: 占位命令——明确报错而非静默假装成功。
      // id/adapter 会拼进下方 YAML 示例，先校验格式，避免特殊字符生成错误配置
      if (!/^[A-Za-z0-9_-]+$/.test(opts.id) || !/^[A-Za-z0-9_-]+$/.test(adapter)) {
        console.error(
          `非法的实例 ID 或适配器名（仅允许字母、数字、_、-）：${opts.id} / ${adapter}`,
        );
        process.exit(1);
      }
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
      // N6: 占位命令
      console.error(`target validate 尚未实现（v1 阶段占位，目标实例：${opts.target}）。`);
      console.error(`可运行 inkmigrate doctor --state-dir <dir> 做基本健康检查。`);
      process.exit(1);
    });

  return target;
}
