/**
 * CLI 共享工具。
 */

/**
 * R3: 把字符串选项解析为正整数，NaN/非正数时打印错误并 exit(1)。
 * 防止 parseInt(非数字) 产生 NaN 直达速率控制/抓取层（I25：NaN interval →
 * 最快速率 → 封号；NaN maxItems → 行为未定义）。
 *
 * migrate.ts 原有内联 parsePositiveInt 提升至此，供所有命令复用。
 */
export function parsePositiveInt(raw: string, field: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`无效的 ${field} 值："${raw}"，必须是正整数`);
    process.exit(1);
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
