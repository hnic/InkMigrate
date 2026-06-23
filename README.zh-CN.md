# InkMigrate（墨迁）

本地优先、可验证、可恢复、可审计的知识迁移工具包。通过可插拔的来源/目标适配器，将不同知识平台中的内容迁移为长期可控的开放文件。

> **数据安全**：数据处理、数据库、附件、认证状态全部保存在用户本地，默认不启用遥测，不调用外部 AI API。用户只能迁移其有权访问的数据，并需自行遵守来源平台服务条款、账号规则和适用法律。

## 状态

当前仓库处于 v1.1 阶段 5（索引与增强诊断）。v1.0 阶段 1-4 全部完成（v1.0-rc1）。阶段 5 交付 Obsidian 分片索引、页面选择器诊断、脱敏 HTML/截图、磁盘预估和备份提示。阶段 6（源端清理）后续单独交付。完整需求见 `docs/InkMigrate_Product_and_Technical_Requirements_v1.4_zh-CN.md`。

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
- `packages/source-toutiao` — 今日头条只读来源适配器：浏览器 Profile 登录、收藏页扫描（DOM + 网络响应观察）、详情提取四策略、固定 9 阶段 HTML→Markdown 安全流水线、图片下载。通过 8 个脱敏 fixture 驱动测试（§24.3）；真实账号 E2E 是发布前人工 Gate。
- `packages/testkit` — 适配器契约测试套件（§24.2）。
- `apps/cli` — `inkmigrate` 命令行入口。

## 许可

见 `LICENSE`。
