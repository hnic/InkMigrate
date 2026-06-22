# InkMigrate 产品需求与技术规格

**文档编号：** IM-PRD-001  
**版本：** 1.0  
**状态：** 实施基线  
**更新日期：** 2026-06-22  
**项目名称：** InkMigrate（墨迁）  
**仓库名称：** `inkmigrate`  
**命令行入口：** `inkmigrate`  
**包命名空间：** `@inkmigrate/*`

> **项目定位**  
> InkMigrate 是一个本地优先、可验证、可恢复、可审计的知识迁移工具包。它通过可插拔的来源适配器和目标适配器，将不同知识平台中的内容迁移为长期可控的开放文件，并在显式授权和严格复核条件下支持有限的源端清理。

---

## 0. 文档用途与实施范围

本文件是 InkMigrate 的完整产品需求、技术架构、实现约束、测试方案与验收标准。可直接提供给 Cursor、Claude Code、Codex 等 AI 编程工具，也可作为人工开发、代码审查和版本验收的实施依据。

### 0.1 当前版本必须交付

1. 通用迁移核心、CLI、SQLite 状态库和适配器框架。
2. `toutiao` 来源适配器：将用户自己的今日头条收藏批量迁移到 Obsidian。
3. `obsidian` 目标适配器：生成 Markdown、YAML Properties、附件、索引和报告。
4. 今日头条可选源端清理：对已成功迁移并验证的条目取消收藏。
5. 完整的断点续传、幂等、冲突保护、诊断、报告和测试体系。

### 0.2 当前版本必须预留但可以不启用

1. `evernote` 来源适配器的稳定接口和测试契约。
2. ENEX、Evernote HTML 导出包的输入模型。
3. Evernote 笔记、资源、标签、笔记本、内部链接的标准化模型。
4. 多来源并存、同一 Obsidian Vault 多次迁移的数据库与目录隔离机制。

### 0.3 后续版本计划

- **v1.x：** 稳定今日头条迁移、源端清理和跨平台安装。
- **v2.0：** 正式交付印象笔记/Evernote ENEX 到 Obsidian 的迁移适配器。
- **后续：** 可增加 Notion、OneNote、网页书签、RSS、Markdown 目录等来源，以及通用文件系统等目标，但不得破坏本文件定义的核心适配器契约。

---

## 1. 产品背景

用户在今日头条、印象笔记等平台中积累了大量文章、笔记、图片和附件。这些内容通常存在以下问题：

- 平台数据结构封闭，难以一次性导出为长期可控格式。
- 收藏或笔记数量较大，逐篇复制不可行。
- 网页内容可能失效，远程图片可能过期。
- 批量迁移容易发生静默丢失、重复写入、文件名冲突和中断后无法恢复。
- 用户无法确认“扫描到多少、迁移了多少、失败了多少、是否真的完整”。
- 在清理源平台收藏前，需要证明本地副本完整、附件存在且可追溯。

InkMigrate 的核心价值不是单纯“把内容抓下来”，而是建立一条可以验证、重跑、审计和扩展的迁移管线。

---

## 2. 产品目标

### 2.1 核心目标

1. 将来源平台中的用户数据迁移为 Obsidian 可直接使用的 Markdown 与普通附件文件。
2. 每个输入条目必须有明确结果：成功、降级保存、跳过、失败或待人工处理；不得静默丢失。
3. 支持数千条内容的中断恢复、失败重试、去重和重复执行。
4. 默认不上传 Cookie、笔记、正文、附件或迁移报告到第三方服务。
5. 通过适配器体系支持新增来源和目标，不将核心流程绑定到今日头条或 Obsidian。
6. 源端写操作默认关闭，且必须经过计划、验证、人工确认和操作后复核。

### 2.2 成功定义

一次迁移只有同时满足以下条件才可报告为成功：

- 来源扫描结束条件明确，并生成唯一条目清单。
- 每个扫描条目在数据库中存在唯一记录。
- 每个成功条目均有可读取的目标笔记。
- YAML、Markdown、附件链接和附件实体通过验证。
- 重复执行不会生成重复笔记或重复附件。
- 失败、降级、冲突和未知状态均在报告中可定位。
- 源端清理只作用于计划内且已验证的条目。

### 2.3 非目标

第一版不实现：

- Obsidian 社区插件或 Electron 桌面应用。
- 手机 App 自动化。
- 云端同步、云端数据库或托管服务。
- 云端 AI 摘要、自动分类、向量化或标签生成。
- 验证码识别、滑块破解、浏览器指纹伪装或反自动化规避。
- 视频媒体文件批量下载。
- 今日头条评论、点赞、关注、浏览历史迁移。
- 删除今日头条原文章、视频、账号内容或收藏夹。
- 删除印象笔记源端笔记。
- 绕过付费、权限、登录、加密或已下架内容限制。

---

## 3. 设计原则

### 3.1 本地优先

- 数据处理、数据库、正文、附件、浏览器认证状态和报告全部保存在用户本地。
- 默认不启用遥测。
- 不调用外部 AI API。
- 不使用自建中转服务器。

### 3.2 可验证

- 扫描、提取、转换、附件写入、笔记写入和最终验证分阶段记录。
- 成功状态必须以目标文件和数据库一致为依据，而不是仅以函数返回成功为依据。
- 提供完整性统计、逐项结果和二次验证。

### 3.3 可恢复

- 每个条目独立提交状态。
- 进程崩溃、网络中断或用户按 `Ctrl+C` 后可恢复。
- 不将所有正文一次性加载到内存。

### 3.4 幂等

- 相同来源条目重复迁移不会生成重复目标文件。
- 已取消收藏的条目不会因重试被重新收藏。
- 目标文件被用户修改后默认不覆盖。

### 3.5 安全写入

- 所有目标文件采用临时文件、校验、原子重命名流程。
- 源端写操作必须显式启用、生成计划、人工确认并执行后复核。
- 不提供跳过确认的 `--force`、`--yes` 或 `--no-confirm` 参数。

### 3.6 适配器隔离

- 来源页面选择器、来源格式解析、目标格式渲染与核心调度分离。
- 来源适配器不能直接写 Obsidian 文件。
- 目标适配器不能直接控制来源浏览器。
- 核心层只处理标准化领域模型。

---

## 4. 术语

| 术语 | 定义 |
|---|---|
| Source / 来源 | 被迁移数据所在的平台、网页或导出文件，例如今日头条、Evernote ENEX。 |
| Target / 目标 | 接收迁移结果的系统或文件结构，例如 Obsidian Vault。 |
| Source Adapter | 负责扫描、读取和标准化某一种来源数据的插件模块。 |
| Target Adapter | 负责规划路径、渲染和写入某一种目标格式的插件模块。 |
| Source Item | 来源中的一个可迁移单元，例如一条收藏或一篇 Evernote 笔记。 |
| Asset / 资源 | 与条目关联的图片、PDF、音频、文档或其他附件。 |
| Migration Job | 一次从指定来源到指定目标的迁移任务。 |
| Cleanup Plan | 源端清理前生成的不可变候选条目计划。 |
| Cleanup Job | 按清理计划执行的源端写操作任务。 |
| Verified | 目标笔记、属性和附件均通过验证的状态。 |
| Degraded / 降级 | 无法完整提取正文，但仍保存元数据或可见内容。 |
| Fingerprint | 用于识别来源条目的稳定指纹。 |
| Artifact | 目标端生成的笔记、附件、索引或报告。 |

---

## 5. 品牌与命名规范

### 5.1 正式名称

- 中文名称：墨迁
- 英文名称：InkMigrate
- CLI：`inkmigrate`
- 仓库：`inkmigrate`
- 配置文件：`inkmigrate.yaml`
- 本地状态目录：`.inkmigrate/`
- 环境变量前缀：`INKMIGRATE_`

### 5.2 包名

```text
@inkmigrate/core
@inkmigrate/cli
@inkmigrate/source-toutiao
@inkmigrate/source-evernote
@inkmigrate/target-obsidian
@inkmigrate/testkit
```

### 5.3 命名限制

- 不再使用 `tt2obs`、`favorite-export` 等单一来源名称作为项目主命令。
- 来源特有术语只能出现在来源适配器、来源配置和来源报告中。
- 核心数据表和接口使用通用名称，如 `source_items`，不得命名为 `favorites`。

---

## 6. 版本范围与优先级

### 6.1 P0：当前版本必须完成

- Monorepo、配置系统、SQLite、日志、锁和迁移核心。
- 来源/目标适配器注册与能力发现。
- 今日头条手动登录和认证状态复用。
- 今日头条收藏扫描、正文提取、图片本地化。
- Obsidian Markdown、Properties、附件、索引写入。
- 断点续传、重试、幂等、冲突保护和验证。
- 扫描、迁移、失败和验证报告。
- 单元、Fixture、集成和小规模端到端测试。

### 6.2 P1：当前版本应完成

- 今日头条取消收藏清理计划与逐条执行。
- 清理后的二次扫描和审计报告。
- 页面选择器诊断与脱敏 HTML/截图。
- 按月份和内容类型生成索引。
- 迁移前磁盘空间预估和 Vault 备份提示。

### 6.3 P2：后续版本交付

- Evernote ENEX 流式解析。
- Evernote HTML 导出包解析。
- ENML 到 Markdown 转换。
- Evernote 资源哈希映射、内部链接重写、标签和笔记本保留。
- 适用于万级笔记的完整性对账。

