import { Command } from 'commander';
import {
  profileExists,
  profilePath,
  ToutiaoBrowserSession,
  driveScanFavorites,
} from '@inkmigrate/source-toutiao';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parsePositiveInt } from '../util.js';
import { resolveEvernoteSource, type SourceWiring } from '@inkmigrate/wiring';
import { lastScanIssues } from '@inkmigrate/source-evernote';

/** 头条站点基础 URL 与收藏页 URL（CLI 默认值与扫描驱动共用，避免多处硬编码漂移）。 */
const TOUTIAO_BASE_URL = 'https://www.toutiao.com/';
const TOUTIAO_FAVORITES_URL = `${TOUTIAO_BASE_URL}favorites`;

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
      TOUTIAO_FAVORITES_URL,
    )
    .option('--max-items <n>', '限制扫描条目数（达到后立即停止滚动）')
    .option('--config <path>', 'inkmigrate.yaml 配置路径（按 adapter 选择来源类型）', 'inkmigrate.yaml')
    .action(async (opts: {
      source: string;
      stateDir: string;
      fixtureDir?: string;
      headless?: boolean;
      favoritesUrl: string;
      maxItems?: string;
      config?: string;
    }) => {
      // §10.2 yaml 命中 evernote 来源 → 文件源预览扫描（不启动浏览器）
      const evernote = resolveEvernoteSource({
        config: opts.config ?? 'inkmigrate.yaml',
        sourceId: opts.source,
      });
      if (evernote !== undefined) {
        return runEvernoteScan({
          source: opts.source,
          stateDir: opts.stateDir,
          wiring: evernote,
        });
      }
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
          ? { maxItems: parsePositiveInt(opts.maxItems, 'max-items') }
          : {}),
      });
    });
}

/** Evernote 文件源预览扫描：ENEX/HTML 导出清单 + 笔记本分布，不写库。 */
async function runEvernoteScan(opts: {
  source: string;
  stateDir: string;
  wiring: SourceWiring;
}): Promise<void> {
  const wiring = opts.wiring;
  console.log(`正在扫描 Evernote 导出（来源 ${opts.source}）...`);
  const refs: Array<{
    externalId: string | undefined;
    title: string | undefined;
    notebook: string | undefined;
    stack: string | undefined;
  }> = [];
  let issues: readonly string[] = [];
  try {
    for await (const ref of wiring.adapter.scan({
      config: {},
      workspaceDir: opts.stateDir,
    })) {
      const meta = ref.sourceMetadata as { enex?: { notebook?: string; stack?: string } };
      refs.push({
        externalId: ref.externalId,
        title: ref.title,
        notebook: meta.enex?.notebook,
        stack: meta.enex?.stack,
      });
    }
    // issues 在关闭 adapter 前读取（其内部状态随 close 丢弃），并写入报告
    issues = lastScanIssues(wiring.adapter);
    const byNotebook = new Map<string, number>();
    for (const r of refs) {
      const key = [r.stack, r.notebook].filter(Boolean).join('/') || '(未知)';
      byNotebook.set(key, (byNotebook.get(key) ?? 0) + 1);
    }
    const reportPath = resolve(opts.stateDir, 'scan-report.json');
    mkdirSync(opts.stateDir, { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          sourceInstanceId: opts.source,
          scannedAt: new Date().toISOString(),
          uniqueItems: refs.length,
          byNotebook: Object.fromEntries(byNotebook),
          items: refs,
          issues,
        },
        null,
        2,
      ),
    );
    console.log(`\n扫描完成：`);
    console.log(`  唯一条目数: ${refs.length}`);
    for (const [nb, count] of [...byNotebook.entries()].sort()) {
      console.log(`  ${nb}: ${count} 条`);
    }
    if (issues.length > 0) {
      console.log(`  注意事项: ${issues.length} 条（见报告）`);
    }
    console.log(`  报告: ${reportPath}`);
  } finally {
    // 扫描/写报告中途抛错（如 ENEX 损坏、磁盘满）也要释放 adapter 持有的资源
    await wiring.adapter.close();
  }
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

  // scanFavoritesList 是纯函数（不落库），无需打开数据库
  const result = await scanFavoritesList({
    initialHtml: favoritesHtml,
    baseUrl: TOUTIAO_BASE_URL,
    scrollForMore: async () => null,
    maxEmptyCycles: 1,
  });
  console.log(`扫描完成：`);
  console.log(`  唯一条目数: ${result.uniqueItems}`);
  console.log(`  重复观察数: ${result.duplicateObservations}`);
  console.log(`  终止原因: ${result.terminationReason}`);
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

  // SIGINT 协作取消（与 migrate/cleanup 命令一致）。注册必须早于 launch：
  // launch/newPage 耗时可达数秒，期间 Ctrl+C 会走默认行为硬杀进程，留下孤儿
  // Chromium。Ctrl+C 置标志，driveScanFavorites 在滚动间隙检查并优雅终止。
  let cancelled = false;
  const onSigInt = () => {
    cancelled = true;
    console.log('\n收到终止信号，正在停止扫描...');
  };
  process.on('SIGINT', onSigInt);

  try {
    console.log(`正在启动浏览器扫描来源 ${opts.source}...`);
    await session.launch();
    const page = await session.newPage();

    const scanDriverOpts: Parameters<typeof driveScanFavorites>[0] = {
      page,
      favoritesUrl: opts.favoritesUrl,
      baseUrl: TOUTIAO_BASE_URL,
      sourceInstanceId: opts.source,
      isCancelled: () => cancelled,
    };
    if (opts.maxItems !== undefined) {
      scanDriverOpts.maxItems = opts.maxItems;
    }
    const { refs, scanResult } = await driveScanFavorites(scanDriverOpts);

    // 先写报告再关页面：page.close 若抛错（页面已崩溃/已取消）不应吞掉扫描
    // 数据；残留页面由外层 session.close() 统一回收
    const reportPath = resolve(opts.stateDir, 'scan-report.json');
    const report = {
      sourceInstanceId: opts.source,
      scannedAt: new Date().toISOString(),
      uniqueItems: scanResult.uniqueItems,
      duplicateObservations: scanResult.duplicateObservations,
      scrollIterations: scanResult.scrollIterations,
      terminationReason: cancelled ? 'cancelled' : scanResult.terminationReason,
      items: refs.map((r) => ({
        externalId: r.externalId,
        canonicalUrl: r.canonicalUrl,
        title: r.title,
        contentKind: r.contentKind,
      })),
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    await page.close().catch(() => undefined);

    console.log(`\n扫描${cancelled ? '已终止' : '完成'}：`);
    console.log(`  唯一条目数: ${scanResult.uniqueItems}`);
    console.log(`  重复观察数: ${scanResult.duplicateObservations}`);
    console.log(`  滚动轮次: ${scanResult.scrollIterations}`);
    console.log(`  终止原因: ${report.terminationReason}`);
    console.log(`  报告: ${reportPath}`);
  } catch (err) {
    // 启动/导航/驱动失败给出可读信息（session.close 由 finally 兜底）
    console.error(`浏览器扫描失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigInt);
    await session.close();
  }
}
