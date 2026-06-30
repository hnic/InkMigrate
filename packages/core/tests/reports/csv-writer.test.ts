import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeCsv, escapeCsvField } from '../../src/reports/csv-writer.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'csv-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('escapeCsvField (RFC 4180)', () => {
  it('passes through plain text', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });
  it('quotes fields with comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });
  it('quotes fields with quote (doubles the quote)', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes fields with newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });
  it('prefixes formula-injection cells with single quote (CWE-1236)', () => {
    // I21: = + - @ Tab CR 开头的单元格会被表格软件当公式执行
    expect(escapeCsvField('=cmd|\'/c calc\'!A1')).toBe("'=cmd|'/c calc'!A1");
    expect(escapeCsvField('+1+1')).toBe("'+1+1");
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
    // 公式注入字符 + 含逗号：先加单引号前缀，再加引号后字段含逗号 → RFC4180 引号转义
    expect(escapeCsvField('=HYPERLINK("a","b,c")')).toBe("\"'=HYPERLINK(\"\"a\"\",\"\"b,c\"\")\"");
  });
});

describe('writeCsv', () => {
  it('writes header + rows', () => {
    const path = join(dir, 'items.csv');
    writeCsv(path, [
      { id: 1, title: 'a', status: 'verified' },
      { id: 2, title: 'b,c', status: 'degraded' },
    ]);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('id,title,status');
    expect(content).toContain('1,a,verified');
    expect(content).toContain('2,"b,c",degraded');
  });
  it('handles empty array', () => {
    const path = join(dir, 'empty.csv');
    writeCsv(path, []);
    expect(readFileSync(path, 'utf8')).toBe('');
  });
  it('headers 取所有行 key 的并集（可选列不因 rows[0] 缺失而丢失）', () => {
    // §缺陷2：原实现 headers = Object.keys(rows[0])，若可选列（如 externalId）
    // 在首行缺失，后续行即便有值也会被静默丢弃。
    const path = join(dir, 'union.csv');
    writeCsv(path, [
      { id: 1, title: 'a' }, // 首行无 externalId
      { id: 2, title: 'b', externalId: 'tt-999' }, // 该行有 externalId
    ]);
    const content = readFileSync(path, 'utf8');
    // 表头应包含所有出现过的列（externalId 即便首行缺失也要有列）
    expect(content.split('\n')[0]).toContain('externalId');
    // 第 2 行的 externalId 值不得丢失
    expect(content).toContain('tt-999');
  });
});
