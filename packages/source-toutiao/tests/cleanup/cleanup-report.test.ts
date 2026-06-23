import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateCleanupReport } from '../../src/cleanup/cleanup-report.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('generateCleanupReport (§14.15)', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cr-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('generates summary + CSVs', () => {
    generateCleanupReport({
      reportsDir: dir, cleanupJobId: 'cj1', planCount: 87, processedCount: 85,
      successCount: 80, alreadyUnfavoritedCount: 3, skippedCount: 2, failedCount: 0,
      unknownCount: 0, loginPauseCount: 1,
      items: [
        { sourceItemId: 1, title: 't1', preState: 'favorited', actionStatus: 'unfavorited_verified', postState: 'not_favorited' },
        { sourceItemId: 2, title: 't2', preState: 'not_favorited', actionStatus: 'already_unfavorited', postState: 'not_favorited' },
      ],
    });
    expect(existsSync(join(dir, 'cj1/summary.json'))).toBe(true);
    expect(existsSync(join(dir, 'cj1/success.csv'))).toBe(true);
    expect(existsSync(join(dir, 'cj1/skipped.csv'))).toBe(true);
    const json = JSON.parse(readFileSync(join(dir, 'cj1/summary.json'), 'utf8'));
    expect(json.success_count).toBe(80);
    expect(json.already_unfavorited_count).toBe(3);
  });
});
