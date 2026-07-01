/**
 * CLI 共享工具。
 */

/**
 * R3: 把字符串选项解析为正整数，NaN/非正数时抛错（被 commander 外层 catch 捕获）。
 * M-4: 原用 process.exit(1) 会跳过调用方的 finally { db.close()/session.close() }，
 * 导致 auth.ts 中浏览器已启动后传错 --timeout 泄漏 Chromium。改为 throw 让 finally
 * 正常执行。
 */
export function parsePositiveInt(raw: string, field: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`无效的 ${field} 值："${raw}"，必须是正整数`);
  }
  return n;
}

/**
 * R3: 可选正整数解析——值为空/undefined 时返回 undefined（参数未提供），
 * 否则走 parsePositiveInt 校验。供 `--max-items` 等可选数值参数使用。
 */
export function parseOptionalPositiveInt(
  raw: string | undefined,
  field: string,
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  return parsePositiveInt(raw, field);
}
