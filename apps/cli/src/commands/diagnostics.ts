import { Command } from 'commander';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createDiagnosticsCommand(): Command {
  const diagnostics = new Command('diagnostics').description('诊断数据管理');
  diagnostics
    .command('clear')
    .description('清除诊断目录')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { stateDir: string }) => {
      const diagDir = join(opts.stateDir, 'diagnostics');
      if (!existsSync(diagDir)) {
        console.log('诊断目录为空，无需清除。');
        return;
      }
      rmSync(diagDir, { recursive: true, force: true });
      console.log(`已清除诊断目录：${diagDir}`);
    });
  return diagnostics;
}
