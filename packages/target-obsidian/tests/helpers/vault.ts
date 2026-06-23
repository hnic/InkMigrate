import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    cleanup: () => rmSync(vaultPath, { recursive: true, force: true }),
  };
}

/** 在 Vault 内写入一个文件（测试用，模拟用户已有内容）。 */
export function writeVaultFile(
  vaultPath: string,
  relativePath: string,
  content: string | Buffer,
): void {
  const fullPath = join(vaultPath, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}
