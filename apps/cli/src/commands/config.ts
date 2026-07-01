import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadConfigFromString, ConfigValidationError } from '@inkmigrate/core';

export function createConfigCommand(): Command {
  const config = new Command('config').description('配置管理');

  config
    .command('validate')
    .description('校验 inkmigrate.yaml 配置文件')
    .option('--file <path>', '配置文件路径', 'inkmigrate.yaml')
    .action((opts: { file: string }) => {
      try {
        const raw = readFileSync(opts.file, 'utf8');
        loadConfigFromString(raw);
        console.log(`✓ ${opts.file} 校验通过`);
      } catch (e) {
        if (e instanceof ConfigValidationError) {
          console.error(`✗ ${opts.file} 校验失败：`);
          for (const err of e.errors) console.error(`  ${err}`);
        } else {
          console.error(`读取失败：${(e as Error).message}`);
        }
        process.exit(1);
      }
    });

  config
    .command('upgrade')
    .description('升级配置文件到当前版本')
    .action(() => {
      // N6: 占位命令——v1 配置 version 固定为 1，无旧版本需升级。明确告知而非
      // 静默假装执行。
      console.error('config upgrade 尚未实现（当前配置 version 固定为 1，无需升级）。');
      console.error('如从旧版本升级，请参考 README 手动调整配置结构。');
      process.exit(1);
    });

  return config;
}
