# GUI 交互与视觉重构实施计划 (Implementation Plan)

**Goal:** 重构 InkMigrate 桌面端 GUI（`apps/gui`），消除 Evernote 迁移死锁、集成原生系统文件目录选择器、重塑控制台抽屉与视觉规范，提升整体可用性与桌面端质感。

**Architecture:**
1. **原生层 (`apps/gui/src-tauri/src/lib.rs`)**：编写并注册 `pick_directory`, `pick_file`, `open_in_folder`, `check_path_exists` 四组原生 Tauri 命令。
2. **基础组件层**：编写 `PathInput.tsx` 封装点选与存在性探测；升级 `styles.css` 建立高对比度暗色设计令牌；安装 `lucide-react`。
3. **工作流解耦层**：重构 `MigratePage.tsx` 解耦来源校验；`App.tsx` 与 `Sidebar.tsx` 前置来源切换。
4. **体验升级层**：`LogPanel.tsx` 改为可折叠抽屉并提供过滤复制；`ScanPage.tsx` 渲染明细表格；`ReportPage.tsx` 历史任务闭环。
5. **回归测试层**：新增 `apps/gui/src/components/__tests__/gui-validation-and-logic.test.ts` 保护核心判断逻辑。

**Tech Stack:** React 19, TypeScript, Tauri 2.x, Rust, Vitest, Lucide React

**Spec Reference:** `docs/2026-09-11-gui-ui-ux-design.md`

---

## 1. 测试基础设施现状

- **GUI (`apps/gui`)**：原无任何测试套件。本次在 `apps/gui/package.json` 补充 `vitest` 与 `test` 脚本，编写 `gui-validation-and-logic.test.ts`（9/9 tests 通过）。
- **Rust (`apps/gui/src-tauri`)**：通过 `cargo check` 与 `cargo build` 确保原生命令编译无误。
- **Core / Engine / Adapters**：运行全量 Vitest 套件（363+71+129+31 passed）确保对底层 RPC 和业务库零功能漂移。

---

## 2. 文件变更清单 (File Structure)

| 文件路径 | 职责范围 | 操作类型 |
| :--- | :--- | :---: |
| `apps/gui/src-tauri/src/lib.rs` | 增加目录/文件点选、访达唤起、路径检查 Tauri 命令 | Modify |
| `apps/gui/src-tauri/.gitignore` | 忽略 resources 软链，防本地 sidecar 大文件误提交 | Modify |
| `apps/gui/package.json` | 引入 `lucide-react` 依赖与 `vitest` 测试脚本 | Modify |
| `apps/gui/src/styles.css` | 规范暗色设计令牌、按钮分级、现代化细滚动条 | Modify |
| `apps/gui/src/components/PathInput.tsx` | 原生路径点选器核心组件 | **Create** |
| `apps/gui/src/components/ConfigPrompt.tsx` | 接入 `PathInput`，优化配置缺失原地补全体验 | Modify |
| `apps/gui/src/components/LogPanel.tsx` | 重构为可折叠控制台抽屉，支持级别过滤与复制 | Modify |
| `apps/gui/src/components/Sidebar.tsx` | 导航适配来源感知，升级 Lucide 矢量图标 | Modify |
| `apps/gui/src/components/ProgressBar.tsx` | 进度条视觉精细化与矢量图标对齐 | Modify |
| `apps/gui/src/components/pages/MigratePage.tsx` | 解耦 Evernote 迁移参数校验，消灭死锁 Bug | Modify |
| `apps/gui/src/components/pages/ScanPage.tsx` | 渲染扫描条目明细表格，支持即时模糊搜索过滤 | Modify |
| `apps/gui/src/components/pages/LoginPage.tsx` | 危险操作增加二次确认，接入 `PathInput` | Modify |
| `apps/gui/src/components/pages/ReportPage.tsx` | 历史任务芯片点选，一键直达本地报告目录 | Modify |
| `apps/gui/src/components/pages/SettingsPage.tsx` | 路径输入接入 `PathInput`，底层实例 ID 收敛至高级选项 | Modify |
| `apps/gui/src/hooks/useSidecar.ts` | 暴露 `clearLogs` 日志重置方法 | Modify |
| `apps/gui/src/lib/types.ts` | 导出 `ScanStartResult` 协议类型 | Modify |
| `apps/gui/src/App.tsx` | 顶栏集成来源切换器，整合可折叠日志抽屉 | Modify |
| `apps/gui/src/components/__tests__/gui-validation-and-logic.test.ts` | 业务逻辑与解耦规则单测套件 | **Create** |