---

## 7. 总体架构

### 7.1 分层结构

```text
CLI / 命令层
    ↓
应用服务层（扫描、迁移、验证、清理、报告）
    ↓
核心领域层（标准模型、状态机、计划、错误）
    ↓
来源适配器                目标适配器
├─ source-toutiao         └─ target-obsidian
└─ source-evernote
    ↓                         ↓
浏览器 / 文件解析            文件系统 / Vault
    ↘                       ↙
       SQLite、日志、锁、诊断
```

### 7.2 依赖方向

- `core` 不得依赖任何具体来源或目标。
- `cli` 依赖 `core` 和适配器注册表，但不包含来源解析逻辑。
- 来源适配器依赖 `core`，不得依赖目标适配器。
- 目标适配器依赖 `core`，不得依赖来源适配器。
- 测试工具包可以依赖所有模块，但生产模块不得依赖测试工具包。

### 7.3 Monorepo 结构

```text
inkmigrate/
├── apps/
│   └── cli/
├── packages/
│   ├── core/
│   ├── source-toutiao/
│   ├── source-evernote/
│   ├── target-obsidian/
│   └── testkit/
├── docs/
├── examples/
├── scripts/
├── tests/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.zh-CN.md
```

### 7.4 技术栈

- Node.js：当前 LTS 版本，最低版本在 `engines` 中固定。
- TypeScript：严格模式。
- 包管理：pnpm Workspace。
- 浏览器自动化：Playwright Chromium。
- 数据库：SQLite，推荐 `better-sqlite3`，启用 WAL。
- 配置：YAML + Zod。
- XML：支持流式 SAX 解析的成熟库。
- DOM：JSDOM。
- 正文回退：`@mozilla/readability`。
- HTML 转 Markdown：Turndown 或具备同等级扩展能力的库。
- 日志：Pino，统一脱敏层。
- 测试：Vitest。

---

## 8. 适配器契约

### 8.1 来源能力声明

每个来源适配器必须公开能力对象：

```ts
export interface SourceCapabilities {
  authMode: 'none' | 'browser-profile' | 'file';
  discoveryMode: 'remote-list' | 'file-stream' | 'directory';
  supportsIncrementalScan: boolean;
  supportsAssets: boolean;
  supportsInternalLinks: boolean;
  supportsSourceCleanup: boolean;
  cleanupActions: string[];
  supportedInputFormats: string[];
}
```

### 8.2 来源适配器接口

```ts
export interface SourceAdapter {
  readonly kind: string;
  readonly version: string;
  readonly capabilities: SourceCapabilities;

  validateConfig(ctx: AdapterContext): Promise<ValidationResult>;
  prepare(ctx: AdapterContext): Promise<void>;
  scan(ctx: ScanContext): AsyncGenerator<SourceItemRef>;
  extract(ref: SourceItemRef, ctx: ExtractContext): Promise<SourceItem>;
  verifySourceRef?(ref: SourceItemRef, ctx: VerifyContext): Promise<SourceRefState>;
  close(): Promise<void>;
}
```

### 8.3 源端清理接口

```ts
export interface SourceCleanupAdapter {
  readonly supportedActions: readonly string[];

  inspectActionState(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext
  ): Promise<CleanupActionState>;

  executeAction(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext
  ): Promise<CleanupActionReceipt>;

  verifyAction(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext
  ): Promise<CleanupVerification>;
}
```

### 8.4 目标适配器接口

```ts
export interface TargetAdapter {
  readonly kind: string;
  readonly version: string;

  validateConfig(ctx: AdapterContext): Promise<ValidationResult>;
  plan(item: SourceItem, ctx: TargetContext): Promise<TargetPlan>;
  write(plan: TargetPlan, ctx: TargetContext): Promise<TargetWriteResult>;
  verify(result: TargetWriteResult, ctx: VerifyContext): Promise<TargetVerification>;
  renderIndex?(ctx: TargetContext): Promise<TargetWriteResult[]>;
}
```

### 8.5 标准化条目模型

```ts
export type SourceContentKind =
  | 'article'
  | 'short-post'
  | 'gallery'
  | 'question-answer'
  | 'video'
  | 'note'
  | 'external-link'
  | 'unknown';

export interface SourceItemRef {
  sourceInstanceId: string;
  externalId?: string;
  canonicalUrl?: string;
  originalUrl?: string;
  title?: string;
  contentKind: SourceContentKind;
  discoveredAt: string;
  sourcePosition?: number;
  fingerprint: string;
  sourceMetadata: Record<string, unknown>;
}

export interface SourceItem {
  ref: SourceItemRef;
  title: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  favoritedAt?: string;
  bodyHtml?: string;
  bodyText?: string;
  summary?: string;
  tags: string[];
  collections: string[];
  assets: SourceAsset[];
  links: SourceLink[];
  extractionMethod: string;
  extractionWarnings: string[];
  sourceMetadata: Record<string, unknown>;
}
```

### 8.6 适配器兼容性

- 每个适配器必须声明 `adapterApiVersion`。
- 核心在启动时检查兼容范围。
- 不兼容时拒绝运行并给出明确错误，不得忽略。
- 来源特有数据放在 `sourceMetadata`，但影响迁移正确性的字段必须提升为标准字段。

---

## 9. 通用用户流程

### 9.1 初始化

```bash
inkmigrate init
```

初始化应：

1. 创建项目配置。
2. 创建 `.inkmigrate/` 状态目录。
3. 选择或创建来源实例。
4. 选择或创建目标实例。
5. 验证目标路径和写权限。
6. 生成示例配置及安全提示。

### 9.2 添加来源和目标

```bash
inkmigrate source list
inkmigrate source add toutiao --id toutiao-main
inkmigrate source add evernote --id evernote-archive

inkmigrate target list
inkmigrate target add obsidian --id personal-vault
```

### 9.3 认证

网页来源：

```bash
inkmigrate auth login --source toutiao-main
inkmigrate auth status --source toutiao-main
inkmigrate auth clear --source toutiao-main
```

文件来源不需要认证：

```bash
inkmigrate source validate --source evernote-archive
```

### 9.4 扫描

```bash
inkmigrate scan --source toutiao-main
inkmigrate scan --source toutiao-main --max-items 20
inkmigrate scan --source evernote-archive
```

扫描只建立来源清单，不应在默认模式下写目标笔记。

### 9.5 迁移

```bash
inkmigrate migrate \
  --source toutiao-main \
  --target personal-vault
```

可选限制：

```bash
inkmigrate migrate --source toutiao-main --target personal-vault --max-items 50
```

### 9.6 恢复、重试和验证

```bash
inkmigrate resume --job <job-id>
inkmigrate retry --job <job-id> --status retryable_failed
inkmigrate verify --job <job-id>
inkmigrate status --job <job-id>
inkmigrate report --job <job-id>
```

### 9.7 预演

所有会写目标或源端的主要命令必须支持预演：

```bash
inkmigrate migrate --source toutiao-main --target personal-vault --dry-run
inkmigrate cleanup unfavorite --plan <plan-id> --dry-run
```

预演不得写目标笔记、下载附件或点击源端写操作；允许写本地计划和报告。

---

## 10. 配置系统

### 10.1 配置文件

默认文件：

```text
inkmigrate.yaml
```

所有相对路径相对于配置文件所在目录解析，而不是当前 Shell 工作目录。

### 10.2 示例配置

```yaml
version: 1

workspace:
  stateDir: ".inkmigrate"
  reportsDir: "reports"
  diagnosticsDir: ".inkmigrate/diagnostics"
  logLevel: "info"

sources:
  - id: "toutiao-main"
    adapter: "toutiao"
    enabled: true
    config:
      browserProfileDir: ".inkmigrate/auth/toutiao-main"
      headless: false
      locale: "zh-CN"
      timezoneId: "Asia/Shanghai"
      manualNavigationFallback: true
      scan:
        noGrowthCycles: 5
        waitAfterScrollMs: 1500
      crawl:
        concurrency: 1
        intervalMs: 1500
        navigationTimeoutMs: 45000
        extractionTimeoutMs: 30000
        maxRetries: 3

  - id: "evernote-archive"
    adapter: "evernote"
    enabled: false
    config:
      inputPaths:
        - "imports/evernote"
      formats:
        - "enex"
        - "html"
      notebookNameStrategy: "filename"
      stackSeparator: "@@@"


targets:
  - id: "personal-vault"
    adapter: "obsidian"
    enabled: true
    config:
      vaultPath: "D:/Obsidian/MyVault"
      notesDir: "Imports/InkMigrate"
      assetsDir: "Attachments/InkMigrate"
      linkStyle: "wikilink"
      createIndexes: true
      indexGroupBy: "month"
      overwritePolicy: "preserve"
      unicodeNormalization: "NFC"

sourceCleanup:
  enabled: false
  sourceId: "toutiao-main"
  action: "unfavorite"
  executionMode: "separate-command"
  requireCleanupPlan: true
  requireVerifiedTarget: true
  requireAssetsVerified: true
  dryRunByDefault: true
  requireTypedConfirmation: true
  confirmationPrefix: "UNFAVORITE"
  maxItemsPerRun: 100
  batchSize: 20
  intervalMs: 2500
  jitterMs: 750
  maxRetries: 2
  stopAfterConsecutiveFailures: 3
  verifyAfterAction: true
  secondPassRescan: true
  allowActionOutsidePlan: false

privacy:
  telemetry: false
  redactLogs: true
  retainFailureScreenshots: true
  saveSanitizedHtml: true
```

