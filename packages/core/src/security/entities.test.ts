import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities } from './entities.js';

describe('decodeHtmlEntities (§13.6)', () => {
  it('decodes quot to double quote', () => {
    expect(decodeHtmlEntities('foo &quot;bar&quot;')).toBe('foo "bar"');
  });

  it('decodes #39 and apos to single quote', () => {
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
  });

  it('decodes nbsp to space', () => {
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
  });

  it('does NOT decode lt/gt (would bypass HTML sanitization)', () => {
    expect(decodeHtmlEntities('&lt;b&gt;')).toBe('&lt;b&gt;');
  });

  it('decodes amp without double-decoding (single pass)', () => {
    // &amp;quot; 的原义是字面字符串 "&quot;"，不应被进一步解码成 "
    expect(decodeHtmlEntities('&amp;quot;')).toBe('&quot;');
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
  });

  it('decodes mixed entities in one pass', () => {
    expect(decodeHtmlEntities('Tom &quot;Jerry&quot; &amp; &#39;Friends&apos;')).toBe(
      'Tom "Jerry" & \'Friends\'',
    );
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeHtmlEntities('&copy; &trade;')).toBe('&copy; &trade;');
  });

  it('handles empty string', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });

  it('leaves plain text untouched', () => {
    expect(decodeHtmlEntities('just plain text 中文')).toBe('just plain text 中文');
  });
});
