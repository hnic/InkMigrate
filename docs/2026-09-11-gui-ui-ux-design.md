# InkMigrate GUI 交互与视觉架构改造方案设计

**状态**：已实施 (Implemented)  
**日期**：2026-09-11  
**影响范围**：`apps/gui` (React 19 + Tauri 2.x), `apps/gui/src-tauri` (Rust)  

---

## 1. 背景与现状痛点

InkMigrate 底层具备出色的本地优先与断点续跑工程机制，但在初始桌面 GUI 交付中，由于早期复刻 CLI 参数模型，存在显著的交互与视觉缺陷：

1. **缺失桌面原生文件/目录选择器**：
   工作区路径 (`stateDir`)、Obsidian 库路径 (`vaultPath`)、Evernote 配置文件 (`configPath`) 全为原生文本框，迫使用户在桌面端手动敲入长绝对路径或反复去文件管理器复制粘贴，极易发生拼写错误。
2. **异构来源迁移流程死锁**：
   `MigratePage.tsx` 将「开始迁移」按钮硬编码绑定为头条的校验规则 (`favoritesUrl` 和 `loggedIn`)。当切换为本地文件源 Evernote / 印象笔记时，由于 Evernote 永远不产生登录态且无收藏 URL，导致迁移按钮被永久禁用，核心流程陷入功能性死锁。
3. **视口空间被底层日志严重挤压**：
   底部日志控制台以固定 `180px` 高度常驻，在默认 1000×700 窗口下占据超过 25% 窗体面积，使实际表单可用区域不足 350px，各子页面频繁出现嵌套滚动条。
4. **数据资产黑盒与报告断层**：
   扫描结果仅展示数字总数，直接丢弃了引擎已返回的 `items` 明细；报告页要求用户去迁移页复制长 Hash Job ID 过来手动粘贴；缺乏直达系统文件管理器的操作入口。
5. **视觉设计规范与质感初级**：
   全站混用平台不一致的原生 Emoji；主操作按钮缺乏视觉重心；暗色模式下对比度未遵循 WCAG AA 规范。

---

## 2. 总体架构设计

改造确立了三个核心设计原则：
- **原生优先 (Native-First)**：发挥桌面客户端的系统级优势（原生目录选择、文件管理器直接唤起）。
- **来源感知 (Source-Aware)**：前置区分在线采集（今日头条）与本地导入（Evernote）不同工作台，彻底解耦流程校验。
- **渐进显露 (Progressive Disclosure)**：日常操作隐藏底层控制台与复杂实例 ID，需要时一键展开。

```
┌────────────────────────────────────────────────────────────┐
│                       InkMigrate 桌面顶栏                   │
│  [Logo 墨迁]   [来源选择: 今日头条 ▾ / Evernote ▾]   [状态] │
├───────────────┬────────────────────────────────────────────┤
│   侧边栏导航   │                  主操作视口                 │
│               │                                            │
│  • 1. 登录认证 │  • 路径点选: PathInput (原生 Dialog + 校验)   │
│  • 2. 扫描发现 │  • 流程解耦: 来源独占字段校验 (消灭死锁)     │
│  • 3. 导出迁移 │  • 资产明细: 可折叠条目搜索表格               │
│  • 4. 报告中心 │  • 报告闭环: 历史任务芯片 + 访达一键定位     │
│  • 5. 系统设置 │                                            │
├───────────────┴────────────────────────────────────────────┤
│  底部状态栏 / 可折叠抽屉: [控制台日志 (36px ↔ 190px)] [过滤] [复制] │
└────────────────────────────────────────────────────────────┘
```

---

## 3. 模块细化改造方案

### 3.1 原生系统能力集成（Native Capabilities）
- **Rust Tauri 原生命令** (`apps/gui/src-tauri/src/lib.rs`)：
  - `pick_directory(title, default_path) -> Result<Option<String>, String>`：基于平台原生机制（macOS AppleScript / Windows PowerShell WinForms）调起原生目录选择器，免去第三方重型 Crate 引入与 MSRV 风险。
  - `pick_file(title, default_path) -> Result<Option<String>, String>`：原生文件选择面板。
  - `open_in_folder(path) -> Result<(), String>`：跨平台在系统访达/资源管理器中就地定位目标文件或目录。
  - `check_path_exists(path) -> Result<bool, String>`：波浪号 `~/` 自动展开与路径存在性异步探测。
