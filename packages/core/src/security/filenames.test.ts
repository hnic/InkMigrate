import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './filenames.js';

describe('filenames (§13.4)', () => {
  it('NFC-normalizes decomposed characters', () => {
    const nfd = 'e\u0301'; // é as e + combining acute (NFD)
    expect(sanitizeFilename(nfd)).toBe('é');
  });

  it('strips Windows reserved names by prefixing underscore', () => {
    expect(sanitizeFilename('CON')).toMatch(/^_/);
    expect(sanitizeFilename('CON').length).toBeGreaterThan(3);
    expect(sanitizeFilename('PRN.txt')).toMatch(/^_/);
    expect(sanitizeFilename('nul')).toMatch(/^_/); // case-insensitive
    expect(sanitizeFilename('COM1')).toMatch(/^_/);
    expect(sanitizeFilename('LPT9')).toMatch(/^_/);
  });

  it('does not false-positive on reserved-as-substring names', () => {
    expect(sanitizeFilename('CONCEPT')).toBe('CONCEPT');
    expect(sanitizeFilename('lpt9-notes')).toBe('lpt9-notes');
  });

  it('removes trailing dots and spaces', () => {
    expect(sanitizeFilename('name.  ')).toBe('name');
    expect(sanitizeFilename('name . .')).toBe('name');
  });

  it('replaces illegal filesystem characters with dash', () => {
    const out = sanitizeFilename('a/b\\c:d*e?f<g>h|i"j');
    expect(out).not.toMatch(/[\\/:*?"<>|/]/);
    expect(out).toContain('-');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('a\u0000b\u0001c')).toBe('abc');
  });

  it('truncates to maxLength without leaving trailing dot/space', () => {
    const out = sanitizeFilename('a'.repeat(200), { maxLength: 10 });
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).not.toMatch(/[.\s]$/);
  });

  it('truncation that produces a reserved name still gets prefixed (§13.4)', () => {
    // 'CONCEPT' truncated to 3 chars becomes 'CON' — must still be prefixed
    expect(sanitizeFilename('CONCEPT', { maxLength: 3 })).toBe('_CON');
    expect(sanitizeFilename('PRNing', { maxLength: 3 })).toBe('_PRN');
    expect(sanitizeFilename('AUXiliary', { maxLength: 3 })).toBe('_AUX');
  });

  it('returns non-empty fallback for empty/all-illegal input', () => {
    expect(sanitizeFilename('')).toBe('_');
    expect(sanitizeFilename('.')).toBe('_');
    // all-illegal input becomes dashes (a legal filename); only truly empty → '_'
    expect(sanitizeFilename('///')).toBe('---');
  });

  it('preserves CJK characters and punctuation', () => {
    expect(sanitizeFilename('笔记-2026')).toBe('笔记-2026');
    expect(sanitizeFilename('如何学习编程？')).toBe('如何学习编程-');
  });

  it('L1: replaces all fullwidth illegal chars (／＼：＜＞｜＂)', () => {
    expect(sanitizeFilename('a／b')).toBe('a-b');
    expect(sanitizeFilename('a＼b')).toBe('a-b');
    expect(sanitizeFilename('a：b')).toBe('a-b');
    expect(sanitizeFilename('a＜b＞c')).toBe('a-b-c');
    expect(sanitizeFilename('a｜b')).toBe('a-b');
    expect(sanitizeFilename('a＂b')).toBe('a-b');
  });

  it('L1: truncation does not split surrogate pairs (emoji)', () => {
    // 😀 是代理对（2 个 UTF-16 code unit）。maxLength=1 用 code point 截断应保留完整 emoji，
    // 而非产生孤立代理导致无效文件名。
    const out = sanitizeFilename('😀😀😀', { maxLength: 1 });
    expect(out).toBe('😀');
  });
});
