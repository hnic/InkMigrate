import { Command } from 'commander';
import {
  profileExists,
  profilePath,
  ToutiaoBrowserSession,
  driveScanFavorites,
} from '@inkmigrate/source-toutiao';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parsePositiveInt, CONFIG_FILENAME, errorMessage } from '../util.js';
import { resolveEvernoteSource, type SourceWiring } from '@inkmigrate/wiring';
import { lastScanIssues } from '@inkmigrate/source-evernote';

/** 头条站点基础 URL 与收藏页 URL（CLI 默认值与扫描驱动共用，避免多处硬编码漂移）。 */
const TOUTIAO_BASE_URL = 'https://www.toutiao.com/';
const TOUTIAO_FAVORITES_URL = `${TOUTIAO_BASE_URL}favorites`;

/**
 * 扫描报告文件名（三种模式写 stateDir 下同一文件；字段结构随模式不同，
 * 读取方靠 `mode` 判别字段区分 schema）。
 */
const SCAN_REPORT_FILENAME = 'scan-report.json';

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
    .option('--config <path>', 'inkmigrate.yaml 配置路径（按 adapter 选择来源类型）', CONFIG_FILENAME)
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
        config: opts.config ?? CONFIG_FILENAME,
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
    const reportPath = resolve(opts.stateDir, SCAN_REPORT_FILENAME);
    mkdirSync(opts.stateDir, { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          sourceInstanceId: opts.source,
          scannedAt: new Date().toISOString(),
          // mode 判别字段：与浏览器模式的报告 schema 不同，读取方据此区分
          mode: 'evernote-file',
          uniqueItems: refs.length,
          // e2e 验收要求 scan-report.json 含 terminationReason；文件源扫描
          // 无滚动/取消语义，自然跑完即 completed（中途失败走下方部分报告）
          terminationReason: 'completed',
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
  } catch (err) {
    // 与 runBrowserScan 一致：给出模式专属错误信息并置退出码，而非只靠顶层
    // catch 的通用输出；大扫描（可能已跑数分钟）中途失败（ENEX 损坏、磁盘满）
    // 也落一份部分报告（已收集 refs + 非致命 issues），不必从零重来
    console.error(`Evernote 扫描失败：${errorMessage(err)}`);
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      writeFileSync(
        resolve(opts.stateDir, SCAN_REPORT_FILENAME),
        JSON.stringify(
          {
            sourceInstanceId: opts.source,
            scannedAt: new Date().toISOString(),
            mode: 'evernote-file',
            partial: true,
            uniqueItems: refs.length,
            items: refs,
            issues: lastScanIssues(wiring.adapter),
          },
          null,
          2,
        ),
      );
    } catch {
      // 部分报告写入失败不应掩盖原始错误
    }
    process.exitCode = 1;
  } finally {
    // 扫描/写报告中途抛错（如 ENEX 损坏、磁盘满）也要释放 adapter 持有的资源
    await wiring.adapter.close();
  }
}

/** Fixture 模式扫描（保留原有逻辑，补齐 scan-report.json 报告契约）。 */
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

  // 命令描述/README/e2e 验收清单均承诺 scan 命令生成 scan-report.json，
  // fixture 模式此前只打印 stdout，下游读报告会静默拿到空
  const reportPath = resolve(opts.stateDir, SCAN_REPORT_FILENAME);
  mkdirSync(opts.stateDir, { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        sourceInstanceId: opts.source,
        scannedAt: new Date().toISOString(),
        mode: 'toutiao-fixture',
        uniqueItems: result.uniqueItems,
        duplicateObservations: result.duplicateObservations,
        scrollIterations: result.scrollIterations,
        terminationReason: result.terminationReason,
        items: result.items,
      },
      null,
      2,
    ),
  );
  console.log(`扫描完成：`);
  console.log(`  唯一条目数: ${result.uniqueItems}`);
  console.log(`  重复观察数: ${result.duplicateObservations}`);
  console.log(`  终止原因: ${result.terminationReason}`);
  console.log(`  报告: ${reportPath}`);
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
  let sigintCount = 0;
  const onSigInt = () => {
    // 第二次 Ctrl+C 硬退出：驱动挂起（浏览器卡死/长导航）时滚动间隙的协作
    // 检查永远不执行，仅置标志会让进程无法中断（只剩 SIGKILL）——挂死的
    // 浏览器本也无法优雅回收，优先保证用户能终止进程
    if (++sigintCount >= 2) {
      console.error('\n再次收到终止信号，强制退出。');
      process.exit(130);
    }
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
    // 驱动返回后再按 Ctrl+C（如写报告期间）不应把自然终止改标为 cancelled；
    // 扫描期间的取消已由驱动经 isCancelled 反映进 scanResult.terminationReason
    const scanWasCancelled = cancelled;

    // 先写报告再关页面：page.close 若抛错（页面已崩溃/已取消）不应吞掉扫描
    // 数据；残留页面由外层 session.close() 统一回收
    const reportPath = resolve(opts.stateDir, SCAN_REPORT_FILENAME);
    const report = {
      sourceInstanceId: opts.source,
      scannedAt: new Date().toISOString(),
      // mode 判别字段：与 Evernote/fixture 模式的报告 schema 不同，读取方据此区分
      mode: 'toutiao-browser',
      uniqueItems: scanResult.uniqueItems,
      duplicateObservations: scanResult.duplicateObservations,
      scrollIterations: scanResult.scrollIterations,
      terminationReason: scanWasCancelled
        ? 'cancelled'
        : scanResult.terminationReason,
      items: refs.map((r) => ({
        externalId: r.externalId,
        canonicalUrl: r.canonicalUrl,
        title: r.title,
        contentKind: r.contentKind,
      })),
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    await page.close().catch(() => undefined);

    console.log(`\n扫描${scanWasCancelled ? '已终止' : '完成'}：`);
    console.log(`  唯一条目数: ${scanResult.uniqueItems}`);
    console.log(`  重复观察数: ${scanResult.duplicateObservations}`);
    console.log(`  滚动轮次: ${scanResult.scrollIterations}`);
    console.log(`  终止原因: ${report.terminationReason}`);
    console.log(`  报告: ${reportPath}`);
  } catch (err) {
    // 启动/导航/驱动失败给出可读信息（session.close 由 finally 兜底）
    console.error(`浏览器扫描失败：${errorMessage(err)}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigInt);
    await session.close();
  }
}
