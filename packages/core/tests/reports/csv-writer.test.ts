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
});
