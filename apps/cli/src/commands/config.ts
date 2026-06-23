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
    .description('升级配置文件到当前版本（stage 4 占位）')
    .action(() => {
      console.log('Stage 4 占位：配置升级将在后续完善。');
    });

  return config;
}