### 10.3 配置验证

使用 Zod 或同等级 Schema 验证。启动前必须一次性列出全部错误，包括：

- 未知适配器。
- 重复来源或目标 ID。
- 路径不存在或不可写。
- 输出路径逃逸出 Vault。
- 不支持的能力配置。
- 清理来源不支持指定动作。
- 数值范围错误。
- 相互冲突的配置。

### 10.4 配置迁移

- 配置必须含顶层 `version`。
- 配置升级通过显式命令执行：

```bash
inkmigrate config upgrade
```

- 不允许运行时静默重写用户配置。


## 11. 通用迁移管线

### 11.1 阶段划分

每个 Migration Job 依次经过：

```text
preflight
→ scanning
→ planning
→ extracting
→ normalizing
→ transferring_assets
→ writing_target
→ verifying_target
→ generating_indexes
→ reporting
→ completed
```

每个条目独立经过：

```text
discovered
→ queued
→ extracting
→ extracted
→ normalized
→ assets_ready
→ writing
→ written
→ verified
```

异常终态：

```text
degraded
retryable_failed
permanent_failed
unsupported
blocked
conflict
interrupted
skipped
```

### 11.2 预检

迁移前必须检查：

- 来源适配器配置有效。
- 目标适配器配置有效。
- 认证状态满足要求。
- SQLite 可写且 Schema 版本兼容。
- 目标路径可写。
- 无同一来源和目标的冲突任务锁。
- 磁盘可用空间高于最低阈值。
- 用户已被提示备份目标 Vault。

### 11.3 扫描

扫描只保存轻量级 `SourceItemRef`。要求：

- 每发现一批条目立即提交 SQLite。
- 不将全部条目保存在内存中。
- 去重依据必须可解释。
- 记录扫描终止原因。
- 生成扫描清单和统计。

### 11.4 迁移计划

开始提取前生成 Migration Plan，包含：

- 来源实例和目标实例。
- 来源适配器、目标适配器及版本。
- 候选条目数量。
- 跳过和排除原因。
- 配置哈希。
- 数据库快照版本。
- 计划哈希。

计划用于审计和恢复，但普通目标写入不需要人工确认。

### 11.5 提取与标准化

- 来源适配器负责读取来源并输出标准 `SourceItem`。
- 核心层执行通用清洗、日期规范化、标签规范化和内容哈希。
- 不可识别字段保留在 `sourceMetadata`。
- 所有降级必须生成警告码。

### 11.6 附件处理

- 附件应流式下载或提取。
- 使用 SHA-256 计算内容哈希。
- 对同一目标范围内的相同内容允许去重。
- 目标路径由目标适配器规划。
- 失败附件不得使整篇内容无条件失败，应根据附件重要性降级或失败。

### 11.7 目标写入

- 目标适配器先生成完整 `TargetPlan`。
- 所有路径必须在写入前标准化和验证。
- 使用临时文件写入、Flush、解析校验和原子 Rename。
- 成功后才更新数据库为 `written`。

### 11.8 验证

通用验证包括：

- 目标文件存在且非零字节。
- 文件哈希与数据库一致。
- 目标格式可解析。
- 附件存在且 MIME/哈希正确。
- 条目引用的本地附件无缺失。
- 来源项与目标 Artifact 建立一一映射。

### 11.9 报告

每个 Job 至少生成：

```text
reports/<job-id>/
├── summary.md
├── summary.json
├── items.csv
├── failed-items.csv
├── degraded-items.csv
├── conflicts.csv
├── missing-assets.csv
└── unresolved-links.csv
```

---

## 12. 今日头条来源适配器

### 12.1 适配器标识

```text
adapter: toutiao
package: @inkmigrate/source-toutiao
```

能力：

```yaml
authMode: browser-profile
discoveryMode: remote-list
supportsIncrementalScan: true
supportsAssets: true
supportsInternalLinks: false
supportsSourceCleanup: true
cleanupActions:
  - unfavorite
```

### 12.2 登录要求

用户执行：

```bash
inkmigrate auth login --source toutiao-main
```

行为：

1. 启动有界面的 Chromium。
2. 使用工具专用持久化 Profile。
3. 打开今日头条正常登录页面。
4. 用户通过网站当前提供的扫码、验证码等正常方式登录。
5. 通过多个信号检测登录状态。
6. 保存浏览器 Profile，不额外导出明文 Cookie。
7. 关闭浏览器后可在后续任务中复用。

禁止：

- 要求用户输入或粘贴密码、Cookie、Token。
- 使用用户日常 Chrome Profile。
- 将认证状态提交到 Git。
- 将完整请求头写入日志。

认证清理：

```bash
inkmigrate auth clear --source toutiao-main
```

只能删除该来源实例的工具专用 Profile。

### 12.3 收藏页面定位

扫描时：

1. 尝试自动导航到收藏页。
2. 自动定位失败时进入人工辅助模式。
3. 浏览器保持打开，提示用户手动进入收藏页面。
4. 用户在终端确认后继续扫描。

不得把某个固定 URL 当作唯一入口。

### 12.4 扫描策略

实现两种互补策略。

#### DOM 扫描

提取：

- 内容 URL。
- 标题。
- 作者。
- 摘要。
- 封面图。
- 内容类型。
- 页面展示时间。
- 收藏分组。
- 列表位置。

选择器必须集中在：

```text
packages/source-toutiao/src/selectors/
```

字段使用多个候选定位器。优先顺序：

1. 稳定属性或测试标识。
2. ARIA role 和可访问名称。
3. 结构关系。
4. 文案与状态组合。
5. CSS class 仅作为最后回退。

禁止只依赖压缩或随机生成的 CSS class。

#### 网络响应观察

允许被动监听用户正常浏览产生的 JSON 响应，补充：

- 内容 ID。
- 内容类型。
- 分页游标。
- 收藏时间。
- 元数据。

限制：

- 不将未公开接口作为唯一方案。
- 不实现签名破解。
- 不伪造移动客户端请求。
- 不主动调用改变账号状态的接口。
- 解析失败必须回退 DOM。

### 12.5 无限滚动

扫描器必须：

1. 维护全局唯一集合。
2. 每次滚动后等待页面稳定。
3. 收集当前可见虚拟列表元素。
4. 保存后再继续滚动。
5. 支持“加载更多”按钮。
6. 不以当前 DOM 元素数量作为总数。

默认结束条件：

- 到达底部；
- 连续 5 次没有新条目；
- 无加载动画；
- 相关网络活动结束至少 2 秒；
- 无可点击“加载更多”。

报告示例：

```json
{
  "terminationReason": "no_new_items_after_5_cycles",
  "uniqueItems": 1328,
  "duplicateObservations": 74,
  "scrollIterations": 219,
  "completenessConfidence": "high"
}
```

### 12.6 唯一标识与 URL 规范化

优先级：

1. 今日头条内容 ID。
2. 规范化详情 URL。
3. `SHA-256(title + author + publishedAt)`。
4. `SHA-256(originalUrl)`。

规范化 URL：

- 删除 Fragment。
- 删除已知追踪参数。
- 保留决定内容身份的路径和 ID。
- 不修改图片 URL 的签名参数。

### 12.7 内容类型

| 类型 | 导入要求 |
|---|---|
| 普通文章 | 标题、作者、发布时间、正文、正文图片、原始链接。 |
| 微头条/短文本 | 完整文本、作者、时间、图片、原始链接。 |
| 图集 | 标题、说明、图片、图片说明、原始链接。 |
| 问答 | 问题、回答正文、回答作者、图片、原始链接。 |
| 视频 | 标题、作者、发布时间、简介、封面、时长、原始链接。 |
| 外部链接 | 默认保存元数据和链接；显式启用后可尝试外部正文。 |
| 付费/锁定 | 只保存当前用户正常可见部分。 |
| 已删除/失效 | 生成占位笔记，保留已知元数据和失败原因。 |
| 未识别 | 保存为 `unknown`，至少保留标题和 URL。 |

视频默认不下载媒体文件。

### 12.8 详情页提取

按顺序执行：

1. 站点专用提取器。
2. 页面结构化数据：JSON-LD、Open Graph、Meta、初始化状态。
3. Readability 回退。
4. 元数据占位笔记。

Readability 必须对克隆后的 DOM 运行；其输出仍需安全清洗。

### 12.9 正文清洗

删除：

- 脚本、样式、导航、广告、推荐、热榜、评论区、分享浮层。
- 跟踪像素、不可见元素和自动播放组件。
- 与正文无关的侧边栏和登录提示。

保留：

- 标题层级、段落、强调、列表、引用、表格、代码块、链接。
- 正文图片、图片说明和分隔线。

处理规则：

- 相对 URL 转绝对 URL。
- 识别 `data-src`、`data-original`、`srcset` 等懒加载属性。
- 连续空行最多两个。
- 空段落删除。
- 不执行下载 HTML 中的脚本。
- 外链保留为标准 Markdown 链接。

### 12.10 图片下载

要求：

- 必要时使用当前浏览器会话和正常 Referer。
- 验证 HTTP 状态和 `Content-Type`。
- 拒绝把 HTML 错误页保存为图片。
- 拒绝零字节附件。
- 支持 JPEG、PNG、WebP、GIF、SVG。
- 单张大小上限可配置。
- 失败最多重试 3 次并指数退避。
- 下载失败时保留远程链接并记录警告。

