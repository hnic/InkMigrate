import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveWithin,
  isPathInside,
  rejectsTraversal,
  assertSymlinkSafe,
} from './paths.js';
import { mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let outsideRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'paths-root-'));
  outsideRoot = mkdtempSync(join(tmpdir(), 'paths-outside-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe('paths (§13.2)', () => {
  describe('rejectsTraversal', () => {
    it('flags literal .. segments', () => {
      expect(rejectsTraversal('../x')).toBe(true);
      expect(rejectsTraversal('a/../b')).toBe(true);
      expect(rejectsTraversal('a/b/../../c')).toBe(true);
    });
    it('flags backslash-style traversal', () => {
      expect(rejectsTraversal('..\\x')).toBe(true);
      expect(rejectsTraversal('a\\..\\b')).toBe(true);
    });
    it('passes clean relative paths', () => {
      expect(rejectsTraversal('a/b')).toBe(false);
      expect(rejectsTraversal('a/b/c.md')).toBe(false);
      expect(rejectsTraversal('笔记/分类')).toBe(false);
    });
    it('does not false-positive on substrings containing ..', () => {
      expect(rejectsTraversal('a..b')).toBe(false);
      expect(rejectsTraversal('foo..bar.md')).toBe(false);
    });
  });

  describe('resolveWithin', () => {
    it('resolves a clean relative target inside root', () => {
      const p = resolveWithin(root, 'notes/a.md');
      expect(p).toBe(join(root, 'notes', 'a.md'));
    });
    it('resolves an absolute target inside root', () => {
      const p = resolveWithin(root, join(root, 'b.md'));
      expect(p).toBe(join(root, 'b.md'));
    });
    it('rejects traversal escape via ..', () => {
      expect(() => resolveWithin(root, '../etc/passwd')).toThrow(/escape/);
      expect(() => resolveWithin(root, 'a/../../etc')).toThrow(/escape/);
    });
    it('rejects absolute target outside root', () => {
      expect(() => resolveWithin(root, outsideRoot)).toThrow(/escape/);
    });
  });

  describe('isPathInside', () => {
    it('returns true for nested child', () => {
      expect(isPathInside(join(root, 'a'), root)).toBe(true);
      expect(isPathInside(join(root, 'a', 'b.md'), root)).toBe(true);
    });
    it('returns false for sibling or outside', () => {
      expect(isPathInside(outsideRoot, root)).toBe(false);
      expect(isPathInside(root, join(root, 'a'))).toBe(false);
    });
  });

  describe('assertSymlinkSafe (§13.2 符号链接逃逸)', () => {
    it('passes when target resolves inside root', () => {
      const realFile = join(root, 'inside.md');
      writeFileSync(realFile, 'x');
      // create symlink inside root pointing to inside.md
      const link = join(root, 'link.md');
      symlinkSync(realFile, link);
      expect(() => assertSymlinkSafe(root, link)).not.toThrow();
    });
    it('rejects symlink that escapes root', () => {
      const outsideFile = join(outsideRoot, 'secret.md');
      writeFileSync(outsideFile, 'x');
      const link = join(root, 'escape.md');
      symlinkSync(outsideFile, link);
      expect(() => assertSymlinkSafe(root, link)).toThrow(/symlink|escape/i);
    });
    it('rejects when target does not exist', () => {
      expect(() => assertSymlinkSafe(root, join(root, 'missing.md'))).toThrow();
    });
  });
});
