import { statfsSync } from 'node:fs';

/**
 * §11.2 检查磁盘可用空间是否满足最低要求。
 * 在不支持的平台上静默通过。
 */
export function checkDiskSpace(path: string, minFreeDiskBytes: number): void {
  let available: number | undefined;
  try {
    const stats = statfsSync(path);
    available = stats.bavail * stats.bsize;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 仅在 statfs 确实不被本平台/文件系统支持（ENOSYS=未实现；
    // EOPNOTSUPP/ENOTSUP=不支持）时静默通过。EINVAL（参数无效）是歧义信号：
    // 更可能来自畸形路径或损坏的 statfs 绑定而非平台缺失，静默放行会让本该
    // 在预检暴露的磁盘问题拖到迁移中途以 ENOSPC 爆发——其余失败（ENOENT
    // 路径不存在、EACCES 无权限等）同理必须如实抛出。
    if (code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'ENOTSUP') return;
    throw new Error(
      `disk space check failed at "${path}": ${code ?? (error as Error).message}`,
    );
  }
  if (available < minFreeDiskBytes) {
    throw new Error(
      `insufficient disk space: ${formatBytes(available)} available, ` +
        `${formatBytes(minFreeDiskBytes)} required at "${path}"`,
    );
  }
}

/**
 * §6.2 格式化 Vault 备份提示。
 */
export function formatBackupWarning(vaultPath: string): string {
  return [
    `⚠️  迁移前请备份你的 Vault：${vaultPath}`,
    '   InkMigrate 会写入新文件但不会自动备份。',
    '   建议在迁移前创建 Vault 的完整副本或 Git 快照。',
  ].join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
