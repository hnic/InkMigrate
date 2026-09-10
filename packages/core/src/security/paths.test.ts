import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveWithin,
  isPathInside,
  rejectsTraversal,
  assertSymlinkSafe,
  assertWriteDirSafe,
} from './paths.js';
import { mkdtempSync, symlinkSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
    it('R3-T3/H-2: 同路径大小写变体不误判为逃逸（大小写不敏感 FS 兼容）', () => {
      // H-2 修复：realpath 后统一 toLowerCase 比较，避免 APFS/NTFS 上
      // 配置路径与磁盘存储大小写不符时 isPathInside 误判逃逸。
      // 在大小写敏感 FS（Linux/CI）上，root 和 realFile 同大小写 → 不抛。
      const realFile = join(root, 'Note.md');
      writeFileSync(realFile, 'x');
      // 同路径（realpath 一致）不应抛——无论 FS 大小写敏感性
      expect(() => assertSymlinkSafe(root, realFile)).not.toThrow();
    });
  });

  describe('assertWriteDirSafe（悬空符号链接逃逸）', () => {
    it('root 内的普通悬空链接（目标也在 root 内）不抛', () => {
      mkdirSync(join(root, 'sub'), { recursive: true });
      // 链接文件 root/sub/f → g.txt（不存在 → 悬空，目标仍在 root/sub 内）
      symlinkSync('g.txt', join(root, 'sub', 'f.md'));
      expect(() => assertWriteDirSafe(root, join(root, 'sub', 'f.md'))).not.toThrow();
    });

    it('#344: 父目录链含指向 root 自身的符号链接时，按词法父目录解析会放行逃逸', () => {
      // root/c → root（自身）；悬空链接 root/c/f 的内容 '../evil'：
      // 词法父目录 root/c + '../evil' = root/evil「在内」；但内核把链接内容
      // 相对【解引用后的真实父目录】root 解析 → /<tmpdir>/evil，在 root 外。
      symlinkSync(root, join(root, 'c'));
      // 经 root/c 创建实际落在 root/f（c 解引用为 root）
      symlinkSync('../evil', join(root, 'c', 'f.md'));
      expect(() => assertWriteDirSafe(root, join(root, 'c', 'f.md'))).toThrow(
        /dangling symlink.*outside/,
      );
    });

    it('#345: 链接目标内含指向 root 外的目录符号链接时拒绝', () => {
      // root/shortcut → outsideRoot；悬空链接 root/d/f → ../shortcut/evil：
      // 词法目标 root/shortcut/evil「在内」，内核沿 shortcut 写到 outsideRoot/evil。
      mkdirSync(join(root, 'd'), { recursive: true });
      symlinkSync(outsideRoot, join(root, 'shortcut'));
      symlinkSync('../shortcut/evil.md', join(root, 'd', 'f.md'));
      expect(() => assertWriteDirSafe(root, join(root, 'd', 'f.md'))).toThrow(
        /dangling symlink.*outside/,
      );
    });

    it('#345: root 经符号链接配置时不误判合法悬空链接为逃逸', () => {
      // rootLink → root；写入路径走 rootLink/... 而判龄基准是 realpath(root)。
      mkdirSync(join(root, 'sub'), { recursive: true });
      symlinkSync('g.txt', join(root, 'sub', 'f.md'));
      const rootLink = join(root, 'rootlink');
      symlinkSync(root, rootLink);
      expect(() =>
        assertWriteDirSafe(rootLink, join(rootLink, 'sub', 'f.md')),
      ).not.toThrow();
    });
  });
});
