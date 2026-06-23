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

/** 写入 CSV 文件。第一行是列头（从第一个对象的键派生）。空数组写入空文件。 */
export function writeCsv(
  path: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  if (rows.length === 0) {
    writeFileSync(path, '', 'utf8');
    return;
  }
  const headers = Object.keys(rows[0]!);
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvField(row[h])).join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}
