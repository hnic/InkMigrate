#!/usr/bin/env node
/**
 * 调试脚本：打开一篇已收藏文章的详情页，查找"取消收藏"按钮的 DOM 结构。
 *
 * 用法（.ts 需经 tsx 运行，node 无法直接执行 TypeScript/顶层 await）：
 *   pnpm --filter @inkmigrate/source-toutiao exec tsx \
 *     scripts/debug-unfavorite-dom.ts \
 *     --state-dir <path> --source toutiao-main \
 *     --url "https://www.toutiao.com/article/7654740435696402944/"
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const parsed: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  // 无法识别的孤立 token（拼写错误/多余位置参数）直接报错，
  // 静默跳过会让错误的 state-dir/url 以更迷惑的方式在下游失败
  if (!arg?.startsWith('--') || arg === '--') {
    console.error(`无法识别的参数: ${arg ?? '(空)'}`);
    process.exit(1);
  }
  const value = args[i + 1];
  // 取值缺失或又是 flag（如 `--url --source x` 会把 --source 当 URL）同样报错
  if (value === undefined || value.startsWith('--')) {
    console.error(`参数 ${arg} 缺少取值`);
    process.exit(1);
  }
  parsed[arg.slice(2)] = value;
  i++;
}
const stateDir = parsed['state-dir'];
const source = parsed['source'] ?? 'toutiao-main';
const url = parsed['url'];
if (!stateDir || !url) {
  console.error('用法: --state-dir <path> --source <id> --url <文章详情页URL>');
  process.exit(1);
}

const profileDir = resolve(stateDir, 'profiles', source);
if (!existsSync(profileDir)) {
  console.error(`Profile 不存在：${profileDir}`);
  process.exit(1);
}

console.log('正在启动浏览器...');
const browser = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 1000 },
});

// Ctrl+C / kill 时关闭浏览器再退出，否则持久化上下文的 Chromium 进程会被孤儿化、
// profile 目录被 SingletonLock 锁住，导致后续用同一 profile 的运行失败。
// 必须等 close 完成后再 exit——同步 exit 会在 Playwright 停止 Chromium 前杀掉进程。
const shutdown = (signal: NodeJS.Signals) => {
  console.log(`\n收到 ${signal}，正在关闭浏览器...`);
  browser
    .close()
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const page = browser.pages()[0] ?? (await browser.newPage());

try {
  console.log(`导航到文章详情页: ${url}`);
  // 头条详情页有长连接轮询，networkidle 常年不触发；改用 domcontentloaded +
  // 等操作栏渲染 + 少量缓冲。
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page
    .waitForSelector('[class*="action"], [class*="footer"], [class*="toolbar"]', {
      timeout: 30_000,
    })
    .catch(() => {});
  await page.waitForTimeout(1000);
} catch (err) {
  console.error(`导航失败: ${url}`, err);
  await browser.close().catch(() => {});
  process.exit(1);
}

console.log('\n========== 查找收藏/取消收藏按钮 ==========\n');
console.log('URL:', page.url());

// 导航成功后的 DOM 分析/输出也可能失败（页面被手动关闭/渲染进程崩溃/意外导航），
// 同样需要关闭浏览器再退出，避免持久化 profile 被 SingletonLock 锁住
let analysis: Awaited<ReturnType<typeof collectAnalysis>>;
try {
  analysis = await collectAnalysis();
} catch (err) {
  console.error('DOM 分析失败', err);
  await browser.close().catch(() => {});
  process.exit(1);
}

/** DOM 分析主体（在页面上下文执行，可能因页面关闭/崩溃而 reject）。 */
async function collectAnalysis() {
  return await page.evaluate(() => {
  const results = [];

  // 搜索收藏相关文本和图标
  const patterns = ['收藏', '已收藏', '取消收藏', 'favorite', 'collect', 'unfavorite'];

  // 1. 文本匹配
  for (const pattern of patterns) {
    const els = Array.from(document.querySelectorAll('button, a, span, div, i')).filter((el) => {
      const text = el.textContent?.trim();
      return text === pattern || (el.children.length === 0 && text?.includes(pattern));
    });
    for (const el of els.slice(0, 5)) {
      results.push({
        type: 'text',
        pattern,
        tag: el.tagName,
        class: el.className?.toString().substring(0, 200),
        text: el.textContent?.trim().substring(0, 50),
        title: el.getAttribute('title'),
        ariaLabel: el.getAttribute('aria-label'),
        outerHTML: el.outerHTML.substring(0, 400),
        parentClass: el.parentElement?.className?.toString().substring(0, 150),
      });
    }
  }

  // 2. class 包含 fav/collect/bookmark
  const classEls = Array.from(
    document.querySelectorAll('[class*="fav"], [class*="Fav"], [class*="collect"], [class*="Collect"], [class*="bookmark"], [class*="Bookmark"]'),
  ).slice(0, 10).map((el) => ({
    type: 'class',
    tag: el.tagName,
    class: el.className?.toString().substring(0, 200),
    text: el.textContent?.trim().substring(0, 50),
    outerHTML: el.outerHTML.substring(0, 400),
  }));

  // 3. 底部操作栏（文章页通常有固定底栏）
  const footer = document.querySelector('[class*="footer"], [class*="Footer"], [class*="action-bar"], [class*="ActionBar"], [class*="toolbar"], [class*="Toolbar"]');
  const footerHTML = footer?.outerHTML.substring(0, 1500) ?? '未找到操作栏';

  return { textButtons: results, classButtons: classEls, footerHTML };
  });
}

console.log('\n--- 文本匹配的收藏按钮 ---');
if (analysis.textButtons.length === 0) {
  console.log('  未找到');
}
for (const b of analysis.textButtons) {
  console.log(`\n  [${b.pattern}] <${b.tag} class="${b.class}">`);
  console.log(`  text="${b.text}" title="${b.title}" aria="${b.ariaLabel}"`);
  console.log(`  parent class: ${b.parentClass}`);
  console.log(`  HTML: ${b.outerHTML}`);
}

console.log('\n--- class 匹配的收藏相关元素 ---');
if (analysis.classButtons.length === 0) {
  console.log('  未找到');
}
for (const b of analysis.classButtons) {
  console.log(`\n  <${b.tag} class="${b.class}"> text="${b.text}"`);
  console.log(`  HTML: ${b.outerHTML}`);
}

console.log('\n--- 操作栏 HTML ---');
console.log(analysis.footerHTML);

// dump body 前 5000 字符（同样可能因页面关闭/崩溃而 reject，纳入同一兜底）
let bodyHtml = '';
try {
  bodyHtml = await page.evaluate(() => document.body?.innerHTML.substring(0, 5000) ?? '');
} catch (err) {
  console.error('body dump 失败', err);
  await browser.close().catch(() => {});
  process.exit(1);
}
console.log('\n--- body 前 5000 字符 ---\n');
console.log(bodyHtml);

console.log('\n========== 结束 ==========');
console.log('浏览器保持打开，按 Ctrl+C 退出。');
await new Promise(() => {});
