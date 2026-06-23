import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeAsset,
  verifyAsset,
  deriveMimeExtension,
} from '../src/assets.js';

let vault: string;
beforeEach(() => (vault = mkdtempSync(join(tmpdir(), 'assets-vault-'))));
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('writeAsset (§13.7)', () => {
  it('writes bytes to the resolved absolute path and returns sha256', () => {
    const bytes = Buffer.from('fake-image-bytes');
    const result = writeAsset({
      vaultPath: vault,
      relativePath: 'Attachments/InkMigrate/toutiao-main/im-x/cover.webp',
      bytes,
    });
    expect(result.relativePath).toBe(
      'Attachments/InkMigrate/toutiao-main/im-x/cover.webp',
    );
    expect(result.writtenFileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.byteSize).toBe(bytes.length);
    expect(
      readFileSync(
        join(vault, 'Attachments/InkMigrate/toutiao-main/im-x/cover.webp'),
      ),
    ).toEqual(bytes);
  });

  it('creates parent directories', () => {
    writeAsset({
      vaultPath: vault,
      relativePath: 'a/b/c/d.webp',
      bytes: Buffer.from('x'),
    });
    expect(readFileSync(join(vault, 'a/b/c/d.webp'), 'utf8')).toBe('x');
  });

  it('overwrites existing asset (assets are content-addressed, not user-edited)', () => {
    const target = 'a/x.webp';
    writeAsset({ vaultPath: vault, relativePath: target, bytes: Buffer.from('old') });
    writeAsset({ vaultPath: vault, relativePath: target, bytes: Buffer.from('new') });
    expect(readFileSync(join(vault, target), 'utf8')).toBe('new');
  });
});

describe('verifyAsset (§13.7 写入后必须验证存在、非零字节、哈希)', () => {
  it('passes for a non-empty file with matching sha256', () => {
    const bytes = Buffer.from('abc');
    const result = writeAsset({
      vaultPath: vault,
      relativePath: 'a.webp',
      bytes,
    });
    expect(() =>
      verifyAsset({
        vaultPath: vault,
        relativePath: 'a.webp',
        expectedSha256: result.writtenFileHash,
      }),
    ).not.toThrow();
  });

  it('throws when file is missing', () => {
    expect(() =>
      verifyAsset({
        vaultPath: vault,
        relativePath: 'missing.webp',
        expectedSha256: 'sha256:x',
      }),
    ).toThrow(/missing|exist|ENOENT/i);
  });

  it('throws when file is zero bytes', () => {
    writeFileSync(join(vault, 'zero.webp'), '');
    expect(() =>
      verifyAsset({
        vaultPath: vault,
        relativePath: 'zero.webp',
        expectedSha256: 'sha256:whatever',
      }),
    ).toThrow(/empty|zero/i);
  });

  it('throws when sha256 does not match', () => {
    writeAsset({ vaultPath: vault, relativePath: 'a.webp', bytes: Buffer.from('abc') });
    expect(() =>
      verifyAsset({
        vaultPath: vault,
        relativePath: 'a.webp',
        expectedSha256: 'sha256:wrong',
      }),
    ).toThrow(/hash|mismatch/i);
  });
});

describe('deriveMimeExtension (§13.7)', () => {
  it('maps common image MIME types', () => {
    expect(deriveMimeExtension('image/webp')).toBe('webp');
    expect(deriveMimeExtension('image/jpeg')).toBe('jpg');
    expect(deriveMimeExtension('image/png')).toBe('png');
    expect(deriveMimeExtension('image/gif')).toBe('gif');
  });
  it('falls back to bin for unknown', () => {
    expect(deriveMimeExtension('application/octet-stream')).toBe('bin');
    expect(deriveMimeExtension('')).toBe('bin');
  });
});