- **通用 `PathInput` 组件** (`apps/gui/src/components/PathInput.tsx`)：
  - 输入框 + 路径存在性异步状态微标（`✓` / `⚠️`）+ 「选择目录/文件」按钮 + 「在访达中打开」快捷链接。

### 3.2 异构来源流程解耦（Source Decoupling）
- **修复 Evernote 迁移死锁** (`apps/gui/src/components/pages/MigratePage.tsx`)：
  - 解耦 `canStart` 校验：
    ```ts
    const isEvernote = settings.sourceAdapter === 'evernote';
    const canStart = isEvernote
      ? Boolean(settings.stateDir && settings.vaultPath && settings.configPath)
      : Boolean(settings.stateDir && settings.vaultPath && settings.favoritesUrl && settings.loggedIn);
    ```
  - 移除非头条来源下的「未登录」伪警告与 `favoritesUrl` 强制校验。
- **前置来源向导** (`apps/gui/src/App.tsx` & `Sidebar.tsx`)：
  - 顶栏直属下拉选择来源类型，动态切换工作流路由（Evernote 仅展示 `扫描预览 -> 导出迁移`）。
  - 设置页将底层 `source` / `target` 实例 ID 收敛至高级折叠选项，默认免配置。

### 3.3 视口空间释放（Collapsible Console）
- **抽屉式 `LogPanel`** (`apps/gui/src/components/LogPanel.tsx`)：
  - **收起状态（默认）**：高度仅占用 `36px`，显示最新单行日志、级别小徽章与展开按键，立即归还 150px+ 纵向工作区。
  - **展开状态**：高度平滑过渡至 `190px`，提供「全部 / 仅错误 / 警告」日志级别过滤切片器、一键复制全部日志、清空日志面板工具条。

### 3.4 资产明细与报告中心（Itemized & Reports）
- **扫描条目明细** (`apps/gui/src/components/pages/ScanPage.tsx`)：
  - 消费 `ScanStartResult.items`，新增可折叠明细表格；
  - 提供标题关键字即时模糊搜索、内容格式分类 Badge、原文外部链接直达。
- **报告历史与本地定位** (`apps/gui/src/components/pages/ReportPage.tsx`)：
  - 引入本地持久化的近期 Job ID 记忆芯片，点选即可就地重载报告对账卡片；
  - 增加「在访达中打开报告目录」快捷入口。

### 3.5 视觉系统重塑（Design Tokens & Lucide）
- **矢量图标库**：安装 `lucide-react`，替换所有系统 Emoji 为像素级对齐的 SVG 矢量图标。
- **设计令牌** (`apps/gui/src/styles.css`)：
  - 建立标准深色 Slate 调色板，提升弱文字对比度达标 WCAG AA。
  - 建立明确的按键分级类：`.btn-primary` (高亮 CTA)、`.btn-secondary` (线框)、`.btn-danger` (警示)、`.btn-ghost` (幽灵文本)。

---

## 4. 风险评估与应对措施

| 风险点 | 影响评估 | 落地应对措施 |
| :--- | :--- | :--- |
| **1. 跨平台原生选择器兼容风险** | macOS / Windows / Linux 差异可能导致命令执行异常 | 采用轻量命令封装，Windows 走 PowerShell，macOS 走 AppleScript，Linux 走 Zenity 降级，全部放入 `spawn_blocking` 异步执行，不阻塞 UI 线程。 |
| **2. 大批量扫描条目渲染卡顿** | 收藏夹过大（如数万篇）会导致 React DOM 树过载 | 前端过滤列表限制渲染前 100 条并在界面显式提示数量，全量数据依托数据库与报告 CSV 持久化，保护 UI 帧率。 |
| **3. 来源切换时的状态污染** | 头条与 Evernote 来回切换可能导致参数互串 | 切换时在 `update` 层自动做字段清洗（如切回头条自动清空 `configPath`，并自动调整实例 ID 默认值）。 |
| **4. 破坏性操作误触** | 清理源端或清空 Profile 可能导致数据丢失 | `LoginPage` 与 `CleanupPage` 的危险操作全面引入二次防误触确认。 |
