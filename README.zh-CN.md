# InkMigrate（墨迁）

本地优先、可验证、可恢复、可审计的知识迁移工具包。通过可插拔的来源/目标适配器，将不同知识平台中的内容迁移为长期可控的开放文件。

> **数据安全**：数据处理、数据库、附件、认证状态全部保存在用户本地，默认不启用遥测，不调用外部 AI API。用户只能迁移其有权访问的数据，并需自行遵守来源平台服务条款、账号规则和适用法律。

## 状态

v1.0 已完成端到端验证：登录 → 扫描 → 迁移 → 取消收藏 → 断点续跑，全链路通过。完整需求见 `docs/InkMigrate_Product_and_Technical_Requirements_v1.4_zh-CN.md`。

## 环境要求

- Node.js ≥ 24（需要 `node:sqlite` 支持）
- pnpm ≥ 11
- macOS / Linux 上需要 Xcode Command Line Tools（`better-sqlite3` 原生编译需要）
- Windows 上需要 Visual Studio Build Tools

## 安装

```bash
# 克隆仓库
git clone <repo-url> InkMigrate
cd InkMigrate

# 安装依赖（会自动编译 better-sqlite3 原生模块）
pnpm install

# 安装 Playwright Chromium（浏览器自动化需要）
pnpm --filter @inkmigrate/source-toutiao exec playwright install chromium

# 构建所有包
pnpm -r build

# 注册全局命令（可选，方便在任意目录使用）
ln -sf $(pwd)/apps/cli/dist/index.js ~/.local/bin/inkmigrate
```

验证安装：

```bash
inkmigrate --version
inkmigrate --help
```

## 使用

### 1. 初始化工作区

```bash
mkdir ~/inkmigrate-workspace && cd ~/inkmigrate-workspace
inkmigrate init
```

### 2. 登录头条

```bash
inkmigrate auth login --source toutiao-main --state-dir .inkmigrate
```

浏览器会自动打开，扫码或验证码登录。登录成功后 Profile 自动保存，后续命令复用，不需要重新登录。

### 3. 扫描收藏

```bash
inkmigrate scan \
  --source toutiao-main \
  --state-dir .inkmigrate \
  --favorites-url "你的收藏页URL"
```

> 收藏页 URL 格式：`https://www.toutiao.com/c/user/token/<TOKEN>/?tab=fav`
> 获取方式：登录后在浏览器中打开自己的收藏页，复制地址栏 URL。

扫描完成后生成 `.inkmigrate/scan-report.json`。

### 4. 迁移到 Obsidian

```bash
inkmigrate migrate \
  --source toutiao-main \
  --target obsidian-main \
  --state-dir .inkmigrate \
  --vault-path "/path/to/your/Obsidian/Vault" \
  --favorites-url "你的收藏页URL"
```

可选参数：
- `--max-items <n>` — 限制迁移条目数（测试用）
- `--interval <ms>` — 条目间请求间隔毫秒数（默认 1500，防风控）

笔记直接写入 Vault 根目录，格式为 `文章标题.md`。

### 5. 断点续跑

如果迁移中途中断（Ctrl+C 或网络故障），用 `resume` 续跑，自动跳过已完成的条目：

```bash
inkmigrate resume \
  --job <原Job-ID> \
  --state-dir .inkmigrate \
  --vault-path "/path/to/your/Obsidian/Vault" \
  --favorites-url "你的收藏页URL"
```

### 6. 取消收藏（清理源端）

迁移完成后，可选地取消头条上的收藏：

```bash
inkmigrate cleanup unfavorite \
  --source toutiao-main \
  --state-dir .inkmigrate \
  --max-items 10
```

逐条打开文章详情页，点击"已收藏"按钮取消收藏。

### 7. 清除登录状态

```bash
inkmigrate auth clear --source toutiao-main --state-dir .inkmigrate
```

删除工具专用 Profile（只删除该来源的 Profile，不影响浏览器日常使用）。

## Evernote / 印象笔记迁移

支持 **ENEX 导出文件**和 **HTML 导出目录**两种输入（印象笔记中国版新版客户端只能导出 HTML，是受支持的一等路径）。不需要登录，不接触账号凭据。

### 1. 导出数据

