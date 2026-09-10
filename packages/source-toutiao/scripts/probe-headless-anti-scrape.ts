#!/usr/bin/env node
/**
 * 决定性对照探针：回答"headless 是不是头条反爬的根因"。
 *
 * 在【同一个 profile】下，用真实的 driveScanFavorites 逻辑跑多种配置，
 * 对比"扫到的收藏条目数 / 是否被踢到登录页 / 终止原因"。
 *
 * 这是 commit 1532e4d 里"65 vs 0"结论的【同口径】复现 + 扩展：
 *   - 配置① 有头（基线，已知能扫到）
 *   - 配置② headless 现状（已知扫到 0）
 *   - 配置③ headless + channel:'chrome'（用系统真 Chrome，验证是不是 Chromium 指纹的锅）
 *
 * 【2026-06-27 实测确认】同一 profile（带 cookie）下：
 *   - 有头：67KB 完整 SPA（24 个 script）；
 *   - headless Chromium + headless 系统 Chrome：均 39 字节空 HTML 骨架（0 script）。
 *   已排除 cookie 与 Chromium 指纹两个混淆变量。头条首页在 headless 下可正常访问，
 *   拦截只发生在收藏这类高价值端点。反爬判定信号用"序列化 DOM 长度"
 *   （outerHTML 字符数，非 HTTP 响应字节数；39B vs >10KB 两个数量级足以区分），
 *   不依赖具体收藏条目数（条目数受登录态强弱影响）。
 *
 * 用法：
 *   pnpm --filter @inkmigrate/source-toutiao exec tsx \
 *     scripts/probe-headless-anti-scrape.ts \
 *     --state-dir <path-to-.inkmigrate> --source toutiao-main \
 *     --url "https://www.toutiao.com/c/user/token/<TOKEN>/?tab=fav"
 *
 * 可选：--config headed,headless,headless-chrome  指定只跑哪几组（逗号分隔，按稳定 id 匹配）
 */
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// 用真实扫描逻辑（与 adapter / commit 1532e4d 同口径）
import { driveScanFavorites } from '../src/browser/scan-driver.js';

const args = process.argv.slice(2);
const parsed: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  // 孤立 token（flag 拼写错误、多余位置参数、复制粘贴残留）告警而非静默跳过：
  // 无人值守实验里静默用错 state-dir/url 比直接报错更危险
  if (flag === undefined || !flag.startsWith('--')) {
    console.warn(`⚠️ 忽略无法识别的参数：${flag}`);
    continue;
  }
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`参数 ${flag} 缺少取值`);
    process.exit(1);
  }
  parsed[flag.slice(2)] = value;
  i++;
}
const stateDir = parsed['state-dir'];
const source = parsed['source'] ?? 'toutiao-main';
const url = parsed['url'];
const configFilter = parsed['config']
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!stateDir || !url) {
  console.error('用法: --state-dir <path> --source <id> --url <收藏页URL>');
  process.exit(1);
}

const profileDir = resolve(stateDir, 'profiles', source);
if (!existsSync(profileDir)) {
  console.error(`Profile 不存在：${profileDir}`);
  process.exit(1);
}

interface ProbeConfig {
  /** 机器可读的稳定 ID：--config 过滤与判读 find 都按它匹配，label 仅用于展示。 */
  id: string;
  label: string;
  headless: boolean;
  channel?: 'chrome';
}

const ALL_CONFIGS: ProbeConfig[] = [
  { id: 'headed', label: '有头(基线)', headless: false },
  { id: 'headless', label: 'headless(现状)', headless: true },
  { id: 'headless-chrome', label: 'headless+chrome', headless: true, channel: 'chrome' },
];

const configs = configFilter
  ? ALL_CONFIGS.filter((c) => configFilter.includes(c.id))
  : ALL_CONFIGS;

if (configs.length === 0) {
  console.error(
    `无匹配配置。可选：${ALL_CONFIGS.map((c) => c.id).join(', ')}（label 仅用于展示：${ALL_CONFIGS.map((c) => c.label).join(', ')}）`,
  );
  process.exit(1);
}