---

## 3. 实施任务分解与步骤

### Task 1: 原生系统级能力（Tauri 原生命令 + PathInput）
- [x] **Step 1**: 在 `apps/gui/src-tauri/src/lib.rs` 增加 `pick_directory`, `pick_file`, `open_in_folder`, `check_path_exists`。
- [x] **Step 2**: 在 `generate_handler!` 宏中注册这 4 个原生命令。
- [x] **Step 3**: 运行 `cargo check` 确保编译通过。
- [x] **Step 4**: 编写 `apps/gui/src/components/PathInput.tsx`，对接原生命令并提供存在性探测与状态反馈。

### Task 2: 视觉规范与设计系统基础
- [x] **Step 1**: 安装 `lucide-react` 图标库。
- [x] **Step 2**: 重构 `styles.css`，配置符合 WCAG AA 对比度标准的暗色调色板，定义 `.btn-primary`、`.btn-secondary`、`.btn-danger`、`.btn-ghost` 等语义类与细滚动条。

### Task 3: 异构来源解耦与 Evernote 死锁修复
- [x] **Step 1**: 修改 `MigratePage.tsx`，将 `canStart` 校验逻辑按 `isEvernote` 分流，移除头条专有字段对本地文件源的强绑定。
- [x] **Step 2**: 移除 Evernote 模式下误报的「请先登录」警告，确保流程通畅。
- [x] **Step 3**: 在 `App.tsx` 顶栏增加来源切换器，联动切换工作流页面与侧边栏路由。
- [x] **Step 4**: 设置页将底层 `source` / `target` 实例 ID 放入「高级设置」折叠抽屉。

### Task 4: 视口释放与控制台改造
- [x] **Step 1**: 在 `useSidecar.ts` 中增加 `clearLogs` 方法。
- [x] **Step 2**: 重构 `LogPanel.tsx` 支持 36px 紧凑折叠态与 190px 展开态，增加级别过滤切片器、一键复制全部日志、清空面板按钮。
- [x] **Step 3**: 在 `App.tsx` 中绑定折叠状态，实现任务运行时自动展开、平日收起。

### Task 5: 资产可视化与报告链路闭环
- [x] **Step 1**: 扩展 `types.ts` 导出 `ScanStartResult`。
- [x] **Step 2**: `ScanPage.tsx` 保存条目明细并在扫描完成后提供可折叠表格与实时模糊搜索。
- [x] **Step 3**: `ReportPage.tsx` 实现本地历史任务芯片记忆点选，新增「在访达中打开报告」按钮。

### Task 6: 自动化测试与验证
- [x] **Step 1**: 在 `apps/gui/package.json` 配置 `vitest`。
- [x] **Step 2**: 编写 `gui-validation-and-logic.test.ts` 测试用例，覆盖 Evernote 解耦判定、URL 过滤、历史任务队列截断。
- [x] **Step 3**: 运行 `pnpm --filter @inkmigrate/gui test`（9/9 passed）。
- [x] **Step 4**: 运行全库单元测试与类型检查（`pnpm -r run build` & `pnpm -r run typecheck`）。

---

## 4. 验收清单与验证记录

- [x] **Evernote 导入流程跑通**：切至 Evernote 源后，进入迁移页面，配置就绪后「开始迁移」按钮正常激活，无任何伪警告。
- [x] **原生选择器生效**：点击工作区、Vault 或 yaml 的「选择」按钮，弹出系统原生对话框，选定后路径正确回填并呈现绿色 `✓` 标签。
- [x] **日志面板可收起**：默认仅占 36px 底部状态条，点击展开后可按 Error/Warn 过滤，支持日志复制。
- [x] **扫描明细可见**：头条扫描完成后可展开查看文章标题清单与原文外链。
- [x] **历史报告可切**：报告页列出近期任务，点击即可查看状态分布卡片，可直接打开本地对应报告文件夹。
- [x] **零功能漂移**：核心库（core/engine/adapters）363+71+129+31 项既有单元测试全部通过。
