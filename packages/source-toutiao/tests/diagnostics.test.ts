import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveDiagnostics } from '../src/diagnostics/diagnostics.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('saveDiagnostics (§19.5)', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'diag-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves error.json with structured fields', () => {
    saveDiagnostics({
      diagnosticsDir: dir, jobId: 'j1', itemKey: 'im-abc123',
      stage: 'extracting',
      attemptedSelectors: ['[data-testid="article-detail"]', 'article', '.content'],
      pageUrl: 'https://www.toutiao.com/article/123/',
      pageTitle: '测试文章', loginState: 'logged-in',
      securityChallenge: false, generatedDegradedNote: true,
      html: '<p>some content</p><script>cookie: session=abc</script>',
      errorCode: 'EXTRACT_FAILED',
      errorMessage: 'No content extracted after all strategies',
    });
    const e = JSON.parse(readFileSync(join(dir, 'j1/im-abc123/error.json'), 'utf8'));
    expect(e.stage).toBe('extracting');
    expect(e.errorCode).toBe('EXTRACT_FAILED');
    expect(e.attemptedSelectors).toHaveLength(3);
    expect(e.generatedDegradedNote).toBe(true);
  });

  it('saves sanitized.html with sensitive data removed', () => {
    saveDiagnostics({
      diagnosticsDir: dir, jobId: 'j1', itemKey: 'im-abc123', stage: 'extracting',
      html: '<p>content</p><script>cookie: session=secret123; token=xyz</script>',
    });
    const html = readFileSync(join(dir, 'j1/im-abc123/sanitized.html'), 'utf8');
    expect(html).not.toContain('secret123');
    expect(html).not.toContain('token=xyz');
    expect(html).not.toContain('<script');
  });

  it('does not save screenshot when not provided', () => {
    saveDiagnostics({ diagnosticsDir: dir, jobId: 'j1', itemKey: 'im-abc123', stage: 'extracting' });
    expect(existsSync(join(dir, 'j1/im-abc123/screenshot.png'))).toBe(false);
  });

  it('saves screenshot when provided', () => {
    saveDiagnostics({
      diagnosticsDir: dir, jobId: 'j1', itemKey: 'im-abc123', stage: 'extracting',
      screenshotBuffer: Buffer.from('fake-png'),
    });
    expect(existsSync(join(dir, 'j1/im-abc123/screenshot.png'))).toBe(true);
  });
});
