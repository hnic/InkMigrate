import { Command } from 'commander';
import {
  ensureProfileDir,
  profileExists,
  profilePath,
  runLoginFlow,
  ToutiaoBrowserSession,
} from '@inkmigrate/source-toutiao';
import { rmSync } from 'node:fs';
import { parsePositiveInt } from '../util.js';

/**
 * §12.2 `inkmigrate auth login/clear` 命令。
 *
 * login：打开可见浏览器（headless=false），导航到收藏页，引导用户登录，
 * 多信号检测登录状态，Profile 自动持久化（launchPersistentContext）。
 *
 * clear：删除工具专用 Profile 目录（§12.3 只能删除该来源实例的 Profile）。
 */
export function createAuthCommand(): Command {
  const auth = new Command('auth').description('管理来源登录状态');

  auth
    .command('login')
    .description('为指定来源打开浏览器，引导用户完成登录并保存 Profile')
    .requiredOption('--source <id>', '来源实例 ID（如 toutiao-main）')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option(
      '--favorites-url <url>',
      '收藏列表 URL（默认 https://www.toutiao.com/favorites）',
    )
    .option(
      '--timeout <ms>',
      '等待登录的超时毫秒数（默认 300000 = 5 分钟）',
      '300000',
    )
    .action(async (opts: {
      source: string;
      stateDir: string;
      favoritesUrl?: string;
      timeout: string;
    }) => {
      const profileDir = ensureProfileDir(opts.stateDir, opts.source);
      console.log(`Profile 目录：${profileDir}`);
      console.log('正在启动浏览器...');

      const session = new ToutiaoBrowserSession({
        profileDir,
        headless: false,
      });

      try {
        await session.launch();
        console.log('浏览器已打开。');
        console.log('如果未自动跳转到登录页，请在浏览器中手动完成登录。');

        const result = await runLoginFlow({
          session,
          favoritesUrl:
            opts.favoritesUrl ?? 'https://www.toutiao.com/favorites',
          loginTimeoutMs: parsePositiveInt(opts.timeout, 'timeout'),
        });

        if (result.state === 'logged-in') {
          console.log('\n✅ 登录成功！Profile 已保存。');
          console.log('后续命令可复用此 Profile，不需要重新登录。');
        } else if (result.state === 'not-logged-in') {
          console.log('\n❌ 登录失败或超时。检测到未登录状态。');
          console.log('请重新运行此命令并完成登录。');
          process.exitCode = 1;
        } else {
          console.log('\n⚠️  登录状态不确定（auth-state-unknown）。');
          console.log('信号不足以确认已登录。请检查浏览器中的登录状态。');
          console.log('检测到的信号：', JSON.stringify(result.signals, null, 2));
          process.exitCode = 1;
        }
      } finally {
        await session.close();
      }
    });

  auth
    .command('clear')
    .description('删除指定来源的工具专用 Profile')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { source: string; stateDir: string }) => {
      const path = profilePath(opts.stateDir, opts.source);
      if (!profileExists(opts.stateDir, opts.source)) {
        console.log(`未找到 Profile：${path}`);
        return;
      }
      // §12.3 只删除该来源实例的工具专用 Profile
      rmSync(path, { recursive: true, force: true });
      console.log(`已删除 Profile：${path}`);
    });

  return auth;
}