命名示例：

```text
001-图片说明-8c41ab3f.webp
002-image-3fd907aa.jpg
```

---

## 13. Obsidian 目标适配器

### 13.1 适配器标识

```text
adapter: obsidian
package: @inkmigrate/target-obsidian
```

### 13.2 Vault 验证

初始化和每次写入前必须确认：

- Vault 路径存在或用户明确允许创建。
- 路径可写。
- 最终输出路径位于 Vault 内。
- 不允许 `../`、符号链接或路径解析逃逸。
- `.obsidian` 可作为提示信号，但不是强制条件。
- 磁盘空间满足最低要求。

### 13.3 默认目录结构

```text
<Obsidian Vault>/
├── Imports/
│   └── InkMigrate/
│       ├── toutiao-main/
│       │   ├── 文章/
│       │   ├── 微头条/
│       │   ├── 图集/
│       │   ├── 问答/
│       │   ├── 视频/
│       │   ├── 失效内容/
│       │   ├── 未知类型/
│       │   └── _索引/
│       └── evernote-archive/
│           ├── <笔记本>/
│           └── _索引/
└── Attachments/
    └── InkMigrate/
        ├── toutiao-main/
        └── evernote-archive/
```

来源实例 ID 必须进入输出路径，避免多个账号或多次导出相互覆盖。

### 13.4 文件名规则

推荐：

```text
<标题>-<稳定短ID>.md
```

规则：

- Unicode NFC 规范化。
- 清理 Windows、macOS、Linux 不兼容字符。
- 处理 `CON`、`PRN`、`AUX` 等保留名称。
- 删除结尾句点和空格。
- 主体最大 100 字符，可配置。
- 标题不是唯一主键。
- 大小写不敏感文件系统上仍须避免冲突。
- 冲突时使用稳定 ID，而不是仅递增临时序号。

### 13.5 通用 YAML Properties

```yaml
---
title: "人工智能如何改变软件开发"
inkmigrate_id: "im:source-instance:fingerprint"
inkmigrate_version: 1
migration_job_id: "mig-20260622-143000-a81f"
source: "toutiao"
source_instance: "toutiao-main"
source_type: "article"
source_item_id: "7428193012345678901"
source_url: "https://www.toutiao.com/article/7428193012345678901/"
author: "示例作者"
published_at: 2025-12-20T10:35:00+08:00
favorited_at: 2026-01-04T21:13:00+08:00
imported_at: 2026-06-22T14:30:00+08:00
tags:
  - source/toutiao
  - type/article
  - status/imported
content_hash: "sha256:..."
---
```

规则：

- 使用 YAML 库生成，不手工拼接。
- 属性扁平化，不使用嵌套 Properties。
- 每个属性名唯一。
- 日期使用 ISO 8601。
- 不知道的字段省略，不伪造时间。
- `tags` 使用列表。
- `inkmigrate_id` 在目标 Vault 中必须唯一。
- 来源特有属性使用稳定的英文蛇形命名。

### 13.6 正文模板

```markdown
# 人工智能如何改变软件开发

> [!info] 来源信息
> - 来源：今日头条
> - 作者：示例作者
> - 发布时间：2025-12-20 10:35
> - 收藏时间：2026-01-04 21:13
> - [打开原文](https://www.toutiao.com/article/7428193012345678901/)

## 正文

正文第一段。

![[Attachments/InkMigrate/toutiao-main/7428193012345678901/001-cover.webp]]

正文第二段。

---

> [!note] 迁移说明
> 本文由 InkMigrate 在本地从用户自己的来源数据中导入。
```

### 13.7 附件路径与链接

默认：

```text
Attachments/InkMigrate/<source-instance>/<item-key>/
```

支持：

```yaml
linkStyle: wikilink
```

或：

```yaml
linkStyle: markdown
```

附件是普通 Vault 文件。写入后必须验证存在、非零字节、哈希和 MIME。

### 13.8 索引

不得把数千条内容放入一个超大索引文件。

默认按月份生成：

```text
Imports/InkMigrate/toutiao-main/_索引/2026-01.md
```

总入口只链接月份或笔记本索引：

```text
Imports/InkMigrate/toutiao-main/今日头条收藏索引.md
```

### 13.9 用户修改保护

首次写入后保存：

- `content_hash`：标准化正文哈希。
- `written_file_hash`：完整目标文件哈希。

再次运行：

1. 读取当前文件。
2. 计算完整哈希。
3. 与数据库比较。
4. 不一致则标记 `conflict`。
5. 默认不覆盖。

策略：

```yaml
overwritePolicy: preserve
```

支持：

- `preserve`：保留用户文件。
- `replace`：覆盖。
- `write-new`：写为 `.imported-new.md`。
- `metadata-only`：只补缺失属性，不改正文。

### 13.10 原子写入

1. 在同目录创建临时文件。
2. 写入并 Flush。
3. 解析 YAML 和 Markdown 基础结构。
4. 验证非空。
5. 原子 Rename。
6. 更新 SQLite。

禁止先覆盖正式文件再验证。


## 14. 今日头条源端清理：取消收藏

### 14.1 功能定义

内部统一使用 `unfavorite`。其含义仅为：

> 取消当前账号与指定内容之间的收藏关系。

不得：

- 删除原文章、视频或微头条。
- 删除本地 Obsidian 笔记或附件。
- 删除收藏夹。
- 修改收藏夹名称或分类。
- 操作清理计划之外的内容。
- 将“从某个收藏夹移除”猜测为“全局取消收藏”。

页面无法确认操作语义时，必须标记：

```text
unsupported_cleanup_semantics
```

并停止该条目。

### 14.2 开关和安全约束

配置总开关默认必须关闭：

```yaml
sourceCleanup:
  enabled: false
```

即使配置开启，仍需：

1. 指定已完成的 Migration Job。
2. 生成不可变清理计划。
3. 运行预演。
4. 正式命令带 `--execute`。
5. 在交互式终端输入含数量的确认短语。

### 14.3 CLI

```bash
inkmigrate cleanup status --source toutiao-main
inkmigrate cleanup plan \
  --source toutiao-main \
  --action unfavorite \
  --migration-job <job-id>

inkmigrate cleanup plan --source toutiao-main --action unfavorite --max-items 100
inkmigrate cleanup unfavorite --plan <plan-id> --dry-run
inkmigrate cleanup unfavorite --plan <plan-id> --execute
inkmigrate cleanup resume --job <cleanup-job-id>
inkmigrate cleanup verify --job <cleanup-job-id>
inkmigrate cleanup report --job <cleanup-job-id>
```

### 14.4 候选资格

条目必须同时满足：

- 迁移状态为 `verified`。
- Markdown 存在且非零字节。
- YAML 可解析。
- `source_item_id` 或 `canonical_url` 可用。
- 数据库与目标文件一致。
- 无未解决冲突。
- 不处于提取、写入或中断状态。
- 尚未确认为已取消收藏。

若要求附件完整，还必须满足：

- 所有本地附件存在。
- 附件非零字节。
- 哈希一致。
- Markdown 无失效本地附件链接。

### 14.5 清理计划

生成：

```text
reports/cleanup/
├── unfavorite-plan-<plan-id>.csv
├── unfavorite-plan-<plan-id>.json
└── unfavorite-plan-<plan-id>.md
```

计划 JSON：

```json
{
  "planId": "cleanup-20260622-143000-a81f",
  "sourceInstanceId": "toutiao-main",
  "migrationJobId": "mig-20260620-090000-b27a",
  "action": "unfavorite",
  "createdAt": "2026-06-22T14:30:00+08:00",
  "candidateCount": 87,
  "excludedCount": 13,
  "databaseSnapshotVersion": 174,
  "planHash": "sha256:...",
  "configHash": "sha256:...",
  "items": []
}
```

正式执行前重新计算计划哈希。哈希、配置或数据库快照不符合规则时拒绝执行。

### 14.6 人工确认

显示：

```text
即将取消今日头条收藏：87 条

本地笔记已验证：87
附件已验证：85
无附件内容：2
不符合条件并已排除：13

计划文件：reports/cleanup/unfavorite-plan-....csv

请输入以下内容继续：
UNFAVORITE 87
```

只有完全匹配才继续。

拒绝条件：

- 数量不一致。
- 计划不存在或哈希变化。
- 总开关关闭。
- 登录失效。
- 本地验证已过期。
- 超过 `maxItemsPerRun`。
- 缺少 `--execute`。
- 非交互环境。

不支持：

```text
--yes
--force
--no-confirm
```

### 14.7 操作流程

每个条目：

```text
重新验证本地笔记
→ 打开来源页面
→ 检查登录和安全验证
→ 探测当前收藏状态
→ 执行取消收藏
→ 等待反馈
→ 重新读取状态
→ 必要时刷新并复核
→ 更新数据库
→ 写入审计记录
```

### 14.8 操作前状态

```text
favorited
not_favorited
unknown
login_required
challenge_required
content_unavailable
```

| 状态 | 处理 |
|---|---|
| `favorited` | 可执行取消收藏。 |
| `not_favorited` | 标记 `already_unfavorited`，不得点击。 |
| `unknown` | 跳过，标记 `state_unknown`。 |
| `login_required` | 暂停整个任务。 |
| `challenge_required` | 暂停，由用户手动处理。 |
| `content_unavailable` | 转收藏列表复核，不直接判成功。 |

