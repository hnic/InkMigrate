import { Command } from 'commander';
import { writeFileSync, existsSync } from 'node:fs';

export function createInitCommand(): Command {
  return new Command('init')
    .description('在当前目录初始化 inkmigrate.yaml 配置文件')
    .option('--force', '覆盖已存在的配置文件')
    .action((opts: { force?: boolean }) => {
      const path = 'inkmigrate.yaml';
      if (existsSync(path) && !opts.force) {
        console.error(`${path} 已存在。使用 --force 覆盖。`);
        process.exit(1);
      }
      writeFileSync(
        path,
        `version: 1\n\nworkspace:\n  stateDir: ".inkmigrate"\n  reportsDir: "reports"\n  logLevel: "info"\n\nsources: []\ntargets: []\n\nsourceCleanup:\n  enabled: false\n\nprivacy:\n  telemetry: false\n  redactLogs: true\n`,
        'utf8',
      );
      console.log(`已创建 ${path}`);
    });
}
