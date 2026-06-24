import { describe, it, expect } from 'vitest';
import { createToutiaoSource } from '../src/index.js';

describe('createToutiaoSource dual-mode factory', () => {
  it('without config: scan is empty generator, extract throws', async () => {
    const source = createToutiaoSource();

    const refs: unknown[] = [];
    for await (const ref of source.scan({ config: {}, workspaceDir: '.' })) {
      refs.push(ref);
    }
    expect(refs.length).toBe(0);

    await expect(
      source.extract(
        {
          sourceInstanceId: 'test',
          contentKind: 'article',
          discoveredAt: '2026-01-01T00:00:00Z',
          fingerprint: 'sha256:x',
          sourceMetadata: {},
        },
        { config: {}, workspaceDir: '.' },
      ),
    ).rejects.toThrow('browser session');
  });

  it('without config: prepare and close are safe no-ops', async () => {
    const source = createToutiaoSource();
    await source.prepare({ config: {}, workspaceDir: '.' });
    await source.close();
  });

  it('with config: does not throw on construction', () => {
    // Construction should not launch the browser (only prepare does)
    const source = createToutiaoSource({
      sourceInstanceId: 'test',
      profileDir: '/tmp/test-profile',
      headless: true,
    });
    expect(source.kind).toBe('toutiao');
    expect(source.capabilities.authMode).toBe('browser-profile');
  });
});