### 14.9 操作方式优先级

1. 内容详情页明确的“已收藏”状态按钮。
2. 收藏列表中的单条取消操作。
3. 受控批量编辑模式。

禁止：

- 未经验证的私有写接口。
- 坐标点击。
- 只根据按钮中文文案定位。
- 只根据压缩 CSS class 定位。
- “全选全部收藏”。
- 对未知状态的切换按钮重复点击。

P0 优先实现逐条取消收藏；批量模式为 P1 优化。

### 14.10 操作后复核

至少获得一个强信号和一个辅助信号。

强信号：

- 刷新后按钮变为未收藏状态。
- 重新打开后明确未收藏。
- 重新扫描收藏页条目不存在。
- 页面结构化状态明确为未收藏。

辅助信号：

- 成功提示。
- 对应正常请求返回成功。
- 收藏总数变化。
- 条目从 DOM 移除。

只有通过复核才设为：

```text
unfavorited_verified
```

点击后超时或崩溃：

1. 不立即再次点击。
2. 重新进入页面并先检查状态。
3. 已取消则记成功。
4. 仍收藏才允许重试。
5. 不明确则 `action_result_unknown`。

### 14.11 二次扫描

任务结束后重新扫描计划范围：

```text
confirmed_absent
still_present
unable_to_confirm
```

- `confirmed_absent`：保持成功。
- `still_present`：改为 `verification_failed`。
- `unable_to_confirm`：改为 `action_result_unknown`。
- 仍存在的条目不自动再次点击，必须进入新计划。

### 14.12 清理状态机

```text
not_requested
→ eligible
→ planned
→ prechecking
→ executing
→ verifying
→ unfavorited_verified
```

其他终态：

```text
already_unfavorited
skipped_note_missing
skipped_note_invalid
skipped_assets_invalid
skipped_conflict
skipped_not_in_plan
state_unknown
action_result_unknown
retryable_failed
permanent_failed
login_required
challenge_required
unsupported_cleanup_semantics
verification_failed
interrupted
```

### 14.13 排他锁

```text
.inkmigrate/locks/cleanup-<source-instance>.lock
```

同一来源实例只允许一个清理任务。锁文件必须包含 PID、启动时间和 Job ID，并支持识别陈旧锁。

### 14.14 强制暂停条件

- 登录失效。
- 验证码、滑块或账号安全验证。
- 页面出现账号异常提示。
- 连续 3 条失败。
- 操作语义不明。
- 页面结构明显变化。
- 计划条目无法对应当前页面。
- 批量已选数量不一致。
- SQLite 无法写入。
- 计划哈希失效。
- 发现并发清理任务。

### 14.15 清理报告

```text
reports/cleanup/<cleanup-job-id>/
├── summary.md
├── summary.json
├── success.csv
├── failed.csv
├── unknown.csv
└── skipped.csv
```

报告包括：

- 计划数、执行数、成功数、原本已取消数。
- 跳过、失败、未知状态。
- 登录或安全验证暂停次数。
- 批次数和二次扫描结果。
- 每条的前置状态、动作状态、后置状态和错误码。

---

## 15. Evernote / 印象笔记来源适配器（v2.0 规划）

### 15.1 适配器标识

```text
adapter: evernote
package: @inkmigrate/source-evernote
```

能力：

```yaml
authMode: file
discoveryMode: file-stream
supportsIncrementalScan: false
supportsAssets: true
supportsInternalLinks: true
supportsSourceCleanup: false
supportedInputFormats:
  - enex
  - html
```

### 15.2 输入方式

优先支持用户通过桌面客户端导出的：

- `.enex` 文件。
- 包含多个 `.enex` 的目录。
- Evernote HTML 导出目录或 ZIP 解压目录。

InkMigrate 不直接登录 Evernote，不要求账号密码，不将 Evernote API 作为首要方案。

### 15.3 扫描要求

- 使用流式 XML 解析，不把完整 ENEX 载入 DOM。
- 扫描多个文件时逐文件建立清单。
- 记录文件大小、修改时间、SHA-256 和解析结果。
- 每个 `<note>` 必须对应一条数据库记录或明确解析失败记录。
- 输入总数必须与成功、降级、失败、跳过之和严格相等。
- XML 某条笔记损坏时，尽可能隔离该条，不无条件放弃整个文件。

### 15.4 笔记身份

优先级：

1. 导出数据中可用的稳定 GUID。
2. 可解析的 Evernote App Link 身份。
3. `SHA-256(export-file-hash + note-ordinal + title + createdAt)`。

不得以标题作为唯一主键。

### 15.5 笔记本和 Stack

- 默认从 ENEX 文件名推断笔记本名称。
- 支持用户映射清单覆盖。
- 支持 `Stack@@@Notebook.enex` 命名约定重建目录层次。
- 默认导出缺少 Stack 信息时，报告必须说明无法自动还原。
- 同名笔记本通过来源文件哈希和稳定短 ID 区分。

示例映射：

```yaml
evernote:
  notebookMappings:
    "Work@@@Projects.enex":
      stack: "Work"
      notebook: "Projects"
```

### 15.6 ENML 转换

必须处理：

- 段落、标题、强调、列表、引用、表格、分隔线。
- `en-todo` 转 Markdown 复选框。
- `en-media` 根据资源哈希替换为本地附件链接。
- 链接、图片尺寸和说明。
- 代码块和预格式文本。
- HTML Web Clipping 内容。

无法安全转换的节点：

- 保留为经过清洗的 HTML，或生成明确占位块。
- 记录节点类型和数量。
- 不得静默删除正文片段。

### 15.7 附件和资源

Evernote 资源至少包括：

- 图片。
- PDF。
- Office 文档。
- 音频。
- 其他二进制附件。

要求：

- 通过资源哈希关联 `en-media`。
- 验证 Base64 解码结果。
- 验证 MIME、字节数和 SHA-256。
- 原文件名不可用时，使用 MIME 推断扩展名。
- 重复资源可按内容哈希去重。
- 未被正文引用的资源仍需保留，并在“附件”区列出。
- 资源缺失或哈希不一致必须进入报告。

### 15.8 元数据

尽可能保留：

- 原标题。
- 创建时间、更新时间。
- 作者。
- 标签。
- 笔记本和 Stack。
- 来源 URL。
- 地理位置（显式启用时）。
- Reminder 元数据（如输入存在）。
- 来源应用和来源类型。

Obsidian Properties 示例：

```yaml
---
title: "原始笔记标题"
source: "evernote"
source_instance: "evernote-archive"
source_type: "note"
source_item_id: "..."
source_notebook: "Projects"
source_stack: "Work"
source_url: "https://example.com/original"
created_at: 2019-05-03T08:20:00+08:00
updated_at: 2025-11-12T16:45:00+08:00
imported_at: 2026-06-22T14:30:00+08:00
tags:
  - source/evernote
  - notebook/projects
  - project/example
content_hash: "sha256:..."
---
```

### 15.9 标签

- 保留导出的标签字符串。
- 对 Obsidian 不兼容字符按明确规则转义或映射。
- 原标签值可以额外保存为 `source_tags` 列表。
- 标签层级无法从输入恢复时不得猜测。
- 支持用户配置将 `/` 分隔标签视为层级标签。

### 15.10 内部链接

Evernote 内部链接可能使用应用链接或 GUID。实现两遍处理：

1. 第一遍扫描所有笔记并建立身份映射。
2. 第二遍将可解析的内部链接重写为 Obsidian Wikilink 或 Markdown 链接。

无法解析时：

- 保留原始链接。
- 在 `unresolved-links.csv` 中记录来源笔记、链接文本和目标 URI。
- 不得删除链接文字。

### 15.11 加密内容

- 第一版 Evernote 适配器不破解或自动解密加密区域。
- 保留加密块占位、算法元数据和警告。
- 不在配置文件或日志中保存解密密码。
- 后续如支持解密，必须使用交互式输入和内存短期持有。

### 15.12 HTML 导出

HTML 作为 ENEX 的补充输入：

- 读取导出目录的 HTML、附件和索引。
- 不执行脚本。
- 清洗不可信 HTML。
- 根据目录结构和导出索引推断笔记本。
- ENEX 与 HTML 同时提供时，默认以 ENEX 元数据为准，以 HTML 作为正文或附件回退。

### 15.13 Evernote 完整性对账

报告必须包含：

```text
输入 ENEX 文件数
输入笔记总数
成功笔记数
降级笔记数
失败笔记数
重复身份数
资源总数
成功资源数
缺失资源数
内部链接总数
已重写链接数
未解析链接数
```

任何差额均视为验证失败，不得只输出“导入完成”。

---

## 16. 数据库设计

SQLite 文件：

```text
.inkmigrate/data/inkmigrate.sqlite
```

启用：

- WAL。
- Foreign Keys。
- Schema Migration。
- Busy Timeout。

### 16.1 `source_instances`

```sql
id TEXT PRIMARY KEY
adapter_kind TEXT NOT NULL
adapter_version TEXT NOT NULL
display_name TEXT
config_hash TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 16.2 `target_instances`

```sql
id TEXT PRIMARY KEY
adapter_kind TEXT NOT NULL
adapter_version TEXT NOT NULL
display_name TEXT
config_hash TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 16.3 `migration_jobs`

