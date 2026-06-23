import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/atomic-write.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'atomic-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('atomicWrite (§13.10)', () => {
  it('writes content to target path after validation', () => {
    const target = join(dir, 'note.md');
    atomicWrite(target, '---\ntitle: x\n---\n# x\n');
    expect(readFileSync(target, 'utf8')).toBe('---\ntitle: x\n---\n# x\n');
  });

  it('creates parent directories if missing', () => {
    const target = join(dir, 'a/b/c/note.md');
    atomicWrite(target, '---\ntitle: x\n---\n# x\n');
    expect(existsSync(target)).toBe(true);
  });

  it('leaves no temp file behind on success', () => {
    const target = join(dir, 'note.md');
    atomicWrite(target, '---\ntitle: x\n---\n# x\n');
    expect(readdirSync(dir)).toEqual(['note.md']);
  });

  it('rejects content that is not valid frontmatter+markdown (no --- delimiter)', () => {
    const target = join(dir, 'note.md');
    expect(() =>
      atomicWrite(target, 'just plain text, no frontmatter'),
    ).toThrow(/frontmatter|delimiter/i);
    expect(existsSync(target)).toBe(false);
  });

  it('rejects empty content', () => {
    const target = join(dir, 'note.md');
    expect(() => atomicWrite(target, '')).toThrow(/empty/);
    expect(existsSync(target)).toBe(false);
  });

  it('does not overwrite existing target if validation fails', () => {
    const target = join(dir, 'note.md');
    writeFileSync(target, 'ORIGINAL');
    expect(() => atomicWrite(target, '')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL');
  });

  it('cleans up temp file on validation failure (no .tmp residue)', () => {
    const target = join(dir, 'note.md');
    expect(() => atomicWrite(target, 'no frontmatter')).toThrow();
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('rejects target path that escapes vault via symlink (§13.2)', () => {
    // 建一个 vault 外的真实文件，然后在 vault 内放一个指向它的符号链接
    const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      const outsideFile = join(outsideDir, 'secret.md');
      writeFileSync(outsideFile, '---\nx: 1\n---\n# secret\n');
      const linkInsideVault = join(dir, 'link.md');
      symlinkSync(outsideFile, linkInsideVault);
      // atomicWrite 应该拒绝：符号链接解引用后逃出 vault
      expect(() =>
        atomicWrite(
          linkInsideVault,
          '---\ntitle: x\n---\n# x\n',
          dir,
        ),
      ).toThrow(/symlink|escape/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
