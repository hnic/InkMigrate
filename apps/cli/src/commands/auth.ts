import { Command } from 'commander';
import {
  ensureProfileDir,
  profileExists,
  profilePath,
} from '@inkmigrate/source-toutiao';

/**
 * §12.2 `inkmigrate auth login/clear` 命令。
 *
 * Stage 3 只交付命令注册 + Profile 路径计算 + 状态打印。
 * 真实 Playwright 登录流程在 stage 4 接入（browser-pool + login-detector）。
 */
export function createAuthCommand(): Command {
  const auth = new Command('auth').description('管理来源登录状态');

  auth
    .command('login')
    .description('为指定来源打开浏览器，引导用户完成登录并保存 Profile')
    .requiredOption('--source <id>', '来源实例 ID（如 toutiao-main）')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { source: string; stateDir: string }) => {
      const path = ensureProfileDir(opts.stateDir, opts.source);
      console.log(`Profile 目录：${path}`);
      console.log(
        'Stage 3 占位：真实 Playwright 登录流程将在 stage 4 接入。当前只创建了 Profile 目录。',
      );
    });

  auth
    .command('clear')
    .description(
      '打印指定来源的工具专用 Profile 路径（stage 3 不自动删除；stage 4 接入自动删除）',
    )
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { source: string; stateDir: string }) => {
      const path = profilePath(opts.stateDir, opts.source);
      if (!profileExists(opts.stateDir, opts.source)) {
        console.log(`未找到 Profile：${path}`);
        return;
      }
      // stage 3 不真正删除（避免误删）；打印路径让用户手动 rm
      console.log(`Profile 路径：${path}`);
      console.log(
        'Stage 3 占位：自动删除在 stage 4 接入。当前如需删除请手动执行：',
      );
      console.log(`  rm -rf "${path}"`);
    });

  return auth;
}