```sql
id TEXT PRIMARY KEY
source_instance_id TEXT NOT NULL
target_instance_id TEXT NOT NULL
plan_id TEXT
status TEXT NOT NULL
scan_count INTEGER NOT NULL DEFAULT 0
candidate_count INTEGER NOT NULL DEFAULT 0
verified_count INTEGER NOT NULL DEFAULT 0
degraded_count INTEGER NOT NULL DEFAULT 0
failed_count INTEGER NOT NULL DEFAULT 0
conflict_count INTEGER NOT NULL DEFAULT 0
started_at TEXT
finished_at TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 16.4 `source_items`

至少包括：

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
source_instance_id TEXT NOT NULL
external_id TEXT
fingerprint TEXT NOT NULL
canonical_url TEXT
original_url TEXT
title TEXT
content_kind TEXT NOT NULL
source_position INTEGER
discovered_at TEXT NOT NULL
status TEXT NOT NULL
retry_count INTEGER NOT NULL DEFAULT 0
last_error_code TEXT
last_error_message TEXT
content_hash TEXT
source_metadata_json TEXT NOT NULL DEFAULT '{}'
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

索引：

```sql
UNIQUE(source_instance_id, fingerprint)
UNIQUE(source_instance_id, external_id) WHERE external_id IS NOT NULL
```

### 16.5 `assets`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
source_item_id INTEGER NOT NULL
external_id TEXT
original_url TEXT
source_hash TEXT
local_staging_path TEXT
target_path TEXT
mime_type TEXT
byte_size INTEGER
sha256 TEXT
status TEXT NOT NULL
retry_count INTEGER NOT NULL DEFAULT 0
last_error_code TEXT
last_error_message TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 16.6 `target_artifacts`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
migration_job_id TEXT NOT NULL
source_item_id INTEGER
artifact_kind TEXT NOT NULL
target_instance_id TEXT NOT NULL
relative_path TEXT NOT NULL
content_hash TEXT
written_file_hash TEXT
status TEXT NOT NULL
verified_at TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

唯一约束：

```sql
UNIQUE(target_instance_id, relative_path)
UNIQUE(migration_job_id, source_item_id, artifact_kind)
```

### 16.7 `attempts`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
job_id TEXT NOT NULL
source_item_id INTEGER
stage TEXT NOT NULL
started_at TEXT NOT NULL
finished_at TEXT
success INTEGER
error_code TEXT
error_message TEXT
http_status INTEGER
diagnostic_path TEXT
created_at TEXT NOT NULL
```

不得记录 Cookie、Authorization、验证码、手机号或完整请求头。

### 16.8 `cleanup_plans`

```sql
id TEXT PRIMARY KEY
source_instance_id TEXT NOT NULL
migration_job_id TEXT NOT NULL
action TEXT NOT NULL
plan_hash TEXT NOT NULL
config_hash TEXT NOT NULL
candidate_count INTEGER NOT NULL
excluded_count INTEGER NOT NULL
status TEXT NOT NULL
created_at TEXT NOT NULL
```

### 16.9 `cleanup_jobs`

```sql
id TEXT PRIMARY KEY
plan_id TEXT NOT NULL
plan_hash TEXT NOT NULL
action TEXT NOT NULL
status TEXT NOT NULL
candidate_count INTEGER NOT NULL
processed_count INTEGER NOT NULL DEFAULT 0
success_count INTEGER NOT NULL DEFAULT 0
skipped_count INTEGER NOT NULL DEFAULT 0
failed_count INTEGER NOT NULL DEFAULT 0
unknown_count INTEGER NOT NULL DEFAULT 0
started_at TEXT
finished_at TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 16.10 `cleanup_items`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
job_id TEXT NOT NULL
source_item_id INTEGER NOT NULL
precheck_status TEXT NOT NULL
pre_action_state TEXT
action_status TEXT NOT NULL
post_action_state TEXT
attempt_count INTEGER NOT NULL DEFAULT 0
action_started_at TEXT
action_finished_at TEXT
verified_at TEXT
last_error_code TEXT
last_error_message TEXT
diagnostic_path TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
UNIQUE(job_id, source_item_id)
```

### 16.11 数据库事务

- 每个条目关键状态转换在事务中完成。
- 文件写入和数据库更新使用可恢复的两阶段约定。
- 启动时扫描 `writing`、`executing` 等悬挂状态并转为 `interrupted` 或重新验证。
- 数据库迁移失败必须回滚并停止。


## 17. 幂等、去重与冲突

### 17.1 来源去重

来源条目在同一来源实例内通过以下组合判定：

- 稳定外部 ID。
- 规范化 URL。
- 来源格式内 GUID。
- 确定性 Fingerprint。

不允许仅通过标题去重。

### 17.2 目标幂等

重复运行必须满足：

- 已验证且内容未变化的条目直接跳过。
- 不生成第二篇重复笔记。
- 不重复写入相同附件。
- 新条目正常追加。
- 目标路径由稳定身份确定。

### 17.3 附件去重

- 同一条目内以 SHA-256 去重。
- 跨条目全局去重为可选功能。
- 若使用全局去重，必须确保删除某篇笔记不会影响其他笔记附件。
- 数据库记录每个逻辑引用，不因物理文件共享而丢失关系。

### 17.4 用户编辑保护

- `written_file_hash` 与磁盘当前哈希不一致时默认 `conflict`。
- 冲突不能被普通 `resume` 自动覆盖。
- 冲突解决必须通过配置策略或独立命令。

```bash
inkmigrate conflict list --job <job-id>
inkmigrate conflict resolve --artifact <id> --strategy preserve
```

### 17.5 来源内容变化

同一来源条目在后续扫描中正文变化时：

- 保存新的 `content_hash`。
- 若目标未被用户修改，可按策略更新。
- 若目标被用户修改，产生冲突。
- 迁移报告应区分“新条目”和“来源内容更新”。

---

## 18. 限速、重试和中断

### 18.1 默认抓取参数

```yaml
crawl:
  concurrency: 1
  intervalMs: 1500
  navigationTimeoutMs: 45000
  extractionTimeoutMs: 30000
  maxRetries: 3
  retryBackoffMs:
    - 3000
    - 10000
    - 30000
```

### 18.2 规则

- 网页详情页默认并发 1，最大可配置为 3。
- HTTP 429 立即暂停并延长退避。
- 连续认证错误达到阈值时停止。
- 404、内容删除等永久错误不持续重试。
- 文件格式错误根据文件和条目粒度隔离。
- 清理动作的重试次数独立于读取重试。

### 18.3 `Ctrl+C`

第一次 `Ctrl+C`：

- 停止领取新任务。
- 完成当前数据库事务。
- 将未完成条目标记为 `interrupted`。
- 安全关闭浏览器和数据库。

第二次 `Ctrl+C` 可强制退出，但启动恢复时必须检测悬挂状态。

### 18.4 任务锁

```text
.inkmigrate/locks/migration-<source>-<target>.lock
.inkmigrate/locks/cleanup-<source>.lock
```

锁包含：

- PID。
- 主机名。
- Job ID。
- 启动时间。
- 心跳时间。

---

## 19. 安全与隐私

### 19.1 敏感目录

`.gitignore` 至少包含：

```gitignore
.inkmigrate/
reports/
logs/
playwright/.auth/
*.sqlite
*.sqlite-shm
*.sqlite-wal
*.enex
```

示例 Fixture 必须经过脱敏，不能直接提交用户真实 ENEX、Cookie 或收藏页面。

### 19.2 日志脱敏

统一脱敏：

- Cookie。
- Token。
- Authorization。
- 手机号和邮箱。
- 验证码。
- URL 中的敏感查询参数。
- 本地用户名和用户主目录。
- 完整 Vault 路径；报告中可使用缩写。

### 19.3 网络范围

默认只允许：

- 来源网站正常页面域名。
- 页面实际引用的附件/CDN 域名。
- 用户明确启用外部链接提取后的目标域名。

禁止：

- 遥测服务器。
- 云存储。
- 第三方分析服务。
- 外部 AI API。

### 19.4 不可信内容

- HTML、ENML 和导出 HTML 视为不可信输入。
- JSDOM 禁止脚本执行和远程资源自动加载。
- Readability 输出必须再次 Sanitization。
- SVG 按配置决定保留、清洗或转为远程链接。
- 文件扩展名不能替代 MIME 和内容检查。

### 19.5 诊断数据

诊断目录：

```text
.inkmigrate/diagnostics/<job-id>/<item-key>/
├── screenshot.png
├── sanitized.html
└── error.json
```

要求：

- HTML 先清理 Token、手机号、用户昵称等敏感信息。
- 截图只在失败时保存。
- 默认不录制全程视频。
- 诊断文件不写入 Vault。
- 提供清理命令：

```bash
inkmigrate diagnostics clear
```

### 19.6 源端操作限制

- 不使用 stealth 插件。
- 不绕过验证码或安全验证。
- 不构造来源平台私有签名。
- 不进行账号内容修改，除非适配器能力和清理计划明确允许。

---

## 20. 可观测性和诊断

### 20.1 日志

日志分为：

- 控制台人类可读输出。
- 本地 JSONL 结构化日志。

日志字段：

```text
timestamp
level
job_id
source_instance_id
target_instance_id
source_item_id
stage
event_code
message
duration_ms
retry_count
```

### 20.2 错误模型

所有错误转换为领域错误：

