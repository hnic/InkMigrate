<div align="center">
  <img src="./docs/assets/logo.png" alt="InkMigrate Logo" width="120" height="120" style="border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.25);" />
  <h1 style="font-size: 2.2em; font-weight: 800; margin: 12px 0;">InkMigrate (墨迁)</h1>
  <p style="font-size: 1.2em; color: #4b5563; font-weight: 500;"><strong>把属于你的知识，还给自由的你。</strong></p>
  <p>本地优先 · 结构无损 · 可验证 · 可恢复 · 可审计 的下一代跨平台知识资产迁移引擎</p>

  <p>
    <a href="./README.en.md"><strong>English Documentation</strong></a> ·
    <a href="https://github.com/hnic/InkMigrate/releases/latest"><strong>下载最新 Release (v1.0.0)</strong></a> ·
    <a href="#-快速开始"><strong>快速开始</strong></a> ·
    <a href="#-核心亮点"><strong>核心亮点</strong></a> ·
    <a href="#-实战迁移场景"><strong>实战场景</strong></a>
  </p>

  <p>
    <a href="https://github.com/hnic/InkMigrate/releases"><img src="https://img.shields.io/badge/Release-v1.0.0-blue?style=for-the-badge&logo=github" alt="Release" /></a>
    <img src="https://img.shields.io/badge/Node.js-≥24.15-success?style=for-the-badge&logo=node.js" alt="Node.js" />
    <img src="https://img.shields.io/badge/Tauri-v2.0-orange?style=for-the-badge&logo=tauri" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react" alt="React 19" />
    <img src="https://img.shields.io/badge/Tests-600%2B%20Passing-brightgreen?style=for-the-badge&logo=vitest" alt="Tests" />
    <img src="https://img.shields.io/badge/Data%20Safety-100%25%20Local-purple?style=for-the-badge" alt="Local First" />
  </p>
</div>

---

## 💡 为什么需要 InkMigrate？

我们日常收藏在各大平台（今日头条、Evernote、印象笔记等）里的文章与笔记，正在无形中面临**数字遗失的危机**：
- 平台内容下架、账号风控或链接失效，珍藏多年的参考资料瞬间变为 `404`；
- 平台厂商采用专有加密格式锁死导出（如 `.notes`），想迁移时寸步难行；
- 传统的“复制粘贴”丢失元数据、作者信息、附件图片以及笔记间的关联跳转；
- 依赖第三方云端迁移工具？**你的隐私笔记可能在云端被二次索引甚至送入公共 AI 训练！**

**InkMigrate（墨迁）** 为彻底夺回个人知识资产主权而生：**100% 纯本地运行、零云端中转、无外部 AI 窃密隐患**，将散落在各大平台的碎片数据，结构化归档为你真正拥有的持久开放格式——**Obsidian 双链本地知识库**。

---

## 🌟 核心亮点

### 1. 🖥 现代化桌面 GUI (Tauri 2 + React 19)
告别繁琐的手动配置文件修改，享受极速、优雅的桌面端视觉交互：
- **系统原生文件选择器**：全面支持 macOS AppleScript、Windows PowerShell（自动解决 CP936 中文路径乱码）及 Linux 原生目录选择器，路径有效性实时动态探测。
- **异构来源智能解耦**：彻底解决离线文件源（Evernote / 印象笔记）因头条登录态未就绪导致的阻断 Bug，离线文件无需任何登录即可直接一键迁移。
- **可折叠状态栏抽屉 (LogPanel)**：默认仅占 36px 极简状态条，将 180px+ 核心视口完全释放给业务内容；支持一键展开、错误/警告级别过滤、日志秒级拷贝与清空。
- **资产扫描实时检索**：扫描条目以可视化明细表格呈现，支持实时模糊搜索，并可安全调用系统浏览器直达原文。
- **WCAG AA 级暗色美学**：精心调优的 Slate/Blue 暗黑调色板，全量 Lucide 矢量图标，杜绝系统 Emoji 样式割裂。

### 2. 🔌 丰富的知识源生态适配
- **今日头条 (Toutiao)**：
  - 基于真实浏览器会话（Playwright Chromium）全自动登录保持与收藏解析。
  - 支持文章、微头条、视频笔记全量抓取。
  - 智能反爬节奏控制与人性化防风控延迟（可自定义间隔）。
  - 迁移后支持一键自动化“取消收藏”，清理云端源头。
- **Evernote / 印象笔记 (Offline)**：
  - **无需账号凭据，零联网离线解析**。
  - 完整支持国际版 `.enex` 笔记本导出文件。
  - **独家深度支持**印象笔记国内版 HTML 导出目录无损还原。
  - 自动将 GUID 跨笔记关联解析转换为 Obsidian 原生 `[[Wikilinks]]` 双链网络！
  - 保留多层级笔记本嵌套（`Stack/Notebook-<hash>/`），附件哈希严格对账。

