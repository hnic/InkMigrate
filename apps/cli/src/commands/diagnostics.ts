import { Command } from 'commander';
import { rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function createDiagnosticsCommand(): Command {
  const diagnostics = new Command('diagnostics').description('诊断数据管理');
  diagnostics
    .command('clear')
    .description('清除诊断目录')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { stateDir: string }) => {
      // 递归删除前先校验：stateDir 必须存在且为目录，避免误传路径
      //（拼写错误、`--state-dir /` 等）时对任意目录树执行递归删除
      const stateDir = resolve(opts.stateDir);
      if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) {
        console.error(`无效的 stateDir：${opts.stateDir}`);
        process.exitCode = 1;
        return;
      }
      const diagDir = join(stateDir, 'diagnostics');
      // 预检与 rmSync 之间的竞态可接受：并发删除时 force:true 使删除仍成功，
      // 最坏情况只是多打一行"已清除"；保留预检是为了"目录为空"这一提示语义
      if (!existsSync(diagDir)) {
        console.log('诊断目录为空，无需清除。');
        return;
      }
      try {
        rmSync(diagDir, { recursive: true, force: true });
        console.log(`已清除诊断目录：${diagDir}`);
      } catch (err) {
        console.error(
          `清除诊断目录失败：${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
      }
    });
  return diagnostics;
}
