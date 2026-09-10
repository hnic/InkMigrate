import { Command } from 'commander';
import type { SourceWiring } from '@inkmigrate/wiring';

// 与 wiring 的 kind 联动（真相源是 SourceWiring['kind'] 联合类型）：新增 kind
// 未在此登记、或登记了 wiring 不存在的 kind，都会在这里编译报错，列表不会与
// 实际接线能力漂移（理想方案是 wiring 导出共享常量，v1 先用类型绑定兜住）。
const KIND_COVERAGE: Record<SourceWiring['kind'], true> = {
  toutiao: true,
  evernote: true,
};
/** 已注册（可经 inkmigrate.yaml 接线）的来源适配器。 */
const REGISTERED_SOURCE_ADAPTERS = Object.keys(
  KIND_COVERAGE,
) as Array<SourceWiring['kind']>;

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
      // id/adapter 会拼进下方 YAML 示例，先校验格式，避免特殊字符生成错误配置；
      // 校验失败的输入可能含控制字符/换行/ANSI 序列，JSON.stringify 转义后再回显
      if (!/^[A-Za-z0-9_-]+$/.test(opts.id) || !/^[A-Za-z0-9_-]+$/.test(adapter)) {
        console.error(
          `非法的实例 ID 或适配器名（仅允许字母、数字、_、-）：${JSON.stringify(opts.id)} / ${JSON.stringify(adapter)}`,
        );
        process.exit(1);
      }
      // 格式合法还须在注册表内：未注册的适配器名会引导用户写出 wiring 无法
      // 接线的配置（非 evernote 一律静默回退 toutiao 流程），提前拦下
      if (!(REGISTERED_SOURCE_ADAPTERS as readonly string[]).includes(adapter)) {
        console.error(
          `未注册的来源适配器：${JSON.stringify(adapter)}（可用：${REGISTERED_SOURCE_ADAPTERS.join('、')}，运行 source list 查看）`,
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
      // N6: 占位命令；opts.source 未做格式校验，转义后再回显防终端串写
      console.error(`source validate 尚未实现（v1 阶段占位，来源实例：${JSON.stringify(opts.source)}）。`);
      console.error(`可运行 inkmigrate doctor --state-dir <dir> 做基本健康检查。`);
      process.exit(1);
    });

  return source;
}