### 3. 🛡 企业级可靠性架构（绝不漏掉一篇，绝不损坏一篇）
- **确定性幂等保证**：任意时刻均可放心中断（Ctrl+C 或关闭应用）；再次启动或执行 `resume` 时，已落盘条目毫秒级校验跳过，仅增量补齐未完成条目。
- **双向完整对账审计**：每次迁移均生成完整的 SQLite 事务级状态库与结构化审计报告（`summary.json`、`details.json`、`failures.json`），每一条正文与每个附件皆有据可查。
- **进程隔离与 JSON-RPC 传输**：UI 界面与后台高性能数据引擎基于轻量级 stdio JSON-RPC 通信，大并发数据处理不阻塞 UI 渲染。

---

## 📑 迁移到 Obsidian 的笔记效果

InkMigrate 生成的笔记完全符合 Obsidian 最佳实践，保留纯净排版与丰富上下文：

```markdown
---
title: 深入解析现代微前端架构演进
source_url: https://www.toutiao.com/article/71234567890/
source_id: toutiao-main
author: 前端技术精选
published_at: 2026-05-18 09:20:00
migrated_at: 2026-09-11 20:30:00
migration_job_id: mig-20260911-102432
---

> [!info] 来源元数据
> - **原始来源**：今日头条 (toutiao-main)
> - **文章作者**：前端技术精选
> - **发布时间**：2026-05-18 09:20
> - **原文链接**：[点此在浏览器中阅读](https://www.toutiao.com/article/71234567890/)

## 摘要

在大型企业级前端系统演进过程中，模块解耦与独立发布已成为核心诉求...

### 核心设计原则
1. 运行时独立与样式沙箱隔离；
2. 共享依赖与版本降级策略；
3. 参考前序笔记：[[微前端基座与通信机制]]（Evernote 链接自动还原）

![架构示意图](attachments/71234567890_arch_diagram.png)
```

---

## 🚀 快速开始

### 准备环境

- **Node.js**：≥ 24.15.0（内置 `node:sqlite` 支持）
- **pnpm**：≥ 11
- **编译工具**：macOS 需安装 Xcode Command Line Tools，Windows 需安装 Visual Studio Build Tools（用于编译 SQLite 原生模块）。

### 安装依赖与构建

```bash
# 1. 克隆代码仓库
git clone https://github.com/hnic/InkMigrate.git
cd InkMigrate

# 2. 安装项目依赖（自动链接 monorepo 子包）
pnpm install

# 3. 安装自动化抓取所需的 Chromium 浏览器内核
pnpm --filter @inkmigrate/source-toutiao exec playwright install chromium

# 4. 全量编译
pnpm -r build
```

---

### 运行方式一：启动桌面 GUI（推荐日常使用）

```bash
pnpm --filter @inkmigrate/gui run tauri dev
```

启动后即可在现代化图形窗口中直观操作：
1. 顶栏切换所需知识来源（今日头条 / Evernote）；
2. 一键点击「选择目录」设置 Obsidian Vault 路径与工作区；
3. 点击「开始扫描」直观预览条目列表；
4. 点击「开始迁移」实时监控进度条与审计日志！

---

### 运行方式二：CLI 命令行（适合极客与自动化批处理）

可将 CLI 命令注册到本地环境：
```bash
ln -sf $(pwd)/apps/cli/dist/index.js ~/.local/bin/inkmigrate
```

#### 场景 A：从今日头条迁移收藏到 Obsidian

```bash
# 1. 初始化本地工作区
inkmigrate init

# 2. 扫码登录头条（弹窗扫码，Profile 自动持久化保存在本地）
inkmigrate auth login --source toutiao-main --state-dir .inkmigrate

# 3. 扫描收藏列表
inkmigrate scan \
  --source toutiao-main \
  --state-dir .inkmigrate \
  --favorites-url "https://www.toutiao.com/c/user/token/你的Token/?tab=fav"

# 4. 执行全量迁移到 Obsidian
inkmigrate migrate \
  --source toutiao-main \
  --target obsidian-main \
  --state-dir .inkmigrate \
  --vault-path "/Users/you/Documents/Obsidian Vault" \
  --favorites-url "https://www.toutiao.com/c/user/token/你的Token/?tab=fav"

# 5.（可选）中途如遇中断，输入 Job ID 随时无损续跑
inkmigrate resume \
  --job <原Job-ID> \
  --state-dir .inkmigrate \
  --vault-path "/Users/you/Documents/Obsidian Vault"
```

#### 场景 B：从 Evernote / 印象笔记离线导入

无需登录，直接在 `inkmigrate.yaml` 中声明本地导出路径：

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
      inputPaths: ["/Users/you/Documents/EvernoteExports"]  # 支持 .enex 文件或 HTML 导出目录
      formats: ["enex", "html"]
targets:
  - id: "obsidian-main"
    adapter: "obsidian"
    enabled: true
    config:
      vaultPath: "/Users/you/Documents/Obsidian Vault"
