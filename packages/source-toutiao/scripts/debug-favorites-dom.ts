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
  const arg = args[i];
  // 无法识别的孤立 token（拼写错误/多余位置参数）直接报错，
  // 否则错误的 state-dir/url 会以更迷惑的方式在下游失败
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

// 浏览器生命周期必须异常安全：goto 超时 / evaluate 失败时也要 close，
// 否则 Chromium 进程残留、profile 目录被 SingletonLock 锁住，下次运行直接失败
try {
  const page = browser.pages()[0] ?? (await browser.newPage());

  console.log(`导航到收藏页...`);
  // 头条页面有长连接轮询，networkidle 常年不触发导致 45s 超时；
  // 改用 domcontentloaded + 显式等内容链接出现
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const CONTENT_LINK_SELECTOR =
    'a[href*="/article/"], a[href*="/video/"], a[href*="/wenda/"], a[href*="/group/"], a[href*="/a/"], a[href*="/w/"]';
  await page.waitForSelector(CONTENT_LINK_SELECTOR, { timeout: 20_000 }).catch(() => {
    console.warn('20s 内未等内容链接出现，继续按现状分析');
  });

  console.log('\n========== DOM 分析 ==========\n');
  console.log('URL:', page.url());
  console.log('标题:', await page.title());

  // 用真实滚轮事件触发懒加载：收藏页可能在内部容器滚动，
  // window.scrollTo 滚主窗口时不会触发加载
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(500);
  }

  const analysis = await page.evaluate(() => {
  // 头条内容链接：/article|video|wenda|group|a/<数字ID>。
  // ID 长度阈值 10+ 按实测观察设定，更短/异形 ID 会漏计（仅影响本脚本的计数诊断）。
  const CONTENT_LINK_RE = /\/(article|video|wenda|group|a)\/\d{10,}/;
  // 找所有内容链接
  const allAnchors = Array.from(document.querySelectorAll('a[href]'));
  const contentLinks = allAnchors.filter((a) => {
    const href = a.getAttribute('href') ?? '';
    return CONTENT_LINK_RE.test(href);
  });

  return {
    contentLinkCount: contentLinks.length,
    links: contentLinks.slice(0, 5).map((a) => {
      // 用 getAttribute('class') 而非 className：SVG 元素的 className 是
      // SVGAnimatedString，对其调 substring 会直接抛 TypeError
      const p = a.parentElement;
      const gp = p?.parentElement;
      const ggp = gp?.parentElement;
      const gggp = ggp?.parentElement;
      return {
        href: a.getAttribute('href'),
        text: a.textContent?.trim().substring(0, 100),
        aClass: a.getAttribute('class'),
        parent: p ? `${p.tagName}.${p.getAttribute('class')?.substring(0, 150) ?? ''}` : '',
        grandparent: gp ? `${gp.tagName}.${gp.getAttribute('class')?.substring(0, 150) ?? ''}` : '',
        greatgrand: ggp ? `${ggp.tagName}.${ggp.getAttribute('class')?.substring(0, 150) ?? ''}` : '',
        greatgreat: gggp ? `${gggp.tagName}.${gggp.getAttribute('class')?.substring(0, 150) ?? ''}` : '',
      };
    }),
    // 找收藏相关容器
    favElements: Array.from(
      document.querySelectorAll(
        '[class*="fav"], [class*="Fav"], [class*="collect"], [class*="Collect"], [class*="bookmark"], [class*="Bookmark"]',
      ),
    ).slice(0, 5).map((el) => ({
      tag: el.tagName,
      class: el.getAttribute('class')?.substring(0, 200) ?? '',
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
} catch (err) {
  console.error('调试脚本执行失败：', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