- **国际版 Evernote**：桌面客户端导出 ENEX（每个笔记本一个 `.enex` 文件）。
- **印象笔记（中国版）**：新版客户端只能导出专有加密的 `.notes`（不受支持，会显式报错）——请改用以下任一方式：
  - 客户端导出 **HTML**（当前唯一开放的导出格式）；
  - 用开源工具 [evernote-backup](https://github.com/vzhd1701/evernote-backup) 同步后导出 ENEX（**推荐加 `--add-guid --add-metadata`**，可解锁笔记间内部链接重写）：
    ```bash
    evernote-backup init-db --backend china   # 交互输入账号密码
    evernote-backup sync                       # 可中断续传
    evernote-backup export --add-guid --add-metadata enex_out/
    ```

### 2. 配置 inkmigrate.yaml

```yaml
version: 1
workspace:
  stateDir: ".inkmigrate"
  reportsDir: "reports"
sources:
  - id: "evernote-archive"
    adapter: "evernote"
    enabled: true
    config:
      inputPaths: ["imports/evernote"]   # ENEX 文件/目录 或 HTML 导出目录，可混用
      formats: ["enex", "html"]
      stackSeparator: "@@@"
targets:
  - id: "my-vault"
    adapter: "obsidian"
    enabled: true
    config: { vaultPath: "/path/to/vault" }
```

多笔记本（`Stack@@@Notebook.enex` 命名或 HTML 目录层级）会按 `Stack/笔记本-短ID/` 结构落盘；同名笔记本自动加哈希后缀不合并。

### 3. 预览并迁移

```bash
# 预览：条目数与笔记本分布（不写库）
inkmigrate scan --source evernote-archive --state-dir .inkmigrate

# 迁移（中断后可 resume 续跑）
inkmigrate migrate --source evernote-archive --target my-vault \
  --state-dir .inkmigrate --vault-path "/path/to/vault"
```

特性：附件按原文件名保留（缺失时序号命名）、网页剪藏远程图片可配置下载、加密块以占位符保留（不破解）、带 GUID 的导出会把笔记间链接重写为 Obsidian 双链、每条笔记输出资源对账计数。

## 命令一览

| 命令 | 说明 |
|---|---|
| `inkmigrate init` | 初始化工作区，生成配置文件 |
| `inkmigrate auth login` | 打开浏览器登录头条 |
| `inkmigrate auth clear` | 清除登录 Profile |
| `inkmigrate scan` | 扫描收藏列表 |
| `inkmigrate migrate` | 迁移到 Obsidian |
| `inkmigrate resume` | 断点续跑中断的迁移 |
| `inkmigrate status` | 查询 Job 状态 |
| `inkmigrate report` | 查看迁移报告 |
| `inkmigrate cleanup unfavorite` | 取消头条收藏 |
| `inkmigrate doctor` | 环境检查 |
| `inkmigrate diagnostics` | 数据库诊断 |
| `inkmigrate config validate` | 校验配置文件 |
| `inkmigrate source list/add/validate` | 来源管理 |
| `inkmigrate target list/add/validate` | 目标管理 |

## 笔记格式

迁移后的笔记为 Markdown 格式：

```markdown
---
title: 文章标题
source_url: https://www.toutiao.com/article/xxxxx/
---

> [!info] 来源信息
> - 来源：今日头条
> - 作者：作者名
> - 发布时间：2026-06-22 06:47
> - 收藏时间：2026-06-24 10:30（如有）
> - [打开原文](https://www.toutiao.com/article/xxxxx/)

正文内容...
```

- 正文保留语义结构（标题、加粗、列表、图片链接），不保留字体大小和颜色
- 图片保留远程 URL，不下载到本地
- 标题相同时自动追加序号后缀（`标题-2.md`）
- 已迁移的条目有幂等保护，重复运行不会重复写入

## 桌面 GUI（开发中）

除 CLI 外，项目还包含一个基于 Tauri 2 + React 的桌面 GUI 应用，提供可视化操作界面：

```bash
cd apps/gui
INKMIGRATE_ENGINE_PATH=$(pwd)/../engine/dist/index.js pnpm exec tauri dev
```

GUI 特性：
- 侧边栏步骤引导（① 登录 → ② 扫描 → ③ 迁移 → ④ 清理）
- 登录后自动获取收藏页 URL，无需手动填写
- 实时进度条（发现数量、verified/degraded/failed 计数）
- 断点续跑（输入中断的 Job ID 继续）
- 清理操作二次确认
- 全局登录状态指示

## 架构

Monorepo（pnpm workspace）：

- `packages/core` — 通用迁移核心：领域模型、状态机、SQLite 持久化（WAL + Foreign Keys + CHECK 约束 + 部分唯一索引）、适配器注册表与 API 版本检查、安全（三类哈希、日志脱敏、路径防护、文件名清理）、配置 Schema、运行时锁与信号处理、重试与速率控制。
- `packages/target-obsidian` — Obsidian 目标适配器：把标准 `SourceItem` 渲染为 Vault 中的 Markdown 笔记（§13 全部 v1.0 要求）。
- `packages/source-toutiao` — 今日头条来源适配器：Playwright 浏览器 Profile 登录、收藏页增量扫描、详情提取、固定 9 阶段 HTML→Markdown 安全流水线、取消收藏。
- `packages/testkit` — 适配器契约测试套件。
- `apps/cli` — `inkmigrate` 命令行入口。
- `apps/engine` — Node sidecar 进程，封装 JSON-RPC over stdio 协议，为 GUI 提供核心能力。
- `apps/gui` — Tauri 2 + React 桌面 GUI 应用。

## 测试

```bash
# 默认测试套件（600+ 测试，不需要浏览器）
pnpm test

# 浏览器测试套件（10 测试，需要 Playwright Chromium）
pnpm --filter @inkmigrate/source-toutiao test:browser

# 类型检查
pnpm -r typecheck
```

## 许可

见 `LICENSE`。
