#!/usr/bin/env tsx
/**
 * §24.4 可选 fixture recorder。
 *
 * 用户本地运行（不在 CI）：
 *   pnpm --filter @inkmigrate/source-toutiao record:fixture -- \
 *     --url https://www.toutiao.com/article/<id>/ \
 *     --out article \
 *     --state-dir ~/.inkmigrate
 *
 * 脚本用 Playwright + 已有 Profile（用户先 `inkmigrate auth login`）打开 URL，
 * 抓取页面 HTML，做基础脱敏（移除明显账号字段），保存到 tests/fixtures/toutiao/<out>.html。
 *
 * 用户必须人工复核输出，确保无敏感数据后再提交。
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Args {
  url: string;
  out: string;
  stateDir: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Partial<Args> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') out.url = args[++i];
    else if (args[i] === '--out') out.out = args[++i];
    else if (args[i] === '--state-dir') out.stateDir = args[++i];
  }
  if (!out.url || !out.out || !out.stateDir) {
    console.error(
      'usage: record-toutiao-fixture.ts --url <url> --out <name> --state-dir <path>',
    );
    process.exit(1);
  }
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const profileDir = resolve(args.stateDir, 'profiles', 'toutiao-main');

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto(args.url, { waitUntil: 'networkidle' });

  // 抓取 body HTML
  const html = await page.content();
  await browser.close();

  // 基础脱敏：移除常见账号字段（用户必须人工复核）
  let sanitized = html;
  sanitized = sanitized.replace(/"user_id"\s*:\s*"\d+"/g, '"user_id":"REDACTED"');
  sanitized = sanitized.replace(/"username"\s*:\s*"[^"]+"/g, '"username":"REDACTED"');
  sanitized = sanitized.replace(/"mobile"\s*:\s*"[^"]+"/g, '"mobile":"REDACTED"');

  const outDir = join(
    process.cwd(),
    'packages/source-toutiao/tests/fixtures/toutiao',
  );
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${args.out}.html`);
  writeFileSync(outPath, sanitized);
  console.log(`已保存到 ${outPath}`);
  console.log(
    '⚠️  请人工复核，确保无敏感数据（Cookie/用户名/手机号/真实账号 ID）后再提交。',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
