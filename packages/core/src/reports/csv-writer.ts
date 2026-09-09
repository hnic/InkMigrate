import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** CSV 字段转义（字段级规则遵循 RFC 4180；记录分隔符统一用 `\n`）。 */
export function escapeCsvField(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) {
    s = '';
  } else if (typeof value === 'object') {
    // 对象/数组序列化为 JSON，避免 String() 产出 [object Object] 或逗号拼接
    // 造成不可恢复的数据丢失
    s = JSON.stringify(value) ?? '';
  } else {
    s = String(value);
  }
  // I21: CSV 公式注入防护（CWE-1236）。Excel/LibreOffice/WPS 会把以 = + - @ Tab CR
  // 开头（含前导空白后跟公式字符——部分表格软件会先 trim 再检测）的单元格当公式执行。
  // 迁移报告的 title/url 等来自外部不可信来源，操作员双击打开时 `=cmd|'/c calc'!A1`
  // 等可触发。前缀单引号使表格软件按文本处理（OWASP 推荐做法）。
  // 纯数值（数字或数值型字符串）跳过前缀：`-123` 这类负数列保持数值可比性。
  const isPlainNumber =
    typeof value === 'number' || /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s);
  if (!isPlainNumber && /^\s*[=+\-@\t\r\n]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * 写入 CSV 文件。第一行是列头。空数组写入空文件。
 * 行分隔符为 `\n`（便于 diff/文本工具处理）。
 *
 * §缺陷2：列头取所有行 key 的并集（按首次出现顺序），而非仅 rows[0] 的 key。
 * 否则可选列（如 externalId/canonicalUrl）一旦在首行缺失，后续行的值会被
 * 静默丢弃，导致导出数据残缺、列结构不稳定。
 */
export function writeCsv<T extends object>(path: string, rows: readonly T[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (rows.length === 0) {
    writeFileSync(path, '', 'utf8');
    return;
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => escapeCsvField((row as Record<string, unknown>)[h]))
        .join(','),
    );
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}
