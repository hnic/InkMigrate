# TOCTOU 路径安全加固设计

## 背景

`packages/core/src/security/paths.ts` 的 `assertWriteDirSafe` / `assertSymlinkSafe`
通过 `realpathSync` 校验目标路径解引用后仍在 Vault 内。但 realpathSync 校验与
后续 write/rename 是**两次独立的系统调用**，存在理论上的 TOCTOU（Time-of-Check
to Time-of-Use）窗口。

H4 已诚实化注释说明此残留窗口。本文档描述完全闭合该窗口的技术方案。

## 当前威胁模型

- **InkMigrate 是本地单用户工具**。攻击者需在同一机器具备写 Vault 目录的能力，
  并能赢得毫秒级竞争窗口（在 realpathSync 返回后、writeFileSync/renameSync 前
  把父目录链中的某级替换为指向 Vault 外的符号链接）。
- 实际风险**极低**，但当前实现「注释声称的防御强度高于实际」（H4 的核心批评）。

## 完全闭合方案：fd-based 写入（O_NOFOLLOW 逐组件）

核心思想：**持有文件描述符（fd）后再写**，而非按路径写。fd 一旦打开，不再受路径
上的符号链接替换影响。

### 实现步骤（伪代码）

```c
// 1. 从 Vault root 开始，逐组件打开（O_NOFOLLOW 拒绝 symlink 末端）
int fd = open(vaultRoot, O_RDONLY | O_DIRECTORY);
for (const seg of pathSegments(targetPath)) {
  fd = openat(fd, seg, O_NOFOLLOW | O_RDONLY | O_DIRECTORY);
  // 若 seg 是 symlink，openat 返回 ELOOP → 拒绝
}
// 2. 在最终目录创建临时文件（O_CREAT|O_EXCL|O_NOFOLLOW）
int tmpFd = openat(dirFd, tmpName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
write(tmpFd, content);
fsync(tmpFd);             // 耐久性（顺带闭合 R17）
// 3. 原子 rename（renameat2 with RENAME_EXCHANGE 或 renameat）
renameat(dirFd, tmpName, dirFd, finalName);
close(tmpFd); close(dirFd);
```

### Node.js 层面的障碍

- Node.js 的 `fs.openSync` **不支持 `O_DIRECTORY`**（截至 Node 24），且 `openat`
  的 dirfd 语义未完整暴露。
- `fs.openSync(path, 'wx')` 用 O_CREAT|O_EXCL 但**不带 O_NOFOLLOW**——无法拒绝
  path 末端是 symlink 的情况。
- 因此**纯 Node.js 层面无法完全闭合 TOCTOU**，需要 native addon。

### Native addon 方案

1. **N-API addon**（推荐）：用 `node-addon-api` 封装上述 C 逻辑为
   `safeWriteAt(vaultRootFd, relativePath, content)`。
   - 优点：跨平台（Linux/macOS/Windows）、ABI 稳定。
   - 依赖：需编译，增加构建复杂度（better-sqlite3 已是 native，模式成熟）。
2. **复用 better-sqlite3 的 loadExtension**：不适用（语义不符）。
3. **外部 CLI（如 BSD `unveil`/Linux `openat2`）**：不可移植。

### 加固范围

需替换的写入点（都应改用 safeWriteAt）：
- `packages/target-obsidian/src/atomic-write.ts` — `atomicWriteRaw`（笔记/索引）
- `packages/target-obsidian/src/assets.ts` — `writeAsset`（附件，经 atomicWriteRaw）
- `packages/core/src/runtime/locks.ts` — 锁文件心跳写入

### 收益评估

| 维度 | 现状 | 加固后 |
|------|------|--------|
| 攻击门槛 | 本地竞争窗口（毫秒级） | 不可绕过（fd 持有） |
| 实现成本 | — | native addon + 三处改写 + CI 编译 |
| 维护成本 | — | addon 跨平台构建（与 better-sqlite3 同等） |

## 建议

**暂不实施**，原因：
1. 威胁模型下实际风险极低（单用户本地工具）。
2. native addon 显著增加构建/维护复杂度，收益与成本不匹配。
3. 当前 realpathSync + randomBytes tmp 命名已提供合理的纵深防御。

**触发条件**：若 InkMigrate 未来支持多用户/多租户场景，或部署在共享服务器上，
应实施本方案。届时优先评估 N-API addon 路线。

## 相关代码

- `packages/core/src/security/paths.ts:assertWriteDirSafe` / `assertSymlinkSafe`
- `packages/target-obsidian/src/atomic-write.ts:atomicWriteRaw`
- H4 提交（注释诚实化）
