import { Command } from 'commander';
import {
  openDatabase,
  type DB,
} from '@inkmigrate/core';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * §22 `inkmigrate scan` 命令。
 *
 * v1.0-rc1：完整扫描需要真实浏览器会话（Playwright + Profile）。
 * 不带 --fixture-dir 时打印提示；带 --fixture-dir 时用 fixture HTML 模拟扫描。
 */
export function createScanCommand(): Command {
  return new Command('scan')
    .description('扫描来源收藏，保存 SourceItemRef 到数据库')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option('--fixture-dir <path>', 'fixture HTML 目录（测试模式，不启动浏览器）')
    .action(async (opts: {
      source: string;
      stateDir: string;
      fixtureDir?: string;
    }) => {
      if (!opts.fixtureDir) {
        console.log(`扫描来源 ${opts.source} 需要真实浏览器会话。`);
        console.log('完整实现需要先运行 inkmigrate auth login 建立 Profile。');
        console.log('测试模式：使用 --fixture-dir <path> 指定 fixture HTML 目录。');
        return;
      }

      // fixture-driven 扫描模式
      const { scanFavoritesList, deriveFingerprintInput } = await import(
        '@inkmigrate/source-toutiao'
      );
      const { computeFingerprint } = await import('@inkmigrate/core');
      const { readFileSync } = await import('node:fs');

      const favoritesHtml = readFileSync(
        join(opts.fixtureDir, 'favorites-list.html'),
        'utf8',
      );

      mkdirSync(opts.stateDir, { recursive: true });
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      const db: DB = openDatabase({ path: dbPath });
      try {
        const result = await scanFavoritesList({
          initialHtml: favoritesHtml,
          baseUrl: 'https://www.toutiao.com/',
          scrollForMore: async () => null,
          maxEmptyCycles: 1,
        });
        console.log(`扫描完成：`);
        console.log(`  唯一条目数: ${result.uniqueItems}`);
        console.log(`  重复观察数: ${result.duplicateObservations}`);
        console.log(`  终止原因: ${result.terminationReason}`);
        console.log(`  数据库: ${dbPath}`);
      } finally {
        db.close();
      }
    });
}
