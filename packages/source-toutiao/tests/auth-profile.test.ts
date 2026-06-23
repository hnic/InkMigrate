import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { profilePath, profileExists, ensureProfileDir } from '../src/auth/profile.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('profile paths (§12.2)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'profile-'));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it('profilePath puts profile under stateDir/profiles/<sourceId>', () => {
    const p = profilePath(stateDir, 'toutiao-main');
    expect(p).toBe(join(stateDir, 'profiles', 'toutiao-main'));
  });

  it('profileExists returns false for non-existent profile', () => {
    expect(profileExists(stateDir, 'never')).toBe(false);
  });

  it('ensureProfileDir creates the directory idempotently', () => {
    const p = ensureProfileDir(stateDir, 'main');
    expect(existsSync(p)).toBe(true);
    // 第二次调用不抛
    expect(() => ensureProfileDir(stateDir, 'main')).not.toThrow();
  });

  it('profilePath rejects sourceId containing path traversal', () => {
    expect(() => profilePath(stateDir, '../escape')).toThrow(/traversal|escape/i);
  });

  it('profilePath rejects sourceId with slashes', () => {
    expect(() => profilePath(stateDir, 'a/b')).toThrow(/flat|traversal|separator/i);
  });
});
