import { Command } from 'commander';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { loadConfigFromString } from '@inkmigrate/core';
import { CONFIG_FILENAME, errorMessage } from '../util.js';

/** init 生成的默认配置模板。 */
const DEFAULT_CONFIG_TEMPLATE = `version: 1

workspace:
  stateDir: ".inkmigrate"
  reportsDir: "reports"
  logLevel: "info"

sources: []
targets: []

sourceCleanup:
  enabled: false

privacy:
  telemetry: false
  redactLogs: true
`;

export function createInitCommand(): Command {
  return new Command('init')
    .description(`在当前目录初始化 ${CONFIG_FILENAME} 配置文件`)
    .option('--force', '覆盖已存在的配置文件（旧文件备份为 .bak）')
    .action((opts: { force?: boolean }) => {
      // 模板与 ConfigSchema 无编译期绑定（schema 在 core，仓库根的
      // example-config 守护测试也不覆盖此处），生成前实际校验一次：schema
      // 演进导致模板漂移时在此响亮失败，而非生成一份首次使用即报错的配置
      try {
        loadConfigFromString(DEFAULT_CONFIG_TEMPLATE);
      } catch (e) {
        console.error(`内置配置模板已与当前 schema 脱节，请升级工具：${errorMessage(e)}`);
        process.exitCode = 1;
        return;
      }
      const configPath = CONFIG_FILENAME;
      if (opts.force && existsSync(configPath)) {
        // 覆盖前留一份备份：--force 直接截断旧配置不可逆，误用时可用 .bak 找回
        try {
          copyFileSync(configPath, `${configPath}.bak`);
        } catch (e) {
          // 备份失败仍继续覆盖会不可逆丢数据，改为中止
          console.error(`备份现有配置失败，已中止覆盖：${errorMessage(e)}`);
          process.exitCode = 1;
          return;
        }
        console.log(`已备份原配置到 ${configPath}.bak`);
      }
      try {
        // 'wx'：仅当文件不存在时才创建（原子操作），避免检查与写入之间
        // 的竞态导致已有配置被静默覆盖；--force 时用 'w' 显式覆盖
        writeFileSync(configPath, DEFAULT_CONFIG_TEMPLATE, {
          encoding: 'utf8',
          flag: opts.force ? 'w' : 'wx',
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          console.error(`${configPath} 已存在。使用 --force 覆盖。`);
        } else {
          console.error(`创建 ${configPath} 失败：${errorMessage(e)}`);
        }
        process.exitCode = 1;
        return;
      }
      console.log(`已创建 ${configPath}`);
    });
}