```ts
export interface InkMigrateError {
  code: string;
  category:
    | 'config'
    | 'auth'
    | 'network'
    | 'parse'
    | 'extract'
    | 'asset'
    | 'target'
    | 'verify'
    | 'cleanup'
    | 'internal';
  retryable: boolean;
  userMessage: string;
  technicalMessage?: string;
  cause?: unknown;
}
```

### 20.3 诊断信息

页面结构变化时，应指出：

- 失败阶段。
- 尝试过的候选选择器名称。
- 页面 URL 和标题。
- 当前登录状态。
- 是否检测到安全验证。
- 是否生成降级笔记。

不得把整个 HTML 或请求头直接打印到控制台。

### 20.4 状态显示

```text
任务：mig-20260622-143000-a81f
来源：toutiao-main
目标：personal-vault

扫描：1328
已验证：1194
已降级：83
等待处理：21
可重试失败：17
永久失败：8
冲突：5
```

---

## 21. 报告规范

### 21.1 扫描报告

```text
reports/<job-id>/scan-preview.csv
reports/<job-id>/scan-report.json
reports/<job-id>/scan-report.md
```

包含：

- 扫描开始和结束时间。
- 唯一条目数。
- 重复观察数。
- 按内容类型统计。
- 终止原因。
- 完整性置信度。
- 扫描器和适配器版本。

### 21.2 迁移报告

包含：

- 计划数和实际处理数。
- 成功、降级、失败、冲突和跳过。
- 按来源类型统计。
- 附件成功和失败数量。
- 重试次数。
- 未解析链接。
- 人工处理清单。

### 21.3 可行动错误

错误描述示例：

```text
正文提取失败：
- 站点专用选择器未匹配；
- JSON-LD 中无正文；
- Readability 返回 null；
- 已创建只含元数据的占位笔记。
```

不得只写“失败”或“未知错误”。

### 21.4 隐私

报告不得包含：

- Cookie、Token、Authorization。
- 登录验证码。
- 完整认证 Profile。
- 未脱敏请求头。

---

## 22. CLI 完整定义

```bash
inkmigrate --help
inkmigrate --version

inkmigrate init
inkmigrate config validate
inkmigrate config upgrade

inkmigrate source list
inkmigrate source add <adapter> --id <id>
inkmigrate source validate --source <id>

inkmigrate target list
inkmigrate target add <adapter> --id <id>
inkmigrate target validate --target <id>

inkmigrate auth login --source <id>
inkmigrate auth status --source <id>
inkmigrate auth clear --source <id>

inkmigrate scan --source <id>
inkmigrate scan --source <id> --max-items 20

inkmigrate migrate --source <id> --target <id>
inkmigrate migrate --source <id> --target <id> --dry-run
inkmigrate resume --job <job-id>
inkmigrate retry --job <job-id> --status <status>
inkmigrate verify --job <job-id>
inkmigrate status --job <job-id>
inkmigrate report --job <job-id>

inkmigrate conflict list --job <job-id>
inkmigrate conflict resolve --artifact <id> --strategy <strategy>

inkmigrate cleanup status --source <id>
inkmigrate cleanup plan --source <id> --action unfavorite --migration-job <job-id>
inkmigrate cleanup unfavorite --plan <plan-id> --dry-run
inkmigrate cleanup unfavorite --plan <plan-id> --execute
inkmigrate cleanup resume --job <cleanup-job-id>
inkmigrate cleanup verify --job <cleanup-job-id>
inkmigrate cleanup report --job <cleanup-job-id>

inkmigrate diagnostics clear
inkmigrate doctor
```

### 22.1 退出码

| 退出码 | 含义 |
|---:|---|
| 0 | 全部成功，或仅发生按规则允许的跳过/降级。 |
| 1 | 存在一般迁移失败。 |
| 2 | 配置错误。 |
| 3 | 认证失效。 |
| 4 | 目标不可写。 |
| 5 | 数据库损坏或迁移失败。 |
| 6 | 用户中断。 |
| 7 | 目标验证不通过。 |
| 8 | 计划不合法或哈希失效。 |
| 9 | 源端清理部分失败。 |
| 10 | 清理结果存在未知状态。 |
| 11 | 清理过程中认证失效。 |
| 12 | 检测到安全验证。 |
| 13 | 功能或能力未启用。 |
| 14 | 任务锁冲突。 |
| 15 | 来源文件格式无效。 |
| 16 | 适配器 API 不兼容。 |
| 17 | 目标适配器写入失败。 |

---

## 23. 代码结构

```text
packages/core/src/
├── application/
│   ├── scan-service.ts
│   ├── migration-service.ts
│   ├── verification-service.ts
│   ├── cleanup-service.ts
│   └── report-service.ts
├── domain/
│   ├── models.ts
│   ├── states.ts
│   ├── errors.ts
│   ├── plans.ts
│   └── capabilities.ts
├── adapters/
│   ├── source-adapter.ts
│   ├── target-adapter.ts
│   └── registry.ts
├── storage/
│   ├── database.ts
│   ├── migrations/
│   └── repositories/
├── security/
│   ├── redactor.ts
│   └── path-guard.ts
├── runtime/
│   ├── locks.ts
│   ├── signals.ts
│   └── scheduler.ts
└── index.ts

packages/source-toutiao/src/
├── auth/
├── browser/
├── discovery/
├── extraction/
├── cleanup/
├── selectors/
├── diagnostics/
└── index.ts

packages/source-evernote/src/
├── enex/
├── enml/
├── html/
├── resources/
├── links/
├── fixtures/
└── index.ts

packages/target-obsidian/src/
├── frontmatter/
├── markdown/
├── assets/
├── paths/
├── indexes/
├── verifier/
└── index.ts
```

### 23.1 依赖建议

```text
playwright
commander
zod
yaml
better-sqlite3
jsdom
@mozilla/readability
turndown
p-limit
pino
vitest
```

XML 解析器应选择维护活跃、支持流式处理并可禁用外部实体的库。

### 23.2 编码规范

- TypeScript `strict: true`。
- 禁止生产代码中的 `any`，除非有明确边界封装和注释。
- 所有公共接口导出类型。
- 所有 I/O 使用显式错误转换。
- 选择器、错误码、状态常量集中管理。
- 不在业务逻辑中散落魔法字符串。

---

## 24. 测试策略

### 24.1 单元测试

至少覆盖：

- URL 规范化。
- Fingerprint。
- 文件名清理。
- Windows 保留名称。
- Unicode NFC。
- 路径穿越和符号链接逃逸。
- YAML 特殊字符。
- HTML/ENML 到 Markdown。
- 懒加载图片解析。
- MIME 和扩展名推断。
- 内容哈希。
- 用户修改检测。
- 配置 Schema。
- 日志脱敏。
- 状态机和错误码。
- 计划哈希。
- 排他锁。

### 24.2 适配器契约测试

`@inkmigrate/testkit` 提供统一契约：

- 来源扫描的每个 Ref 必须有 Fingerprint。
- 来源提取失败必须返回领域错误。
- 目标写入必须原子。
- 目标验证不得只信任数据库。
- 不支持的能力必须明确拒绝。

每个适配器都必须通过契约测试。

### 24.3 今日头条 Fixture

```text
tests/fixtures/toutiao/
├── article.html
├── short-post.html
├── gallery.html
├── video.html
├── deleted.html
├── login-required.html
├── challenge.html
├── favorites-list.html
└── network-responses/
```

清理 Fixture：

```text
tests/fixtures/toutiao-cleanup/
├── favorited-article.html
├── not-favorited-article.html
├── list-edit-mode.html
├── unfavorite-success.html
├── unfavorite-failed.html
└── ambiguous-button-state.html
```

### 24.4 Evernote Fixture

```text
tests/fixtures/evernote/
├── basic.enex
├── multiple-notes.enex
├── duplicate-titles.enex
├── tags.enex
├── resources.enex
├── internal-links.enex
├── encrypted-block.enex
├── malformed-note.enex
├── large-stream.enex
└── html-export/
```

Fixture 必须为人工构造或脱敏数据。

### 24.5 集成测试

覆盖：

1. 扫描到 SQLite。
2. 提取到标准模型。
3. 转 Markdown。
4. 写临时 Vault。
5. 验证 YAML 和附件。
6. 再次运行无重复。
7. 用户修改后产生冲突。
8. 中断后恢复。
9. Dry-run 无目标写入。
10. 清理 Dry-run 无点击。
11. 清理结果不明时不重复点击。
12. Evernote 资源哈希和内部链接两遍处理。

### 24.6 端到端测试

今日头条使用测试账号或用户本人账号，至少：

- 10 篇文章。
- 3 条短文本。
- 2 个图集。
- 2 个视频。
- 1 条失效内容。
- 1 条提取失败内容。

真实账号 Cookie 不进入 CI。

Evernote v2.0 验收数据至少：

- 1000 篇人工生成 ENEX 笔记。
- 重复标题和大小写冲突。
- 多种资源。
- 内部链接环。
- 畸形单条笔记。

### 24.7 跨平台测试

CI 至少覆盖：

- Windows。
- macOS。
- Linux。

重点验证路径、中文文件名、大小写冲突和原子重命名差异。

### 24.8 安全测试

- XML 外部实体禁用。
- HTML 脚本不执行。
- SVG 和 MIME 欺骗。
- ZIP Slip（支持 ZIP 时）。
- 路径穿越。
- 日志敏感信息泄露。
- 计划文件篡改。

---

## 25. 性能与可靠性要求

### 25.1 内存