console.log(`\n收藏页 URL: ${url}`);
console.log(`Profile: ${profileDir}`);
console.log(`将跑 ${configs.length} 组配置：${configs.map((c) => c.label).join(' / ')}\n`);

interface ProbeResult {
  id: string;
  label: string;
  itemCount: number;
  finalUrl: string;
  title: string;
  terminatedBy: string;
  loggedOut: boolean;
  rawHtmlLen: number;
  scriptCount: number;
  /** 诊断 evaluate 是否成功：false 时 rawHtmlLen=0 是"测不到"而非"空骨架被拦"。 */
  diagOk: boolean;
  error?: string;
  durationMs: number;
}

async function runOne(cfg: ProbeConfig): Promise<ProbeResult> {
  const start = Date.now();
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: cfg.headless,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1000 },
  };
  if (cfg.channel !== undefined) launchOptions.channel = cfg.channel;

  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    const page = await context.newPage();

    const { refs, scanResult } = await driveScanFavorites({
      page,
      favoritesUrl: url,
      // 从已校验的 --url 实参派生 baseUrl，避免与硬编码域名两处来源漂移
      baseUrl: new URL(url).origin + '/',
      sourceInstanceId: source,
      maxEmptyCycles: 2,
    });

    const finalUrl = page.url();
    const title = await page.title().catch(() => '(无标题)');

    // 关键诊断：序列化 DOM 长度 + script 数，区分"空骨架被拦"vs"正常 SPA"。
    // 注意这是解析/hydration 后的 documentElement.outerHTML 字符数（非 HTTP 响应
    // 字节数），但足以区分 39B 空骨架与 >10KB 完整 SPA 两个数量级。
    // （扫到 0 可能是反爬空壳，也可能是登录后真空；该指标最可靠）
    // diagOk 标记 evaluate 本身是否成功：evaluate 偶发失败（导航中/崩溃/target
    // closed）时 rawHtmlLen=0 是"测不到"，不能与"空骨架被拦"混为一谈。
    const diag = await page
      .evaluate(() => ({
        rawHtmlLen: document.documentElement?.outerHTML.length ?? 0,
        scriptCount: document.querySelectorAll('script').length,
      }))
      .then((d) => ({ ...d, diagOk: true as const }))
      .catch(() => ({ rawHtmlLen: 0, scriptCount: 0, diagOk: false as const }));

    return {
      id: cfg.id,
      label: cfg.label,
      itemCount: refs.length,
      finalUrl,
      title,
      loggedOut: /passport|login/i.test(finalUrl),
      terminatedBy: scanResult.terminationReason,
      rawHtmlLen: diag.rawHtmlLen,
      scriptCount: diag.scriptCount,
      diagOk: diag.diagOk,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: cfg.id,
      label: cfg.label,
      itemCount: 0,
      finalUrl: '(异常)',
      title: '',
      loggedOut: false,
      terminatedBy: 'error',
      rawHtmlLen: 0,
      scriptCount: 0,
      diagOk: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    if (context !== undefined) {
      let closeFailed = false;
      await context.close().catch((e) => {
        // 三组配置共用同一 profile，close 失败意味着锁未释放，会连累下一组
        // launch 失败（并被误读为"被拦"），必须显式暴露。
        closeFailed = true;
        console.error(
          `⚠️ [${cfg.label}] context.close 失败：${e instanceof Error ? e.message : String(e)}（profile 可能仍被锁定）`,
        );
      });
      if (closeFailed) {
        // 以"结论可信"为目标的对照实验：close 失败后剩余配置必失败、对比已失效，
        // 立即中止并宣告本轮实验作废，而不是跑完打出误导性的"对照结果"表格
        console.error('⚠️ profile 锁未释放，剩余配置不再执行，本轮对照实验作废。');
        process.exit(1);
      }
    }
  }
}

