#!/usr/bin/env node
/**
 * 调试脚本 v4：直接用用户提供的收藏页 URL 抓取 DOM。
 *
 * 用法：
 *   node packages/source-toutiao/scripts/debug-favorites-dom.ts \
 *     --state-dir <path> --source toutiao-main \
 *     --url "https://www.toutiao.com/c/user/token/<TOKEN>/?tab=fav"
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
  console.error('用法: --state-dir <path> --source <id> --url <收藏页URL>');
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

console.log(`导航到收藏页...`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });

// 等收藏列表渲染
console.log('等待 5 秒让页面完全渲染...');
await page.waitForTimeout(5000);

console.log('\n========== DOM 分析 ==========\n');
console.log('URL:', page.url());
console.log('标题:', await page.title());

// 滚动一次触发加载
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(3000);

const analysis = await page.evaluate(() => {
  // 找所有内容链接
  const allAnchors = Array.from(document.querySelectorAll('a[href]'));
  const contentLinks = allAnchors.filter((a) => {
    const href = a.getAttribute('href') ?? '';
    return href.match(/\/(article|video|wenda|group|a)\/\d{10,}/) !== null;
  });

  return {
    contentLinkCount: contentLinks.length,
    links: contentLinks.slice(0, 5).map((a) => {
      const p = a.parentElement;
      const gp = p?.parentElement;
      const ggp = gp?.parentElement;
      const gggp = ggp?.parentElement;
      return {
        href: a.getAttribute('href'),
        text: a.textContent?.trim().substring(0, 100),
        aClass: a.className,
        parent: p ? `${p.tagName}.${p.className?.substring(0, 150)}` : '',
        grandparent: gp ? `${gp.tagName}.${gp.className?.substring(0, 150)}` : '',
        greatgrand: ggp ? `${ggp.tagName}.${ggp.className?.substring(0, 150)}` : '',
        greatgreat: gggp ? `${gggp.tagName}.${gggp.className?.substring(0, 150)}` : '',
      };
    }),
    // 找收藏相关容器
    favElements: Array.from(
      document.querySelectorAll(
        '[class*="fav"], [class*="Fav"], [class*="collect"], [class*="Collect"], [class*="bookmark"], [class*="Bookmark"]',
      ),
    ).slice(0, 5).map((el) => ({
      tag: el.tagName,
      class: el.className?.substring(0, 200),
      childCount: el.children.length,
      html: el.outerHTML.substring(0, 1000),
    })),
    bodySnippet: document.body?.innerHTML.substring(0, 8000) ?? '',
  };
});

console.log(`\n内容链接数: ${analysis.contentLinkCount}`);

if (analysis.contentLinkCount > 0) {
  console.log('\n--- 内容链接结构（前 5 个）---');
  for (const l of analysis.links) {
    console.log(`\n  href: ${l.href}`);
    console.log(`  text: ${l.text}`);
    console.log(`  a.class: ${l.aClass}`);
    console.log(`  parent: ${l.parent}`);
    console.log(`  grand:  ${l.grandparent}`);
    console.log(`  great:  ${l.greatgrand}`);
    console.log(`  great²: ${l.greatgreat}`);
  }
}

console.log('\n--- 收藏相关元素 ---');
if (analysis.favElements.length === 0) {
  console.log('  未找到任何 [class*="fav/collect/bookmark"] 元素');
}
for (const f of analysis.favElements) {
  console.log(`\n  <${f.tag} class="${f.class}"> (${f.childCount} 子元素)`);
  console.log(`  HTML:\n  ${f.html}`);
}

console.log('\n--- body 前 8000 字符 ---\n');
console.log(analysis.bodySnippet);
console.log('\n========== 结束 ==========');

await browser.close();
