#!/usr/bin/env node
/**
 * 调试脚本：打开一篇已收藏文章的详情页，查找"取消收藏"按钮的 DOM 结构。
 *
 * 用法：
 *   node packages/source-toutiao/scripts/debug-unfavorite-dom.ts \
 *     --state-dir <path> --source toutiao-main \
 *     --url "https://www.toutiao.com/article/7654740435696402944/"
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const parsed: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  if (args[i]?.startsWith('--')) parsed[args[i]!.slice(2)] = args[++i] ?? '';
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

const page = browser.pages()[0] ?? (await browser.newPage());

console.log(`导航到文章详情页: ${url}`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
await page.waitForTimeout(5000);

console.log('\n========== 查找收藏/取消收藏按钮 ==========\n');
console.log('URL:', page.url());

const analysis = await page.evaluate(() => {
  const results = [];

  // 搜索收藏相关文本和图标
  const patterns = ['收藏', '已收藏', '取消收藏', 'favorite', 'collect', 'unfavorite'];

  // 1. 文本匹配
  for (const pattern of patterns) {
    const els = Array.from(document.querySelectorAll('button, a, span, div, i')).filter((el) => {
      const text = el.textContent?.trim();
      return text === pattern || text === pattern + ' ' || (el.children.length === 0 && text?.includes(pattern));
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

// dump body 前 5000 字符
const bodyHtml = await page.evaluate(() => document.body?.innerHTML.substring(0, 5000) ?? '');
console.log('\n--- body 前 5000 字符 ---\n');
console.log(bodyHtml);

console.log('\n========== 结束 ==========');
console.log('浏览器保持打开，按 Ctrl+C 退出。');
await new Promise(() => {});
