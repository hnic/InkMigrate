import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** RFC 4180 CSV 字段转义。 */
export function escapeCsvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
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