const results: ProbeResult[] = [];
for (const cfg of configs) {
  process.stdout.write(`▶ 跑 [${cfg.label}] ... `);
  const r = await runOne(cfg);
  results.push(r);
  console.log(
    `扫到 ${r.itemCount} 条 | HTML ${r.rawHtmlLen}B/script${r.scriptCount} | ${r.durationMs}ms` +
      ` | ${r.finalUrl} | ${r.title}` +
      (r.loggedOut ? ' | 🚪被踢到登录页' : '') +
      (r.error ? ` | ❌${r.error.slice(0, 80)}` : ''),
  );
}
// 任一组异常退出码置 1，避免 CI 把崩溃的探针当成有效实验
if (results.some((r) => r.error !== undefined)) {
  process.exitCode = 1;
}

console.log('\n========== 对照结果 ==========\n');
console.log(
  '配置'.padEnd(20) +
    '条目数'.padStart(6) +
    'HTML字节'.padStart(10) +
    'script'.padStart(8) +
    '   耗时   终止原因',
);
console.log('-'.repeat(85));
for (const r of results) {
  console.log(
    r.label.padEnd(20) +
      String(r.itemCount).padStart(6) +
      `${r.rawHtmlLen}B`.padStart(10) +
      String(r.scriptCount).padStart(8) +
      `   ${r.durationMs}ms   ${r.terminatedBy}`,
  );
}
console.log();

// 决定性判读：用 rawHtmlLen 区分"空骨架被拦(<200B)"vs"正常 SPA(>10KB)"
// 39B 空骨架 vs >10KB 完整 SPA 的分界阈值（三处判读共用，勿各自硬编码）
const EMPTY_SKELETON_MAX_BYTES = 200;
// 判读按稳定 id 匹配（label 仅展示用，改动 label 不应静默跳过判读段）
const baseline = results.find((r) => r.id === 'headed');
const headless = results.find((r) => r.id === 'headless');
const chromeHeadless = results.find((r) => r.id === 'headless-chrome');

console.log('========== 判读 ==========');
if (baseline && headless) {
  // 异常退出（profile 锁/浏览器缺失等）与诊断 evaluate 失败的 rawHtmlLen=0 都不算
  // "被拦"（diagOk=false 表示"测不到"而非"空骨架"），否则崩溃会被误读成
  // "✅ 反爬成立"的结论。
  const baselineBlocked =
    baseline.error === undefined && baseline.diagOk && baseline.rawHtmlLen < EMPTY_SKELETON_MAX_BYTES;
  const headlessBlocked =
    headless.error === undefined && headless.diagOk && headless.rawHtmlLen < EMPTY_SKELETON_MAX_BYTES;
  if (baselineBlocked && headlessBlocked) {
    console.log('⚠️ 有头和 headless 都拿到空骨架 → 登录态未生效，本轮无法判定反爬（需先解决登录态）。');
  } else if (!baselineBlocked && headlessBlocked) {
    console.log('✅ 反爬成立：有头正常(' + baseline.rawHtmlLen + 'B)，headless 被拦(' + headless.rawHtmlLen + 'B)。');
  } else if (!baselineBlocked && !headlessBlocked) {
    console.log('✅ 反爬不成立：有头和 headless 都正常渲染 → 当前条件下 headless 可用。');
    if (baseline.itemCount === 0 && headless.itemCount === 0) {
      console.log('   （两者条目数都为 0，可能是收藏确实为空，或登录态不足以看收藏——非反爬问题）');
    }
  } else {
    console.log('ℹ️ 异常组合：有头被拦(' + baseline.rawHtmlLen + 'B) 但 headless 正常(' + headless.rawHtmlLen + 'B)，需人工核对。');
  }
}
if (chromeHeadless) {
  const blocked =
    chromeHeadless.error === undefined &&
    chromeHeadless.diagOk &&
    chromeHeadless.rawHtmlLen < EMPTY_SKELETON_MAX_BYTES;
  console.log(
    blocked
      ? '❌ headless + 系统 Chrome 仍被拦(' + chromeHeadless.rawHtmlLen + 'B)。'
      : '✅ headless + 系统 Chrome 正常(' + chromeHeadless.rawHtmlLen + 'B) → 系统 Chrome 指纹可绕过。',
  );
}
console.log('\n');
