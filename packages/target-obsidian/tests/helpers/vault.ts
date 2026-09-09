import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

/** 创建一个临时 Vault 目录，可选模拟 `.obsidian` 标记。 */
export function makeTempVault(
  opts: { withObsidianDir?: boolean } = {},
): {
  vaultPath: string;
  cleanup: () => void;
} {
  const vaultPath = mkdtempSync(join(tmpdir(), 'inkmigrate-vault-'));
  if (opts.withObsidianDir) {
    mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
  }
  return {
    vaultPath,
    // Windows 上句柄延迟释放常使 rmSync 抛 EPERM/EBUSY，重试避免清理抖动
    cleanup: () =>
      rmSync(vaultPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }),
  };
}

/** 在 Vault 内写入一个文件（测试用，模拟用户已有内容）。 */
export function writeVaultFile(
  vaultPath: string,
  relativePath: string,
  content: string | Buffer,
): void {
  const fullPath = join(vaultPath, relativePath);
  // 防御：join 会归一化 `..` 段，误写的 relativePath 会逃出临时 Vault，
  // 把测试文件写到 OS 临时目录之外的位置。
  if (relative(vaultPath, fullPath).startsWith('..')) {
    throw new Error(
      `writeVaultFile: relativePath escapes vault root: ${relativePath}`,
    );
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}