- 不把全部来源正文或附件加载到内存。
- ENEX 使用流式解析。
- 附件使用流式 I/O。
- 迁移 1000 条今日头条记录时内存应保持稳定。
- Evernote v2.0 应支持万级笔记清单，内存增长不与总正文大小线性对应。

### 25.2 数据库

- 批量扫描使用小批次事务。
- 长任务定期 Checkpoint WAL。
- 提供数据库完整性检查：

```bash
inkmigrate doctor --database
```

### 25.3 失败隔离

- 单条失败不能终止全局迁移。
- 数据库、目标不可写、认证失效、计划篡改等系统性错误必须停止。
- 报告生成失败不得改变已成功迁移条目的状态，但必须返回非零退出码。

---

## 26. 验收标准

### 26.1 核心架构

1. CLI 使用 `inkmigrate` 名称。
2. 来源和目标通过注册表加载。
3. 核心包不依赖具体适配器。
4. 新增来源无需修改 Obsidian 写入核心。
5. 新增目标无需修改今日头条解析逻辑。
6. 适配器 API 不兼容时明确拒绝。
7. 配置错误在执行前一次性列出。
8. 数据库 Schema 可迁移和回滚。

### 26.2 今日头条迁移

1. 用户无需填写密码、Cookie 或 Token。
2. 手动登录后重启仍可复用认证。
3. 能完成无限滚动扫描并报告结束原因。
4. 可正常访问的普通文章测试样本正文提取成功率不低于 95%。
5. 正文失败仍生成元数据占位笔记。
6. 单篇失败不终止全局任务。
7. `Ctrl+C` 后数据库不损坏。
8. `resume` 能继续剩余条目。
9. 连续执行两次，重复笔记为 0。
10. 连续执行两次，重复附件为 0。

### 26.3 Obsidian 目标

1. 所有成功笔记 YAML 可解析。
2. 所有本地附件链接存在且非零字节。
3. 输出路径不逃逸 Vault。
4. 中文和跨平台文件名正常。
5. 用户编辑过的笔记默认不覆盖。
6. 不依赖 Obsidian 社区插件即可读取。
7. 索引不会生成单一超大文件。
8. 每篇笔记包含稳定 `inkmigrate_id`。

### 26.4 今日头条清理

1. 默认不产生源端写操作。
2. 修改配置本身不足以触发取消收藏。
3. 未验证条目绝不进入计划。
4. 没有计划无法执行。
5. 计划被修改后拒绝执行。
6. 确认文本数量必须完全匹配。
7. 每条操作前检查当前状态。
8. 每条操作后复核。
9. 结果不明时不盲目重试。
10. 重复运行不会重新收藏。
11. 不删除本地文件。
12. 不删除收藏夹。
13. 不操作计划外内容。
14. 中断后可恢复且不重复已成功动作。
15. 二次扫描仍存在时不得报成功。

### 26.5 Evernote v2.0

1. ENEX 输入笔记总数与结果总数一致。
2. 不因单条畸形笔记静默丢弃其他笔记。
3. 标题重复和大小写冲突不覆盖。
4. 创建/更新时间、标签和笔记本尽可能保留。
5. `en-media` 资源正确映射并验证哈希。
6. 可解析的内部链接转换为 Obsidian 链接。
7. 未解析链接进入报告且保留原链接文字。
8. 加密内容不被误删或伪装为已迁移。
9. 1000 条生成测试数据重复运行无重复。
10. 不提供 Evernote 源端删除功能。

### 26.6 安全

1. Git 状态无认证 Profile、Cookie、真实 ENEX 和数据库。
2. 日志无 Cookie、Token、手机号和验证码。
3. 不执行输入 HTML/ENML 脚本。
4. 不支持验证码破解或 stealth。
5. 清理操作在代码审查中可被明确定位。

---

## 27. 交付物

```text
README.zh-CN.md
README.md
LICENSE
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.base.json
inkmigrate.example.yaml
.gitignore
apps/
packages/
tests/
docs/
scripts/
examples/
```

### 27.1 README 必须包含

- 项目定位和数据安全说明。
- Node.js、pnpm、Playwright 安装。
- 从零初始化。
- 添加今日头条来源和 Obsidian 目标。
- 手动登录。
- 20 条小规模扫描和迁移。
- 正式迁移。
- 中断恢复。
- 验证和报告。
- 源端清理的风险和确认流程。
- 登录失效处理。
- 页面结构变化诊断。
- 清除认证状态。
- 备份 Vault。
- Evernote ENEX 适配器路线图。

### 27.2 工程质量

- 提交锁文件。
- 无类型错误。
- 无失败测试。
- 不包含不可运行的伪代码。
- 所有命令帮助文本可用。
- 示例配置通过 Schema。
- 生产依赖来源清晰且维护状态可接受。

---

## 28. 开发顺序

### 阶段 1：基础工程

1. Monorepo 和 TypeScript 严格模式。
2. 配置 Schema。
3. SQLite 和 Schema Migration。
4. 领域模型、错误码、状态机。
5. 来源/目标适配器注册表。

### 阶段 2：Obsidian 目标

1. 路径防护。
2. 文件名清理。
3. Properties 和 Markdown 渲染。
4. 附件写入。
5. 原子写入和验证。
6. 冲突保护。

### 阶段 3：今日头条读取

1. 浏览器 Profile。
2. 手动登录。
3. 收藏页定位。
4. DOM 和网络观察扫描。
5. 详情提取。
6. 正文清洗和图片下载。
7. Fixture 测试。

### 阶段 4：迁移闭环

1. Job 调度。
2. 断点续传。
3. 重试。
4. 索引。
5. 报告。
6. 端到端验证。

### 阶段 5：源端清理

1. 候选资格。
2. 计划和哈希。
3. Dry-run。
4. 单条取消收藏。
5. 前后状态复核。
6. 恢复和二次扫描。
7. 审计报告。
8. 可选受控批量模式。

### 阶段 6：Evernote v2.0

1. ENEX 流式扫描。
2. ENML 转换。
3. 资源提取。
4. 笔记本和标签。
5. 内部链接两遍重写。
6. HTML 回退。
7. 万级清单验证和报告。

每个阶段结束必须执行类型检查、测试和构建，不得积累未修复错误到下一阶段。

---

## 29. AI 编程工具执行指令

> 请按照《InkMigrate 产品需求与技术规格》创建一个可实际运行的 TypeScript Monorepo。项目名、仓库名和 CLI 统一使用 InkMigrate / `inkmigrate`，不得沿用 `tt2obs`。
>
> 先交付 P0，再完成 P1；Evernote 适配器按 P2 实施，但 P0 的核心接口、数据库和目录必须从第一天起支持多来源和多目标，禁止把通用表命名为 `favorites` 或把核心流程写死到今日头条。
>
> 来源适配器、目标适配器和源端清理能力必须解耦。今日头条适配器不能直接写 Obsidian 文件；Obsidian 适配器不能访问 Playwright 页面；核心层只处理标准领域模型。
>
> 登录无法自动识别、收藏页无法定位或页面结构变化时，进入人工辅助或安全暂停，不得要求用户提供密码、Cookie、Token，不得使用验证码破解、stealth、坐标点击或签名破解。
>
> 所有目标文件使用临时文件、校验和原子重命名。任何单条内容失败不能终止整个迁移。每个输入条目必须有明确结果，不得静默丢失。
>
> `sourceCleanup.enabled` 默认必须为 `false`。取消收藏只能处理已验证且进入不可变计划的条目。每次点击前检查收藏状态，每次点击后复核。状态不明时不得盲目重试，因为切换型按钮可能把内容重新收藏。不得删除收藏夹、原文章、本地笔记或附件。
>
> Evernote v2.0 使用用户导出的 ENEX/HTML 文件，不直接登录账号。ENEX 必须流式解析；资源通过哈希关联；内部链接使用两遍处理；输入总数与结果总数必须严格对账。
>
> 每完成一个阶段运行：
>
> ```bash
> pnpm install
> pnpm typecheck
> pnpm test
> pnpm build
> pnpm inkmigrate --help
> ```
>
> 完成源端清理后额外运行：
>
> ```bash
> pnpm inkmigrate cleanup --help
> ```
>
> 修复全部类型错误、测试错误和构建错误。README.zh-CN.md 必须提供从零开始的中文操作命令。不要只输出架构说明、伪代码或未连接的 Demo。

---

## 30. 参考资料

以下资料用于确认输入输出格式和技术边界；实现时应以锁定版本的依赖文档和 Fixture 测试为准。

1. Evernote：Export Notes and Notebooks as ENEX or HTML  
   https://help.evernote.com/hc/en-us/articles/209005557-Export-Notes-and-Notebooks-as-ENEX-or-HTML
2. Obsidian：Import from Evernote  
   https://obsidian.md/help/import/evernote
3. Obsidian：Properties  
   https://obsidian.md/help/properties
4. Obsidian：Attachments  
   https://obsidian.md/help/attachments
5. Playwright：Authentication  
   https://playwright.dev/docs/auth
6. Playwright：Network  
   https://playwright.dev/docs/network
7. Mozilla Readability  
   https://github.com/mozilla/readability
8. Obsidian Importer  
   https://github.com/obsidianmd/obsidian-importer

---

## 31. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-06-22 | 采用 InkMigrate 名称；将今日头条专项需求重构为多来源、多目标架构；整合 Obsidian 输出、今日头条取消收藏安全流程，并预留 Evernote ENEX/HTML 迁移规格。 |

