import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkDiskSpace, formatBackupWarning } from '../../src/runtime/preflight-checks.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('checkDiskSpace (§11.2)', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'disk-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes when disk has more than minFreeDiskBytes available', () => {
    expect(() => checkDiskSpace(dir, 1)).not.toThrow();
  });

  it('throws when required space exceeds available', () => {
    expect(() => checkDiskSpace(dir, 1024 ** 6)).toThrow(/disk|space|insufficient/i);
  });
});

describe('formatBackupWarning (§6.2)', () => {
  it('returns a warning string mentioning backup', () => {
    const msg = formatBackupWarning('/path/to/vault');
    expect(msg).toContain('备份');
    expect(msg).toContain('/path/to/vault');
  });
});
