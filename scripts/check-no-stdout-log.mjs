#!/usr/bin/env node
/**
 * 守护 JSON-RPC stdout 通道：禁止在 sidecar / core 路径里用
 * console.log / console.info / console.debug 直接写 stdout。
 *
 * apps/engine 是 Tauri sidecar，stdout 是 JSON-RPC 协议通道；
 * packages/core 被它 import，任何 stray console.log 都会污染协议流
 * （stderr 安全，console.error 不在此限制内）。
 *
 * 这是一道 CI 防线，不替代结构化日志；新增日志请用 logToStderr / logger。
 *
 * 用法：node scripts/check-no-stdout-log.mjs
 * 失败时非零退出。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 受限目录：sidecar 入口及其依赖链。 */
const SCOPES = ['apps/engine/src', 'packages/core/src'];
/** 禁止的写 stdout 调用（console.error 走 stderr，放行）。 */
const FORBIDDEN = /\bconsole\.(log|info|debug)\s*\(/;
/** 整行都是注释时放行；字符串字面量里的示例仍会被拦（精确豁免需 AST）。 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

let violations = 0;

function walk(dir) {
  const out = [];
  // 用 dirent 自身判断类型：符号链接一律跳过——断链会让 statSync 抛 ENOENT，
  // 指向祖先目录的链接则会让递归成环
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

for (const scope of SCOPES) {
  const base = join(ROOT, scope);
  // 守护脚本宁可响亮失败也不静默跳过：目录缺失说明配置失效，必须阻断 CI
  if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`✗ 配置的受限目录不存在: ${scope}`);
    process.exit(1);
  }
  const files = walk(base);
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!FORBIDDEN.test(line)) return;
      // 跳过整行都是注释的说明（字符串字面量中的示例仍会被拦，需 AST 才能精确豁免）
      if (COMMENT_LINE.test(line)) return;
      const rel = relative(ROOT, file);
      console.error(
        `${rel}:${i + 1}: 禁止 console.${FORBIDDEN.exec(line)[1]} ` +
          `（stdout 是 sidecar JSON-RPC 通道，改用 logToStderr / logger 写 stderr）\n  ${line.trim()}`,
      );
      violations++;
    });
  }
}

if (violations > 0) {
  console.error(`\n✗ 发现 ${violations} 处禁止的 stdout 日志调用。`);
  process.exit(1);
}
console.log('✓ engine/core 路径无 stdout 日志污染。');
