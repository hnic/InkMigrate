import { Command } from 'commander';
import { writeFileSync } from 'node:fs';

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
    .description('在当前目录初始化 inkmigrate.yaml 配置文件')
    .option('--force', '覆盖已存在的配置文件')
    .action((opts: { force?: boolean }) => {
      const path = 'inkmigrate.yaml';
      try {
        // 'wx'：仅当文件不存在时才创建（原子操作），避免检查与写入之间
        // 的竞态导致已有配置被静默覆盖；--force 时用 'w' 显式覆盖
        writeFileSync(path, DEFAULT_CONFIG_TEMPLATE, {
          encoding: 'utf8',
          flag: opts.force ? 'w' : 'wx',
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          console.error(`${path} 已存在。使用 --force 覆盖。`);
        } else {
          console.error(
            `创建 ${path} 失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
        process.exitCode = 1;
        return;
      }
      console.log(`已创建 ${path}`);
    });
}