```

执行迁移：
```bash
inkmigrate migrate --source evernote-archive --target obsidian-main --state-dir .inkmigrate --vault-path "/Users/you/Documents/Obsidian Vault"
```

> **💡 印象笔记中国版用户特别提示**：
> 印象笔记新版客户端导出的 `.notes` 为加密私有格式，无法通用解析。建议：
> 1. 在客户端中导出为 **HTML 格式**（InkMigrate 完美支持多层级目录解析）；
> 2. 或使用开源工具 [evernote-backup](https://github.com/vzhd1701/evernote-backup) 执行备份后导出 ENEX（推荐附加 `--add-guid --add-metadata` 参数以保留双链关系）。

---

## 🛠 macOS 桌面端打包指南（构建 .app / .dmg）

InkMigrate 采用了 **Tauri 2 + Node.js Sidecar + 内嵌无头 Chromium** 的高内聚自包含架构。构建产出的 `.app` 与 `.dmg` 内部已包含 Node 运行时、原生 SQLite 驱动与离线爬虫引擎，在目标 macOS 电脑上无需配置开发环境即可开箱即用。

### 1. 准备构建环境
确保本机具备以下工具：
- **Node.js**：≥ 24.15.0
- **pnpm**：≥ 11
- **Rust / Cargo**：最新稳定版（`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）
- **Xcode Command Line Tools**：`xcode-select --install`

### 2. 一键执行全量打包

项目根目录已提供一键整合构建命令（包含前置依赖编译、Sidecar 二进制组装与 Tauri 打包流水线）：

```bash
# 全量构建：TypeScript 编译 + Sidecar 资源组装 + macOS 原生 App/DMG 封装
pnpm bundle
```

> **构建流水线说明**：
> - 底层自动执行 `scripts/build-sidecar.mjs`，通过 esbuild 把引擎打为自包含单文件，并自动提取当前平台适用的 `better_sqlite3.node` 与 Playwright 驱动注入到 Sidecar 资源包；
> - 最终调用 `tauri build` 生成独立原生应用。

### 3. 构建产物定位

打包成功后，安装包与二进制产物将生成在以下路径：
- **macOS 原生应用程序**：`apps/gui/src-tauri/target/release/bundle/macos/InkMigrate.app`
- **macOS 安装镜像 (DMG)**：`apps/gui/src-tauri/target/release/bundle/dmg/InkMigrate_1.0.0_aarch64.dmg`（根据您的芯片架构生成 `aarch64` 或 `x64`）

### 4. 首次打开安全提示（Gatekeeper 绕过）

由于本地自行构建的软件包未经 Apple 商业付费证书公证（Notarization），macOS 安全机制（Gatekeeper）在双击打开时可能会提示 *“InkMigrate 已损坏，无法打开”* 或 *“来自未知开发者”*。

只需在终端中执行以下命令清除隔离属性即可正常运行：

```bash
# 解除安装到「应用程序」中的隔离属性
xattr -cr /Applications/InkMigrate.app

# 或针对当前目录下的 .app 文件解除
xattr -cr path/to/InkMigrate.app
```
*（也可以在 macOS「系统设置」->「隐私与安全性」底部，点击「仍要打开」即可正常启动）*

---

## 🏛 架构设计

InkMigrate 采用现代化的 pnpm monorepo 模块化分层架构：

```
InkMigrate/
├── apps/
│   ├── gui/          # Tauri 2 + React 19 跨平台桌面端应用
│   ├── engine/       # Node.js 数据迁移后台 Sidecar（stdio JSON-RPC）
│   └── cli/          # 命令行工具 (inkmigrate) 入口
├── packages/
│   ├── core/         # 迁移核心状态机、SQLite WAL 事务持久化、对账审计、限流重试
│   ├── target-obsidian/ # Obsidian 渲染器、Wikilink 语法树重构、Frontmatter 注入
│   ├── source-toutiao/  # 今日头条 Playwright 自动化提取流水线
│   ├── source-evernote/ # Evernote .enex / HTML 导出目录解析与资源对账
│   ├── protocol/     # 跨进程强类型 RPC 契约定义
│   ├── wiring/       # 依赖组装与实例工厂
│   └── testkit/      # 适配器通用契约测试与断言工具
└── docs/             # 详细产品与技术需求规范、设计文档
```

---

## 🧪 测试与质量保证

本项目遵循严苛的测试驱动开发流程，覆盖单元测试、契约测试、状态机回归与端到端集成测试：

```bash
# 运行全库单元与集成测试（600+ 项测试用例）
pnpm test

# 运行自动化真实浏览器测试套件
pnpm --filter @inkmigrate/source-toutiao test:browser

# 执行全工程 TypeScript 严格模式类型检查
pnpm -r run typecheck
```

---

## 🔒 隐私与合规声明

1. **绝对本地优先**：InkMigrate 不设任何云端收集服务器，不内置任何未经用户许可的数据上报与遥测代码。您的所有账户凭证（Cookies）、网页缓存、附件和文章数据均保存在本地 `--state-dir` 与指定 Vault 目录中。
2. **合规提示**：请仅用于迁移您享有合法访问权限的个人知识资产。用户在使用过程中应遵守相关源平台的服务条款和适用法律法规。

---

## 📄 开源许可证

本项目基于商业友好的开源协议分发，详见 [LICENSE](./LICENSE)。
