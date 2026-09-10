import { Command } from 'commander';
import { rmSync, existsSync, statSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';

export function createDiagnosticsCommand(): Command {
  const diagnostics = new Command('diagnostics').description('诊断数据管理');
  diagnostics
    .command('clear')
    .description('清除诊断目录')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { stateDir: string }) => {
      const stateDir = resolve(opts.stateDir);
      // 先拒绝文件系统根目录：`/` 存在且是目录，下方存在性校验拦不住它，
      // 递归删除会波及根下的 diagnostics 目录树（CI 容器上真实存在）
      if (stateDir === parse(stateDir).root) {
        console.error(`不允许对文件系统根目录执行清除：${opts.stateDir}`);
        process.exitCode = 1;
        return;
      }
      // 递归删除前再校验：stateDir 必须存在且为目录，避免误传路径（拼写
      // 错误等）时对任意目录树执行递归删除。throwIfNoEntry 消除 exists/stat
      // 之间的 TOCTOU（目录被并发删除时 statSync 会抛裸 ENOENT 崩溃）
      const stat = statSync(stateDir, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) {
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
