# InkMigrate（墨迁）

本地优先、可验证、可恢复、可审计的知识迁移工具包。通过可插拔的来源/目标适配器，将不同知识平台中的内容迁移为长期可控的开放文件。

> **数据安全**：数据处理、数据库、附件、认证状态全部保存在用户本地，默认不启用遥测，不调用外部 AI API。用户只能迁移其有权访问的数据，并需自行遵守来源平台服务条款、账号规则和适用法律。

## 状态

当前仓库处于 v1.0 阶段 2（Obsidian 目标适配器）。阶段 1（基础工程）与阶段 2 已完成；阶段 3 起将逐步交付今日头条来源适配器。完整需求见 `docs/InkMigrate_Product_and_Technical_Requirements_v1.4_zh-CN.md`。

## 环境要求

- Node.js ≥ 24
- pnpm ≥ 11
- macOS / Linux 上需要 Xcode Command Line Tools（`better-sqlite3` 原生编译需要）
- Windows 上需要 Visual Studio Build Tools

## 从零开始

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
pnpm -r run build
pnpm inkmigrate --help
pnpm inkmigrate --version
```

后续阶段的 `init` / `scan` / `migrate` / `cleanup` 命令将在对应阶段交付。

## 架构

Monorepo（pnpm workspace）：

- `packages/core` — 通用迁移核心：领域模型、状态机、SQLite 持久化（含 Foreign Keys、CHECK 约束和部分唯一索引）、适配器注册表与 API 版本检查、安全（三类哈希、日志脱敏、路径防护、文件名清理）、配置 Schema、运行时锁与信号处理。
- `packages/target-obsidian` — Obsidian 目标适配器：把标准 `SourceItem` 渲染为 Vault 中的 Markdown 笔记，实现 §13 全部 v1.0 要求（目录结构、YAML Properties、正文模板、附件写入、原子写入、三类哈希、四策略用户修改保护）。
- `packages/testkit` — 适配器契约测试套件（§24.2）。
- `apps/cli` — `inkmigrate` 命令行入口。

## 许可

见 `LICENSE`。
