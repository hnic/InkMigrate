# Evernote GUI/Engine 集成设计（v2.0 GUI 里程碑）

状态：设计草案（实现待产品确认决策点后启动）
前置：`@inkmigrate/source-evernote` 已全量交付（ENEX/HTML/GUID 链接重写），CLI 三命令（scan/migrate/resume）已支持。

## 1. 现状盘点

- **Engine（apps/engine）**：JSON-RPC over stdio 的 Node sidecar，由 Tauri `SidecarManager` spawn（无受控 cwd，进程内无任何配置文件概念）。`migrate.start`/`migrate.resume` 处理器硬编码 toutiao：构造 `createToutiaoSource` 前先做 Profile 存在性检查，`ensureInstance` 记 `toutiao` kind。参数 `MigrateStartParams { source, target, stateDir, vaultPath, favoritesUrl?, maxItems? }` 为 toutiao 形状。
- **GUI（apps/gui）**：React 页面 LoginPage（浏览器登录引导）→ ScanPage → MigratePage → CleanupPage 的 toutiao 单来源流程；`useSettings` 默认 `source: 'toutiao-main'`，无来源类型概念。
- **CLI 侧已完成可复用资产**：`apps/cli/src/source-wiring.ts`（yaml 命中 evernote → 文件源；回退 toutiao；target 配置经 schema 填默认值）。

## 2. 决策点（需产品拍板）

### 决策 1：Engine 如何获得 Evernote 来源定义（配置发现）

| 选项 | 说明 | 评估 |
|---|---|---|
| **A. RPC 参数传 configPath（推荐）** | `MigrateStartParams`/`Resume` 增加可选 `configPath`；engine 用与 CLI 完全相同的 source-wiring 逻辑按 source id 分派 | 与 CLI `--config` 同构零新约定；GUI 设置页加一次文件选择；未传时行为不变（toutiao），向后兼容 |
| B. 约定 stateDir 同级 `inkmigrate.yaml` | engine 自动发现 | 引入隐式约定，CLI（CWD）与 GUI（stateDir 旁）两套发现规则易踩坑 |
| C. RPC 直接传 `inputPaths/formats/...` | 协议承载来源配置 | 协议面扩大，每加一个来源字段都要动 protocol + GUI + engine 三处 |

### 决策 2：GUI 流程与导航

- Evernote 来源**无登录步骤**：LoginPage 需按来源类型条件隐藏。
- ScanPage 对 evernote 展示"条目数 + Stack/笔记本分布 + 注意事项（.notes 拒绝等）"，替代头条的滚动扫描进度。
- MigratePage/进度条/报告页可直接复用（ProgressNotification 协议不变）。
- 建议设置页：`configPath` 文件选择器 + 从配置解析出 sources 列表供下拉选择（只读展示 id/adapter/enabled），避免用户手输 source id。

### 决策 3：scan RPC 形状

头条 `scan.start` 与浏览器强耦合（favoritesUrl/headless）。Evernote 预览建议新增 `scan.preview`（入参 source + configPath + stateDir，出参条目数/笔记本分布/issue 列表，不写库），不动头条协议。

## 3. 实施切分（决策通过后）

1. **T1 共享接线下沉**：`apps/cli/src/source-wiring.ts` 迁至 `@inkmigrate/core`（或独立 `@inkmigrate/wiring`），CLI 改 import，零行为变化。
2. **T2 协议扩展（向后兼容）**：`packages/protocol` 的 `MigrateStartParams`/`MigrateResumeParams` 增加可选 `configPath?: string`；`RpcMethodMap` 新增 `scan.preview`。
3. **T3 Engine 分派**：`migrate.start`/`migrate.resume` 在 configPath 存在且命中 evernote 时走文件源（Profile 检查仅 toutiao 路径执行）；`ensureInstance` 记录真实 kind；新增 `scan.preview` 处理器。
4. **T4 Engine 测试**：fixture ENEX 走 RPC 全链路（migrate.start → status.query → 对账通过）。
5. **T5 GUI**：设置页 configPath + 来源下拉；LoginPage/ScanPage 按来源类型条件渲染；MigratePage 透传 configPath。
6. **T6 GUI 手测清单**：evernote 全流程 / toutiao 回归（不传 configPath 行为不变）/ .notes 拒绝提示文案展示。

## 4. 开放问题

- GUI 是否暴露 `formats`/`stackSeparator` 等高级项（建议 v1 只读展示，编辑仍走 yaml 文件）。
- `configPath` 的记忆位置（建议随现有 settings 持久化）。
- 多 evernote 来源实例（多个导出目录）在 GUI 的展示粒度（建议 v1 单选下拉）。
