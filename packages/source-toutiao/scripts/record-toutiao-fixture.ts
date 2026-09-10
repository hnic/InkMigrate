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
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Args {
  url: string;
  out: string;
  stateDir: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Partial<Args> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== '--url' && flag !== '--out' && flag !== '--state-dir') continue;
    const value = args[i + 1];
    // 缺值或值又是 flag（如 `--url --out foo` 会把 --out 吞成 URL）直接报错，
    // 拼错 invocation 不应靠 Partial 的真值检查间接暴露
    if (value === undefined || value.startsWith('--')) {
      console.error(`缺少 ${flag} 的参数值`);
      process.exit(1);
    }
    out[flag.slice(2) as keyof Args] = value;
    i++;
  }
  if (!out.url || !out.out || !out.stateDir) {
    console.error(
      'usage: record-toutiao-fixture.ts --url <url> --out <name> --state-dir <path>',
    );
    process.exit(1);
  }
  // --out 会拼进输出路径：仅允许纯文件名，拒绝 `../`、路径分隔符等穿越写
  if (!/^[\w.-]+$/.test(out.out)) {
    console.error(`--out 仅允许文件名（字母/数字/_/-/.），收到: ${out.out}`);
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
  // 浏览器生命周期必须异常安全：goto 超时（头条页面 networkidle 常年不触发）时
  // 也要 close，否则 Chromium 残留、profile 被 SingletonLock 锁住，下次运行失败
  let html: string;
  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
    // networkidle 在头条页几乎等不到，超时不致命；尽力等到再抓内容
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    html = await page.content();
  } finally {
    await browser.close();
  }

  // 基础脱敏：覆盖 JSON 双引号 / 单引号 / HTML 转义（&quot;）三种键形态，
  // 并扩展常见身份字段。统计替换次数——为 0 说明该页面字段形态未被覆盖，
  // 必须人工排查而不是默认已脱敏。（用户仍必须人工复核后才能提交）
  const sensitiveKeys = [
    'user_id', 'uid', 'username', 'screen_name', 'nickname',
    'mobile', 'phone', 'sessionid', 'token',
  ];
  let sanitized = html;
  let redactionCount = 0;
  for (const key of sensitiveKeys) {
    sanitized = sanitized.replace(
      new RegExp(
        `("${key}"|'${key}'|&quot;${key}&quot;)\\s*:\\s*("[^"]*"|'[^']*'|\\d+)`,
        'g',
      ),
      (_m, k: string) => {
        redactionCount++;
        return `${k}:"REDACTED"`;
      },
    );
  }
  console.log(
    `脱敏替换执行 ${redactionCount} 次；若为 0，说明正则未覆盖该页面字段形态，必须人工排查。`,
  );

  // 相对本脚本文件定位 fixtures 目录：record:fixture 以包目录为 cwd 运行，
  // process.cwd() 拼接会得到错误的嵌套路径 packages/source-toutiao/packages/...
  const outDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../tests/fixtures/toutiao',
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
