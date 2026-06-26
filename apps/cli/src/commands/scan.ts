import { Command } from 'commander';
import { openDatabase, type DB } from '@inkmigrate/core';
import {
  profileExists,
  profilePath,
  ToutiaoBrowserSession,
  driveScanFavorites,
} from '@inkmigrate/source-toutiao';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * §22 `inkmigrate scan` 命令。
 *
 * 两种模式：
 * - --fixture-dir <path>：fixture HTML 模拟扫描（测试模式，不启动浏览器）
 * - 无 --fixture-dir：真实浏览器扫描（需要先 auth login 建立 Profile）
 */
export function createScanCommand(): Command {
  return new Command('scan')
    .description('扫描来源收藏，生成 scan-report.json')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option('--fixture-dir <path>', 'fixture HTML 目录（测试模式，不启动浏览器）')
    .option('--headless', '无头模式（默认 false 有头，因头条反爬会拦截 headless 返回空壳）')
    .option(
      '--favorites-url <url>',
      '收藏列表 URL',
      'https://www.toutiao.com/favorites',
    )
    .option('--max-items <n>', '限制扫描条目数（达到后立即停止滚动）')
    .action(async (opts: {
      source: string;
      stateDir: string;
      fixtureDir?: string;
      headless?: boolean;
      favoritesUrl: string;
      maxItems?: string;
    }) => {
      if (opts.fixtureDir) {
        return runFixtureScan({
          source: opts.source,
          stateDir: opts.stateDir,
          fixtureDir: opts.fixtureDir,
        });
      }
      return runBrowserScan({
        source: opts.source,
        stateDir: opts.stateDir,
        ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
        favoritesUrl: opts.favoritesUrl,
        ...(opts.maxItems !== undefined
          ? { maxItems: parseInt(opts.maxItems, 10) }
          : {}),
      });
    });
}

/** Fixture 模式扫描（保留原有逻辑）。 */
async function runFixtureScan(opts: {
  source: string;
  stateDir: string;
  fixtureDir: string;
}): Promise<void> {
  const { scanFavoritesList } = await import('@inkmigrate/source-toutiao');
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
}

/** 真实浏览器模式扫描。 */
async function runBrowserScan(opts: {
  source: string;
  stateDir: string;
  headless?: boolean;
  favoritesUrl: string;
  maxItems?: number;
}): Promise<void> {
  const profileDir = profilePath(opts.stateDir, opts.source);
  if (!profileExists(opts.stateDir, opts.source)) {
    console.error(`未找到 Profile：${profileDir}`);
    console.error(
      `请先运行：inkmigrate auth login --source ${opts.source} --state-dir ${opts.stateDir}`,
    );
    process.exit(1);
  }

  mkdirSync(opts.stateDir, { recursive: true });

  const session = new ToutiaoBrowserSession({
    profileDir,
    // 默认有头：头条反爬会拦截 headless（返回空壳页面，扫出 0 条）
    headless: opts.headless ?? false,
  });

  try {
    console.log(`正在启动浏览器扫描来源 ${opts.source}...`);
    await session.launch();
    const page = await session.newPage();

    const scanDriverOpts: Parameters<typeof driveScanFavorites>[0] = {
      page,
      favoritesUrl: opts.favoritesUrl,
      baseUrl: 'https://www.toutiao.com/',
      sourceInstanceId: opts.source,
    };
    if (opts.maxItems !== undefined) {
      scanDriverOpts.maxItems = opts.maxItems;
    }
    const { refs, scanResult } = await driveScanFavorites(scanDriverOpts);

    await page.close();

    // 写入 scan-report.json
    const reportPath = resolve(opts.stateDir, 'scan-report.json');
    const report = {
      sourceInstanceId: opts.source,
      scannedAt: new Date().toISOString(),
      uniqueItems: scanResult.uniqueItems,
      duplicateObservations: scanResult.duplicateObservations,
      scrollIterations: scanResult.scrollIterations,
      terminationReason: scanResult.terminationReason,
      items: refs.map((r) => ({
        externalId: r.externalId,
        canonicalUrl: r.canonicalUrl,
        title: r.title,
        contentKind: r.contentKind,
      })),
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`\n扫描完成：`);
    console.log(`  唯一条目数: ${scanResult.uniqueItems}`);
    console.log(`  重复观察数: ${scanResult.duplicateObservations}`);
    console.log(`  滚动轮次: ${scanResult.scrollIterations}`);
    console.log(`  终止原因: ${scanResult.terminationReason}`);
    console.log(`  报告: ${reportPath}`);
  } finally {
    await session.close();
  }
}
