import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** RFC 4180 CSV 字段转义。 */
export function escapeCsvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // I21: CSV 公式注入防护（CWE-1236）。Excel/LibreOffice/WPS 会把以 = + - @ Tab CR
  // 开头的单元格当公式执行。迁移报告的 title/url 等来自外部不可信来源，操作员双击
  // 打开时 `=cmd|'/c calc'!A1` 等可触发。前缀单引号使表格软件按文本处理（OWASP 推荐做法）。
  // 注意：`-` 前缀的合法负数也会被前缀，但报告字段多为文本，可接受；数值字段需调用方保证。
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * 写入 CSV 文件。第一行是列头。空数组写入空文件。
 *
 * §缺陷2：列头取所有行 key 的并集（按首次出现顺序），而非仅 rows[0] 的 key。
 * 否则可选列（如 externalId/canonicalUrl）一旦在首行缺失，后续行的值会被
 * 静默丢弃，导致导出数据残缺、列结构不稳定。
 */
export function writeCsv(
  path: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
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
    lines.push(headers.map((h) => escapeCsvField(row[h])).join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}
