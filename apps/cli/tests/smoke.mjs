#!/usr/bin/env node
/**
 * CLI 接线冒烟测试（#53）：零外部依赖，只跑构建产物 dist/index.js，
 * 断言 --version/--help/未知选项 的输出与退出码契约。
 *
 * 依赖构建产物：根 `pnpm test`（pnpm -r run test）在 CI 中先于 build 执行，
 * 此时 dist 可能不存在——跳过并在 stderr 提示（退出 0，不阻塞其余包测试）；
 * 本地或构建后运行（如 `pnpm --filter @inkmigrate/cli build && pnpm test`）
 * 才做真实断言。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'index.js',
);

if (!existsSync(entry)) {
  console.error('SKIP: dist/index.js 未构建（先运行 pnpm --filter @inkmigrate/cli build）');
  process.exit(0);
}

let failed = 0;
const expect = (name, cond) => {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.error(`not ok - ${name}`);
  }
};
const run = (args) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });

const version = run(['--version']);
expect('--version 退出码 0', version.status === 0);
expect('--version 输出版本号', /^\d+\.\d+\.\d+/.test(version.stdout.trim()));

const help = run(['--help']);
expect('--help 退出码 0', help.status === 0);
expect('--help 含 Usage:', help.stdout.includes('Usage:'));

const unknown = run(['--definitely-not-an-option']);
expect(
  '未知选项退出码非 0 且有 stderr 输出',
  unknown.status !== 0 && unknown.status !== null && unknown.stderr.length > 0,
);

if (failed > 0) {
  console.error(`\n${failed} 项冒烟断言失败`);
}
process.exit(failed === 0 ? 0 : 1);
