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

  it('§13.6 decodes &quot; then replaces the resulting quote with dash', () => {
    // 标题经多次 innerHTML 序列化后，`"` 被编码为 `&quot;` 漏进文件名。
    expect(sanitizeFilename('Tom &quot;Jerry&quot;')).toBe('Tom -Jerry-');
    expect(sanitizeFilename('a&quot;b&quot;c')).toBe('a-b-c');
    // &quot; 解码出的 " 与字面 " 走同一路径，结果一致
    expect(sanitizeFilename('a&quot;b')).toBe(sanitizeFilename('a"b'));
  });

  it('§13.6 does NOT decode &amp; / &lt; in filenames', () => {
    // 文件名场景下 & 是合法字符，原样保留；&lt; 不解码（解码出的 < 会触发
    // ILLEGAL 替换，改变原义）。实体字符串本身不含非法字符，故原样保留。
    expect(sanitizeFilename('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
    expect(sanitizeFilename('a&lt;b')).toBe('a&lt;b');
  });

  it('#329: 判长与截断同用 code point 口径（astral 密集输入不再超长）', () => {
    // 60 个 emoji = 120 UTF-16 code units：按 s.length 判长会进入截断分支，
    // 但 code point 截断又全保留，结果仍 120 units 超过 maxLength。
    const emojis = '😀'.repeat(60);
    expect(emojis.length).toBe(120);
    const out = sanitizeFilename(emojis, { maxLength: 50 });
    expect(Array.from(out).length).toBeLessThanOrEqual(50);
  });

  it('#331: 不可见/双向格式字符被删除（RLO 文件名欺骗向量）', () => {
    expect(sanitizeFilename('a\u200Bb')).toBe('ab'); // ZWSP
    expect(sanitizeFilename('x\u202Etxt.exe')).toBe('xtxt.exe'); // RLO（双向覆盖）
    expect(sanitizeFilename('a\u2028b\u2029c')).toBe('abc'); // 行/段分隔符
    expect(sanitizeFilename('a\u2060b')).toBe('ab'); // 词连接符
  });
});
