# InkMigrate 产品需求与技术规格

**文档编号：** IM-PRD-001  
**版本：** 1.4（规格修订版）  
**状态：** 实施基线（v1.0 / v1.1 分阶段发布）  
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

本规格同时描述多个产品发布版本。文档中的“必须交付”均以明确的产品版本为边界，不再使用含义不清的“当前版本”。

### 0.1 产品 v1.0 必须交付

1. 通用迁移核心、CLI、SQLite 状态库和来源/目标适配器框架。
2. `toutiao` 来源适配器：将用户自己的今日头条收藏批量迁移到 Obsidian。
3. `obsidian` 目标适配器：生成 Markdown、YAML Properties 和本地附件。
4. 完整的扫描、迁移、断点续传、幂等、冲突保护、目标验证、完整性对账和报告。
5. 页面读取失败时的最小诊断信息、Fixture 测试、集成测试和发布前人工端到端验收。
6. 为源端清理和 Evernote 预留稳定契约，但 v1.0 不得声明或暴露尚未实现的写能力。

**v1.0 发布不包含今日头条取消收藏，也不以生成索引作为发布门槛。** v1.0 的默认运行模式为只读来源、写入本地目标。

### 0.2 产品 v1.1 必须交付

1. 今日头条源端清理：不可变计划、预演、逐条取消收藏、前后状态复核、恢复和二次扫描。
2. 按月份、内容类型等维度生成分片索引。
3. 页面选择器诊断、脱敏 HTML 和失败截图。
4. 迁移前磁盘空间预估和 Vault 备份提示增强。
5. 清理审计报告和 v1.1 专项安全测试。

v1.1 必须在 v1.0 迁移闭环通过验收后实施。清理功能即使已经编译进程序，也必须默认关闭。

### 0.3 产品 v2.0 计划

1. 正式交付 `evernote` 来源适配器。
2. 支持 ENEX 和 Evernote HTML 导出包。
3. 保留笔记、资源、标签、笔记本、Stack 和可解析的内部链接。
4. 支持万级笔记的流式处理和严格完整性对账。

后续可增加 Notion、OneNote、网页书签、RSS、Markdown 目录等来源，以及通用文件系统等目标，但不得破坏本文件定义的核心适配器契约。

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
- 每个条目都有明确终态：`verified`、`degraded`、失败、冲突或跳过；不得静默丢失。
- 每个成功或降级条目均有可读取且已验证的目标笔记。
- YAML、Markdown、附件链接和附件实体通过验证。
- 重复执行不会生成重复笔记或重复附件。
- 失败、降级、冲突和未知状态均在报告中可定位。
- 完整性方程成立，且完成状态不存在悬挂条目。

当 v1.1 用户另行执行源端清理时，清理成功还必须满足：只作用于指定 Migration Job 中、计划内、质量完整并已验证的条目；每个动作均完成操作前检查、操作后复核和二次扫描。迁移成功本身不依赖是否执行源端清理。

### 2.3 非目标

产品 v1.0 不实现：

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
| Verified | 质量完整的条目已写入目标，且目标笔记、属性和所需附件均通过验证。 |
| Degraded / 降级 | 目标文件已成功写入并通过目标验证，但来源内容不完整、只能保存可见部分或存在明确资源缺失。降级条目不得进入源端清理计划。 |
| Quality Upgrade / 质量升级 | 同一稳定来源条目在后续重新提取时由适配器返回 `quality: full`，并在目标安全更新及再次验证后，从已提交的 `degraded` 结果升级为 `verified`。仅发现更完整来源内容不等于升级完成。 |
| Fingerprint | 来源适配器在同一来源实例内生成的稳定身份指纹；格式为 `sha256:<64 位小写十六进制>`。 |
| Stable Key | 核心计算的全局稳定键：`SHA-256(sourceInstanceId + "\0" + fingerprint)`，以 64 位小写十六进制保存。 |
| Item Key | 用于附件和诊断目录的可移植键，默认 `im-` 加 Stable Key 前 16 位；发生前缀碰撞时自动延长并持久化。 |
| Stable Short ID | 用于笔记文件名后缀的 Stable Key 前 10 位；碰撞时自动延长到 16 位或完整值，并持久化，禁止使用临时递增序号。 |
| `inkmigrate_id` | `im:<sourceInstanceId>:<stableKey>`，在目标 Vault 中唯一且跨重复运行稳定。 |
| Artifact | 目标端生成的笔记、索引、报告或清单等可追踪产物；二进制资源实体由 `assets` 表单独管理。 |
| Artifact Kind | `target_artifacts.artifact_kind` 使用的受控类型标识。核心保留值和适配器扩展规则见 §16.6。 |

`Fingerprint`、`Stable Key`、`Item Key` 和 `Stable Short ID` 是不同层级的身份表示，不得互换或由各适配器自行采用不同算法。算法升级必须通过 Schema/配置版本迁移，已持久化的键不得在普通重跑时改变。

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

### 6.1 P0：产品 v1.0 发布门槛

- Monorepo、配置系统、SQLite、日志、任务锁和迁移核心。
- 来源/目标适配器注册、能力发现和 API 兼容性检查。
- 今日头条手动登录和认证状态复用。
- 今日头条收藏扫描、正文提取、质量标记和图片本地化。
- Obsidian Markdown、Properties 和附件写入。
- 断点续传、重试、幂等、冲突保护和目标验证。
- 扫描、迁移、失败、降级、冲突和完整性报告。
- 单元、Fixture、集成、跨平台 CI 和发布前人工端到端测试。

### 6.2 P1：产品 v1.1 发布门槛

- 今日头条取消收藏清理计划与逐条执行。
- 清理后的二次扫描和审计报告。
- 页面选择器诊断与脱敏 HTML/截图。
- 按月份和内容类型生成分片索引。
- 迁移前磁盘空间预估和 Vault 备份提示增强。

`P1` 不是 v1.0 的“尽量完成项”。只有全部 P1 验收项通过后，产品才可标记为 v1.1。

### 6.3 P2：产品 v2.0 发布门槛

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

每个来源适配器必须公开能力对象。能力只能反映当前安装版本中已经实现并通过契约测试的功能，不能用路线图功能预先置为 `true`。

```ts
export interface SourceCapabilities {
  authMode: 'none' | 'browser-profile' | 'file';
  discoveryMode: 'remote-list' | 'file-stream' | 'directory';
  supportsIncrementalScan: boolean;
  supportsAssets: boolean;
  supportsInternalLinks: boolean;
  supportsSourceCleanup: boolean;
  cleanupActions: readonly string[];
  supportedInputFormats: readonly string[];
}
```

### 8.2 来源适配器接口

```ts
export interface SourceAdapter {
  readonly kind: string;

  // 适配器实现/包版本，例如 1.4.2。
  readonly version: string;

  // 与 @inkmigrate/core 的契约版本，例如 1.0.0。
  readonly adapterApiVersion: string;

  readonly capabilities: SourceCapabilities;
  readonly cleanup?: SourceCleanupAdapter;

  validateConfig(ctx: AdapterContext): Promise<ValidationResult>;
  prepare(ctx: AdapterContext): Promise<void>;
  scan(ctx: ScanContext): AsyncGenerator<SourceItemRef>;
  extract(ref: SourceItemRef, ctx: ExtractContext): Promise<SourceItem>;
  verifySourceRef?(
    ref: SourceItemRef,
    ctx: VerifyContext
  ): Promise<SourceRefState>;
  close(): Promise<void>;
}
```

若 `capabilities.supportsSourceCleanup` 为 `false`，`cleanup` 必须为 `undefined` 且 `cleanupActions` 必须为空。若能力为 `true`，`cleanup` 必须存在并通过源端写操作专项契约测试。

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
  readonly adapterApiVersion: string;

  validateConfig(ctx: AdapterContext): Promise<ValidationResult>;
  plan(item: SourceItem, ctx: TargetContext): Promise<TargetPlan>;
  write(
    plan: TargetPlan,
    ctx: TargetContext
  ): Promise<TargetWriteResult>;
  verify(
    result: TargetWriteResult,
    ctx: VerifyContext
  ): Promise<TargetVerification>;

  // 通用目标适配器可不支持索引。
  renderIndex?(ctx: TargetContext): Promise<TargetWriteResult[]>;
}
```

`renderIndex` 在通用接口中保持可选；`obsidian` 适配器的 v1.0 不以索引为发布门槛，v1.1 必须实现并通过索引验收。

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

export type SourceItemQuality = 'full' | 'degraded';

export type SourceDegradationCode =
  | 'content-unavailable'
  | 'body-missing'
  | 'partial-visibility'
  | 'metadata-only'
  | 'unsupported-structure'
  | 'asset-incomplete'
  | 'unresolved-embedded-content'
  | 'unknown';

export interface SourceDegradation {
  code: SourceDegradationCode;
  stage: 'scan' | 'extract' | 'normalize' | 'assets';
  message: string;
}

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

  // 必填的质量契约，不得仅从 warnings 推断。
  quality: SourceItemQuality;
  degradations: SourceDegradation[];

  extractionMethod: string;
  extractionWarnings: string[];
  sourceMetadata: Record<string, unknown>;
}
```

质量规则：

- `quality: 'full'` 时 `degradations` 必须为空。
- `quality: 'degraded'` 时至少有一个结构化 `degradations` 项。
- `extractionWarnings` 仅用于非致命提示，不能替代质量字段。
- 来源适配器给出当前提取尝试的初始质量；在同一次提取、规范化和附件处理中，核心只能因明确问题将 `full` 降为 `degraded`，不得在缺少来源适配器新证据时自行反向升级。
- 同一稳定条目在后续 Job 中重新提取并由适配器返回 `quality: full` 时，可以进入 §17.5 定义的跨运行质量升级流程；只有目标安全更新并再次验证后才算升级完成。
- `collections` 保存来源中的收藏夹、分组或笔记本等逻辑归属；目标如何映射由目标适配器决定。

### 8.6 适配器兼容性

- `version` 表示适配器实现版本；`adapterApiVersion` 表示核心契约版本，二者不得混用。
- 所有版本使用 SemVer。
- 核心公开 `SUPPORTED_ADAPTER_API_RANGE`，例如 `>=1.0.0 <2.0.0`。
- 启动时先校验 API 范围，再执行配置验证；不兼容时以退出码 `16` 拒绝运行。
- 适配器 API 主版本不匹配时绝不尝试运行；次版本只在核心声明的兼容范围内允许。
- 来源特有数据放在 `sourceMetadata`，但影响身份、质量、时间、附件或迁移正确性的字段必须提升为标准字段。

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

以下示例覆盖当前 Schema 的顶层结构和所有安全相关选项。适配器可增加非安全性扩展项，但新增字段必须进入对应 Zod Schema 和配置参考文档。

```yaml
version: 1

workspace:
  stateDir: ".inkmigrate"
  reportsDir: "reports"
  diagnosticsDir: ".inkmigrate/diagnostics"
  logLevel: "info"
  minFreeDiskBytes: 1073741824

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
      viewport:
        width: 1440
        height: 1000
      scan:
        noGrowthCycles: 5
        waitAfterScrollMs: 1500
      crawl:
        concurrency: 1
        intervalMs: 1500
        navigationTimeoutMs: 45000
        extractionTimeoutMs: 30000
        maxRetries: 3
        retryBackoffMs: [3000, 10000, 30000]
      content:
        createFallbackNotes: true
        followExternalLinks: false
        allowedExternalDomains: []
      assets:
        downloadImages: true
        maxImageBytes: 20971520
        deduplicateByHash: true
        preserveGif: true
        svgPolicy: "remote-link" # preserve | sanitize | remote-link

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
      overwritePolicy: "preserve"
      unicodeNormalization: "NFC"
      maxTitleLength: 100
      collectionMapping:
        propertyName: "source_collections"
        toTags: false
        toFolders: false
      # v1.0 默认关闭；v1.1 可启用。
      createIndexes: false
      indexGroupBy:
        - "month"
        - "content-type"

# v1.1 功能。即使开启，仍需独立计划、--execute 和人工确认。
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
  # batchSize 仅表示每处理多少条执行登录复核、事务提交和限速检查；
  # v1.1 不表示并发点击或页面批量勾选。
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

`indexGroupBy` 是有序枚举数组，允许值为 `month`、`content-type`、`collection` 和 `notebook`。不支持使用单一字符串代替数组。

### 10.3 配置验证

使用 Zod 或同等级 Schema 验证。启动前必须一次性列出全部错误，包括：

- 未知适配器或适配器 API 不兼容。
- 重复来源或目标 ID。
- 路径不存在、不可写或解析后逃逸出允许根目录。
- 输出路径逃逸出 Vault。
- 不支持的能力配置。
- 清理来源不支持指定动作，或 v1.0 构建试图启用 v1.1 清理能力。
- `maxImageBytes`、并发、限速、重试、批次和磁盘阈值超出范围。
- `svgPolicy`、`indexGroupBy`、覆盖策略或集合映射枚举无效。
- `followExternalLinks: true` 但域名策略为空且未经过显式确认。
- `batchSize > maxItemsPerRun`。
- 相互冲突的配置。

未知字段默认报错，除非对应适配器 Schema 明确声明允许扩展。示例配置必须作为自动化测试 Fixture 并通过 Schema。

### 10.4 配置迁移

- 配置必须含顶层 `version`。
- 配置升级通过显式命令执行：

```bash
inkmigrate config upgrade
```

- 不允许运行时静默重写用户配置。


## 11. 通用迁移管线

### 11.1 阶段划分

Migration Job 同时记录粗粒度生命周期 `status` 和精确阶段 `current_stage`：

```text
status:
created | running | paused | interrupted | completed | failed
```

生命周期语义：

| `status` | 含义 |
|---|---|
| `created` | Job 已创建，但尚未开始执行。 |
| `running` | Job 正在执行或正在提交一个受控阶段。 |
| `paused` | 核心已安全提交当前事务，并因可恢复的外部前置条件主动停下；恢复前不继续访问来源或写目标。 |
| `interrupted` | 进程被 `Ctrl+C`、崩溃、强制终止或非受控 I/O 中断打断；恢复前必须重新核对悬挂条目和磁盘状态。 |
| `completed` | 完整性方程成立、无悬挂状态且报告已生成。 |
| `failed` | 发生不可继续的系统性错误，或完成前对账失败。 |

迁移任务进入 `paused` 的允许触发条件仅包括：

- 认证失效但可由用户重新登录恢复：`auth_required`。
- 出现验证码、滑块或账号安全验证，需要用户在可见浏览器中处理：`challenge_required`。
- 来源返回限流或冷却要求，预计等待时间超出当前重试窗口：`rate_limited`。
- 页面语义或来源状态不明确，需要人工确认后继续：`manual_intervention_required`。
- 用户在交互式安全提示中选择“安全暂停”：`operator_paused`。

`paused` 不是完成终态。进入该状态前必须结束或回滚当前数据库事务，并记录 `pause_reason_code` 与暂停时间。前置条件解除后，`resume` 从保留的 `current_stage` 继续。`Ctrl+C` 默认产生 `interrupted`，不产生 `paused`。

`current_stage` 取值：

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

- `status` 用于调度、暂停和恢复。
- `current_stage` 用于 CLI、报告和故障定位。
- v1.0 未启用索引时可以跳过 `generating_indexes`，但仍需记录 `stage_skipped` 事件。
- `resume` 以数据库中的 `status`、`current_stage` 和逐条状态为依据，不允许仅从日志反推。
- 从 `paused` 恢复时先复核暂停原因是否解除；从 `interrupted` 恢复时先重检 `extracting`、`writing` 等悬挂状态。

每个条目的正常处理路径：

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

可恢复状态，不计入 Job 的完成对账终态：

```text
retryable_failed
interrupted
```

本 Job 完整性方程允许的条目终态：

```text
verified
degraded
permanent_failed
unsupported
blocked
conflict
skipped
```

状态边界：

- `degraded`：目标已经通过验证，但标准化条目的 `quality` 不是 `full`；它不是“写入未验证”的同义词。
- `unsupported`：来源条目或所需能力已被识别，但当前适配器版本没有实现对应内容类型、格式或能力。
- `blocked`：适配器具备处理能力，但该条目因条目级权限、付费或加密限制、安全策略、来源状态或不可自动满足的外部前置条件而无法继续；同一 Job 内自动重试不会解除。整个来源实例的认证失效或安全验证应使 Job 进入 `paused`，不得批量把条目标记为 `blocked`。
- `permanent_failed`：能力和访问前置条件均满足，但数据损坏、不可恢复的解析/写入错误或重试耗尽使该条目无法完成。
- `retryable_failed` 与 `interrupted` 是可恢复状态，不是真正的完成终态；Job 进入 `completed` 前其数量必须为 0。
- `conflict` 与 `skipped` 是本 Job 的明确结论，必须带结构化原因并进入报告。

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
- `SourceItem.quality` 和 `SourceItem.degradations` 是强制契约；核心不得从警告字符串猜测质量。
- 核心层执行通用安全清洗、日期规范化、标签/集合规范化，并为当前尝试计算候选 `source_content_hash`。
- 当前尝试的候选质量、降级原因和来源哈希记录在 `migration_attempts`；只有目标写入和验证成功后，才提交到 `source_items` 作为最新已验证结果。
- 不可识别字段保留在 `sourceMetadata`。
- 所有降级必须包含结构化降级码、阶段和可读说明。
- 在一次提取尝试内，附件或规范化步骤可将 `quality: full` 降为 `degraded`，但不能在缺少新来源证据时自动升级。
- 后续 Job 由来源适配器重新提取得到 `quality: full` 时，按 §17.5 执行受控质量升级；不得仅修改数据库状态而跳过目标重写和验证。

以下映射表仅适用于来源适配器已经成功返回 `SourceItem`、并进入目标写入/验证流程的情况。若 `extract()` 在产出 `SourceItem` 前抛出领域错误，则按 §20.2 的显式错误处置契约处理，不进入本表：

- `retryable: true` 的条目级错误进入 `retryable_failed`。
- `retryable: false` 的条目级错误必须给出 `itemDisposition`，并分别进入 `permanent_failed`、`unsupported` 或 `blocked`。
- 条目级不可重试错误缺少 `itemDisposition` 属于适配器契约错误，核心不得猜测，应停止提交该条目并报告 `ADAPTER_ERROR_DISPOSITION_MISSING`。
- 来源级认证、验证码、限流或人工导航前置条件按 §11.1 处理为 Job `paused`，不得转换为大量条目级 `blocked`。

写入和验证完成后的状态映射：

| 标准条目质量 | 目标验证 | 最终条目状态 |
|---|---|---|
| `full` | 通过 | `verified` |
| `degraded` | 通过 | `degraded` |
| 任意 | 未通过且可重试 | `retryable_failed` |
| 任意 | 永久不可恢复 | `permanent_failed` |

`degraded` 条目必须进入 `degraded-items.csv`，不得进入任何源端清理计划。

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

`migration_jobs.failed_count` 是完成终态的聚合计数，定义为：

```text
failed_count
= permanent_failed_count
+ unsupported_count
+ blocked_count
```

其中三个明细计数从该 Job 对应条目的最终状态派生，并写入 `summary.json`、`summary.md` 和失败明细报告；它们不是 `migration_jobs` 的独立持久化列。`failed_count` 不包括 `retryable_failed`、`interrupted`、`conflict` 或 `skipped`。

任务进入 `completed` 前必须满足与 §16.3 实际计数列一致的完整性方程：

```text
scan_count
= verified_count
+ degraded_count
+ failed_count
+ conflict_count
+ skipped_count
```

`candidate_count` 是迁移计划规模指标，不参与最终输入对账方程。Job 进入 `completed` 前，核心必须从条目终态重新派生明细和聚合计数，并与 `migration_jobs` 缓存计数核对；不一致时不得完成。

完成状态下 `discovered`、`queued`、`extracting`、`writing`、`retryable_failed`、`interrupted` 和任何未解决升级候选的数量必须为 0。若方程不成立或存在悬挂状态，Job 必须标记 `failed` 或 `interrupted`，不得输出“迁移完成”。

---

## 12. 今日头条来源适配器

### 12.1 适配器标识

```text
adapter: toutiao
package: @inkmigrate/source-toutiao
```

v1.0 发布能力：

```yaml
authMode: browser-profile
discoveryMode: remote-list
supportsIncrementalScan: true
supportsAssets: true
supportsInternalLinks: false
supportsSourceCleanup: false
cleanupActions: []
```

v1.1 在取消收藏实现和专项契约测试全部通过后，才允许改为：

```yaml
supportsSourceCleanup: true
cleanupActions:
  - unfavorite
```

程序不得根据配置文件把未实现的能力从 `false` 动态改为 `true`。

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
5. 通过多个独立信号检测登录状态。
6. 保存浏览器 Profile，不额外导出明文 Cookie。
7. 关闭浏览器后可在后续任务中复用。

登录状态至少结合以下候选信号中的两类，且不能只依赖 Cookie 名称：

- 当前 URL 已离开登录/认证页面。
- 页面存在明确的已登录用户入口、头像、账号菜单或退出入口。
- 收藏页或用户中心可正常打开，且未出现登录遮罩。
- 页面正常网络响应返回已认证用户状态或账号标识；日志中只能记录布尔结果或脱敏摘要。
- 受保护页面访问后没有被重定向到登录页。
- Cookie/Local Storage 的存在只能作为辅助信号，不能作为唯一结论。

信号冲突时返回 `auth_state_unknown` 并进入人工辅助或安全暂停，不得猜测为已登录。

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

收藏分组必须规范化后写入 `SourceItem.collections`；原始显示文本和页面内部标识保留在 `sourceMetadata`。不得在来源适配器中直接把分组转换成 Obsidian 文件夹或标签。

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
| 视频 | v1.0 不迁移：视频详情页为播放器，无可转 Markdown 的正文。扫描仍会识别并计入统计，但在成为迁移候选前被过滤（不计入迁移分母）。后续版本可视需要支持生成元数据占位笔记。 |
| 外部链接 | 默认保存元数据和链接；显式启用后可尝试外部正文。 |
| 付费/锁定 | 只保存当前用户正常可见部分。 |
| 已删除/失效 | 生成占位笔记，保留已知元数据和失败原因。 |
| 未识别 | 保存为 `unknown`，至少保留标题和 URL。 |

视频不下载媒体文件。v1.0 进一步决定不迁移视频条目（见上表），扫描识别后即从候选中过滤。

### 12.8 详情页提取

按顺序尝试：

1. 站点专用提取器。
2. 页面结构化数据：JSON-LD、Open Graph、Meta、初始化状态。
3. Readability 回退。
4. 元数据占位笔记。

Readability 必须对独立克隆 DOM 运行；不能修改 Playwright 当前页面。任何路径返回的正文都必须进入同一安全流水线，不能因为来自 JSON-LD 或站点专用选择器而跳过清洗。

### 12.9 HTML → Markdown 安全流水线

顺序必须固定为：

```text
来源页面或导出 HTML（不可信）
→ 获取独立 DOM/HTML 快照
→ 预清洗：移除脚本、事件处理器、iframe、object、embed 和危险 URI
→ 站点提取器 / 结构化数据 / Readability（三选一或回退）
→ 对提取结果执行允许列表 HTML Sanitization
→ 解析相对 URL、懒加载资源和附件引用
→ Turndown 转换为 Markdown
→ Markdown 后清洗：危险协议、原始 HTML、控制字符和畸形链接
→ Markdown/YAML/附件引用验证
→ 可信的标准化输出
```

各阶段要求：

- JSDOM 创建时禁止脚本执行和远程资源自动加载。
- 预清洗只移除主动内容和明显危险属性，不应在 Readability 前激进删除正文结构。
- HTML Sanitization 使用明确允许列表；删除 `on*` 属性、`javascript:`、不受控 `data:`、表单和可执行嵌入。
- Turndown 的输入必须是已清洗 HTML，不能直接处理原始页面 HTML。
- Markdown 后清洗必须处理残留原始 HTML、危险 URL scheme、不可见控制字符和异常嵌套链接。
- YAML 由独立 YAML 库生成，正文文本不得参与手工 Frontmatter 拼接。
- 任一步无法证明安全或完整时，降级为纯文本或元数据占位，不得保留可执行内容。

正文内容规则：

删除：

- 脚本、样式、导航、广告、推荐、热榜、评论区、分享浮层。
- 跟踪像素、不可见元素和自动播放组件。
- 与正文无关的侧边栏和登录提示。

保留：

- 标题层级、段落、强调、列表、引用、表格、代码块、链接。
- 正文图片、图片说明和分隔线。

规范化：

- 相对 URL 转绝对 URL。
- 识别 `data-src`、`data-original`、`srcset` 等懒加载属性。
- 连续空行最多两个，删除空段落。
- 外链保留为标准 Markdown 链接。
- 不执行下载 HTML 中的脚本。

### 12.10 图片下载

要求：

- 必要时使用当前浏览器会话和正常 Referer。
- 验证 HTTP 状态、`Content-Type`、Magic Bytes 和实际字节数。
- 拒绝把 HTML 错误页保存为图片。
- 拒绝零字节附件。
- 支持 JPEG、PNG、WebP、GIF；SVG 按 `assets.svgPolicy` 处理。
- `maxImageBytes` 必须在开始写文件前和流式下载过程中同时执行上限检查。
- 失败最多重试 3 次并指数退避。
- 下载失败时保留远程链接，设置 `quality: degraded` 和 `asset-incomplete`，并记录警告。
- `svgPolicy: preserve` 仅允许经过 MIME、尺寸和主动内容检查的 SVG；`sanitize` 必须移除脚本、外部引用和事件属性；默认 `remote-link` 不落地 SVG。

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
│       │   └── 未知类型/
│       └── evernote-archive/
│           ├── <Stack>/
│           │   └── <笔记本名>-<notebook-short-id>/
│           ├── <笔记本名>-<notebook-short-id>/  # 无 Stack 时直接位于 evernote-archive/ 下
│           └── _索引/
└── Attachments/
    └── InkMigrate/
        ├── toutiao-main/
        └── evernote-archive/
```

来源实例 ID 必须进入输出路径，避免多个账号或多次导出相互覆盖。Evernote 笔记本目录必须包含确定性的 `notebook-short-id`；仅使用笔记本显示名称不满足冲突安全要求。有 Stack 的笔记本位于对应 Stack 目录下，无 Stack 的笔记本直接位于 `evernote-archive/` 下，不创建共享的“无 Stack 笔记本”目录。v1.0 不要求创建 `_索引`，v1.1 启用索引时才生成。

### 13.4 文件名和稳定键规则

推荐：

```text
<标题>-<stable-short-id>.md
```

其中：

- `stableKey = SHA-256(sourceInstanceId + "\0" + fingerprint)`。
- `itemKey = im-<stableKey 前 16 位>`，用于附件和诊断目录。
- `stable-short-id = <stableKey 前 10 位>`，用于文件名后缀。
- 若数据库中检测到前缀碰撞，按 16 位、24 位直至完整值延长；选定长度后必须持久化。

通用规则：

- Unicode NFC 规范化。
- 清理 Windows、macOS、Linux 不兼容字符。
- 处理 `CON`、`PRN`、`AUX` 等保留名称。
- 删除结尾句点和空格。
- 主体最大 100 字符，可配置。
- 标题不是唯一主键。
- 大小写不敏感文件系统上仍须避免冲突。
- 冲突时使用已持久化稳定键，不使用临时递增序号。
- 任何目标路径都必须在解引用符号链接后再次确认位于 Vault 内。

### 13.5 通用 YAML Properties

```yaml
---
title: "人工智能如何改变软件开发"
inkmigrate_id: "im:toutiao-main:0f7d..."
inkmigrate_version: 1
migration_job_id: "mig-20260622-143000-a81f"
source: "toutiao"
source_instance: "toutiao-main"
source_type: "article"
source_item_id: "7428193012345678901"
source_url: "https://www.toutiao.com/article/7428193012345678901/"
source_collections:
  - "技术收藏"
author: "示例作者"
published_at: 2025-12-20T10:35:00+08:00
favorited_at: 2026-01-04T21:13:00+08:00
imported_at: 2026-06-22T14:30:00+08:00
tags:
  - source/toutiao
  - type/article
  - status/imported
source_content_hash: "sha256:..."
---
```

规则：

- 使用 YAML 库生成，不手工拼接。
- 属性扁平化，不使用嵌套 Properties。
- 每个属性名唯一。
- 日期使用 ISO 8601。
- 不知道的字段省略，不伪造时间。
- `tags` 和 `source_collections` 使用列表。
- `inkmigrate_id` 在目标 Vault 中必须唯一。
- `source_content_hash` 是核心标准化 `SourceItem` 正文和引用清单的哈希，不是磁盘文件哈希。
- 来源特有属性使用稳定的英文蛇形命名。

集合映射默认策略：

- `SourceItem.collections` 原样去重后写入 `source_collections`。
- 默认不转为标签，不参与目录路径，避免名称冲突和路径注入。
- 只有 `collectionMapping.toTags` 或 `toFolders` 显式开启时才执行映射。
- 映射到标签或目录时仍必须保留 `source_collections` 原值，并执行独立的标签/路径清理。

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

`item-key` 必须使用 §4 和 §13.4 定义并持久化的 `Item Key`，不能直接使用未经清理的来源 ID、标题或 URL。

支持：

```yaml
linkStyle: wikilink
```

或：

```yaml
linkStyle: markdown
```

附件是普通 Vault 文件。写入后必须验证存在、非零字节、哈希和 MIME。

### 13.8 索引（v1.1）

索引不是 v1.0 发布门槛。v1.1 的 Obsidian 适配器必须实现 `renderIndex`，并遵守：

- 不得把数千条内容放入一个超大索引文件。
- `indexGroupBy` 是有序数组，可组合 `month`、`content-type`、`collection` 和 `notebook`。
- 每个分片索引都必须可重复生成且不会覆盖用户笔记。
- 总入口只链接分片索引，不直接列出所有条目。

示例：

```text
Imports/InkMigrate/toutiao-main/_索引/2026-01/文章.md
Imports/InkMigrate/toutiao-main/今日头条收藏索引.md
```

索引 Artifact 必须与普通笔记分开标识；重新生成索引不得改变来源条目的迁移状态。

### 13.9 用户修改保护和哈希语义

系统使用三个不同哈希：

- `source_content_hash`：标准化来源正文、链接和资源清单的哈希，存于 `source_items`，可写入 Frontmatter。
- `target_content_hash`：目标适配器渲染后的逻辑内容哈希，存于 `target_artifacts`；用于判断相同输入是否会生成相同目标内容。
- `written_file_hash`：最终磁盘文件精确字节哈希，存于 `target_artifacts`；用于识别用户编辑或外部修改。

不得用同一个 `content_hash` 字段承载上述多种含义。

再次运行：

1. 读取当前文件。
2. 计算 `written_file_hash`。
3. 与数据库比较。
4. 不一致则判定目标已被用户或外部程序修改。
5. 按覆盖策略处理；默认不得静默覆盖。

配置：

```yaml
overwritePolicy: preserve
```

策略语义：

| 策略 | 目标未被用户修改 | 目标已被用户修改 |
|---|---|---|
| `preserve` | 当来源内容变化或发生质量升级时，允许在原路径原子更新并重新验证。 | 保留用户文件，标记 `conflict`，不写正文。 |
| `replace` | 在原路径原子更新并重新验证。 | 按显式选择的 `replace` 策略执行覆盖，并在 `migration_attempts` 记录 `forced_overwrite` 审计；未显式选择时禁止覆盖。 |
| `write-new` | 目标未修改时与 `preserve` 相同，在 canonical 原路径原子更新；该策略不会无条件创建新文件。 | 保留原文件，写入 `.imported-new.md` 或稳定的 `note_variant` Artifact 路径，并分别记录。 |
| `metadata-only` | 只补充或更新允许的 Properties，不修改正文。 | 不修改正文；无法仅靠该策略完成正文或附件相关的 `degraded → verified` 升级。 |

表中“目标未被用户修改”是所有策略共享的安全更新路径；`write-new` 只在检测到用户或外部修改时与 `preserve` 分化。

当 `replace` 覆盖一个已被用户或外部程序修改的文件时，全部审计证据必须写入同一条 `migration_attempts` 记录，但独立列与 JSON 上下文不得混为一谈：

- `migration_attempts` 独立列：`action_code = 'forced_overwrite'`、`target_artifact_id`、`overwrite_policy = 'replace'`、`expected_written_file_hash`、`observed_prewrite_file_hash`、`result_written_file_hash`、`success`。
- `audit_metadata_json`：只保存触发命令、冲突原因码、目标相对路径和其他非敏感结构化上下文；不得重复承载已有独立列，也不得保存 Cookie、Token、验证码或正文内容。

核心必须在覆盖前创建尝试记录并保存期望哈希与实际观察哈希；目标文件原子写入和验证成功后再提交结果哈希及 `success = 1`。写入或验证失败时保留 `success = 0` 的尝试记录，不得丢失覆盖意图和覆盖前证据。各更新场景的 `action_code` 分配见 §17.5。

`overwritePolicy` 同时约束普通来源更新和 §17.5 的质量升级。任何策略下都必须先比较 `written_file_hash`；任何替换都必须走临时文件、校验和原子重命名。

### 13.10 原子写入

1. 在同目录创建临时文件。
2. 写入并 Flush。
3. 解析 YAML 和 Markdown 基础结构。
4. 验证非空。
5. 原子 Rename。
6. 更新 SQLite。

禁止先覆盖正式文件再验证。


## 14. 今日头条源端清理：取消收藏（v1.1）

### 14.1 功能定义

本章是产品 v1.1 的发布契约。v1.0 构建不得暴露可执行清理命令，也不得在能力对象中声明支持清理。

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

1. 通过必填参数 `--migration-job` 指定已完成的 Migration Job；不允许隐式选择“最新任务”。
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

inkmigrate cleanup plan \
  --source toutiao-main \
  --action unfavorite \
  --migration-job <job-id> \
  --max-items 100
inkmigrate cleanup unfavorite --plan <plan-id> --dry-run
inkmigrate cleanup unfavorite --plan <plan-id> --execute
inkmigrate cleanup resume --job <cleanup-job-id>
inkmigrate cleanup verify --job <cleanup-job-id>
inkmigrate cleanup report --job <cleanup-job-id>
```

### 14.4 候选资格

条目必须同时满足：

- 条目属于命令中明确指定的 Migration Job。
- 迁移状态为 `verified`，且 `SourceItem.quality` 为 `full`。
- Markdown 存在且非零字节。
- YAML 可解析。
- `source_item_id` 或 `canonical_url` 可用。
- 数据库与目标文件一致。
- 无未解决冲突。
- 不处于提取、写入或中断状态。
- 尚未确认为已取消收藏。

“属于指定 Migration Job”不得通过 `source_items` 的当前状态或“最近一次任务”推断。候选资格必须存在一条与指定 Job 直接关联的、来源绑定的目标 Artifact：

```text
target_artifacts.migration_job_id = <命令指定 job-id>
target_artifacts.source_item_id = source_items.id
target_artifacts.artifact_kind = 'note'
target_artifacts.status = 'verified'
```

该 Artifact 还必须通过当前磁盘复核。这里的 `status = 'verified'` 使用 §16.6 的目标 Artifact 状态语义，只证明目标产物已通过验证；清理资格仍需独立满足 `SourceItem.quality = 'full'`。索引、报告、非 `verified` Artifact 或 `source_item_id IS NULL` 的 Artifact 不能证明条目属于该 Migration Job。

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
3. 产品 v1.2 或后续版本可选的受控批量编辑模式（v1.1 不实现）。

禁止：

- 未经验证的私有写接口。
- 坐标点击。
- 只根据按钮中文文案定位。
- 只根据压缩 CSS class 定位。
- “全选全部收藏”。
- 对未知状态的切换按钮重复点击。

v1.1 必须逐条执行取消收藏。`batchSize` 仅表示处理若干条后进行事务提交、登录复核、限速检查和进度落盘，不表示并发点击或页面批量勾选。页面“批量编辑”模式属于产品 v1.2 或后续版本的可选优化，不是 v1.1 验收项。

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
- 若未来启用页面批量模式，页面已选数量与计划不一致。
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
- 每个笔记本计算 `notebookKey = SHA-256(exportFileHash + "\0" + normalizedStack + "\0" + normalizedNotebookName)`。
- 目标目录使用 `<笔记本>-<notebook-short-id>/`，其中短 ID 默认取 `notebookKey` 前 8 位，碰撞时延长并持久化。
- 即使两个 ENEX 文件中的笔记本显示名完全相同，也不得落入同一目录，除非用户通过显式合并映射确认。

示例映射：

```yaml
evernote:
  notebookMappings:
    "Work@@@Projects.enex":
      stack: "Work"
      notebook: "Projects"
      mergeKey: null
```

`mergeKey` 为空表示保持来源隔离；非空时必须经过配置验证并写入迁移计划。

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
source_content_hash: "sha256:..."
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

- Evernote v2.0 初始版本不破解或自动解密加密区域。
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

启动连接必须启用：

- `PRAGMA journal_mode = WAL`。
- `PRAGMA foreign_keys = ON`。
- Schema Migration。
- Busy Timeout。

所有时间字段使用 ISO 8601 UTC 或带偏移时间字符串；同一数据库必须保持一致。以下 SQL 为最低字段契约，实际 Migration 可以增加索引和审计字段，但不能弱化约束。

### 16.1 `source_instances`

```sql
id TEXT PRIMARY KEY,
adapter_kind TEXT NOT NULL,
adapter_version TEXT NOT NULL,
adapter_api_version TEXT NOT NULL,
display_name TEXT,
config_hash TEXT NOT NULL,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

### 16.2 `target_instances`

```sql
id TEXT PRIMARY KEY,
adapter_kind TEXT NOT NULL,
adapter_version TEXT NOT NULL,
adapter_api_version TEXT NOT NULL,
display_name TEXT,
config_hash TEXT NOT NULL,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

### 16.3 `migration_jobs`

```sql
id TEXT PRIMARY KEY,
source_instance_id TEXT NOT NULL
  REFERENCES source_instances(id) ON DELETE RESTRICT,
target_instance_id TEXT NOT NULL
  REFERENCES target_instances(id) ON DELETE RESTRICT,
plan_id TEXT,
status TEXT NOT NULL,
current_stage TEXT NOT NULL DEFAULT 'preflight',
pause_reason_code TEXT,
paused_at TEXT,
scan_count INTEGER NOT NULL DEFAULT 0,
candidate_count INTEGER NOT NULL DEFAULT 0,
verified_count INTEGER NOT NULL DEFAULT 0,
degraded_count INTEGER NOT NULL DEFAULT 0,
failed_count INTEGER NOT NULL DEFAULT 0,
conflict_count INTEGER NOT NULL DEFAULT 0,
skipped_count INTEGER NOT NULL DEFAULT 0,
started_at TEXT,
finished_at TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

字段语义：

- `status` 只保存 Job 生命周期；`current_stage` 保存 §11.1 的精确阶段。CLI 不应从尝试表猜测当前阶段。
- `pause_reason_code` 和 `paused_at` 记录最近一次受控暂停；只有 `status = 'paused'` 时表示当前正在暂停。恢复后可保留最近值用于诊断。
- `scan_count` 是本 Job 扫描得到的唯一来源条目数。
- `candidate_count` 是 Migration Plan 中准备处理的条目数，是计划指标，不替代最终对账。
- `failed_count` 是聚合终态计数，严格等于该 Job 中 `permanent_failed`、`unsupported` 和 `blocked` 三类条目数之和；不包含可重试失败、冲突或跳过。
- 各计数列是便于状态显示的缓存。Job 完成前必须从条目终态重新派生并核对，缓存不是唯一事实来源。

### 16.4 `source_items`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
source_instance_id TEXT NOT NULL
  REFERENCES source_instances(id) ON DELETE CASCADE,
external_id TEXT,
fingerprint TEXT NOT NULL,
stable_key TEXT NOT NULL,
item_key TEXT NOT NULL,
stable_short_id TEXT NOT NULL,
canonical_url TEXT,
original_url TEXT,
title TEXT,
content_kind TEXT NOT NULL,
source_position INTEGER,
discovered_at TEXT NOT NULL,
status TEXT NOT NULL,
quality TEXT,
degradations_json TEXT NOT NULL DEFAULT '[]',
retry_count INTEGER NOT NULL DEFAULT 0,
last_error_code TEXT,
last_error_message TEXT,
source_content_hash TEXT,
source_metadata_json TEXT NOT NULL DEFAULT '{}',
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

索引和约束：

```sql
UNIQUE(source_instance_id, fingerprint)
UNIQUE(source_instance_id, stable_key)
UNIQUE(source_instance_id, item_key)
UNIQUE(source_instance_id, stable_short_id)
UNIQUE(source_instance_id, external_id) WHERE external_id IS NOT NULL
```

`quality`、`degradations_json` 和 `source_content_hash` 表示最近一次已成功写入并通过目标验证的提交结果；仅扫描阶段、首次提取尚未完成目标验证时可以为空。当前迁移尝试的候选值记录在 `migration_attempts`，避免质量升级失败时覆盖上一个可用的降级结果。

### 16.5 `assets`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
source_item_id INTEGER NOT NULL
  REFERENCES source_items(id) ON DELETE CASCADE,
external_id TEXT,
original_url TEXT,
source_hash TEXT,
local_staging_path TEXT,
target_path TEXT,
mime_type TEXT,
byte_size INTEGER,
sha256 TEXT,
status TEXT NOT NULL,
retry_count INTEGER NOT NULL DEFAULT 0,
last_error_code TEXT,
last_error_message TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

### 16.6 `target_artifacts`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
migration_job_id TEXT NOT NULL
  REFERENCES migration_jobs(id) ON DELETE CASCADE,
source_item_id INTEGER
  REFERENCES source_items(id) ON DELETE SET NULL,
artifact_kind TEXT NOT NULL,
target_instance_id TEXT NOT NULL
  REFERENCES target_instances(id) ON DELETE RESTRICT,
relative_path TEXT NOT NULL,
target_content_hash TEXT,
written_file_hash TEXT,
status TEXT NOT NULL
  CHECK(status IN ('planned', 'written', 'verified', 'conflict', 'superseded', 'invalid')),
verified_at TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
UNIQUE(target_instance_id, relative_path)
```

`artifact_kind` 是受控标识，不得由各模块自由拼写同义值。核心保留值至少包括：

| 值 | 语义 |
|---|---|
| `note` | 某个 `source_item_id` 的 canonical 内容笔记。只有已验证的该类型 Artifact 可以证明清理候选归属。 |
| `note_variant` | `write-new`、冲突处理或人工保留产生的替代笔记；默认不具备源端清理资格。 |
| `index` | 分片索引或总索引，通常是 Job 级 Artifact。 |
| `report` | 被登记到目标 Artifact 清单中的迁移或验证报告。 |
| `manifest` | 目标清单、校验清单或其他机器可读元数据产物。 |

适配器新增类型必须在注册时声明，并使用 `adapter:<adapter-id>:<kind>` 命名空间；核心保留值不得被重定义。数据库保存 TEXT，但配置 Schema、适配器注册表和契约测试必须校验该值。

`target_artifacts.status` 也是受控值，描述目标产物自身的物理写入与验证生命周期；不得与 `source_items.status` 或 `migration_jobs.status` 混用：

| 值 | 语义 |
|---|---|
| `planned` | `TargetPlan` 已为产物保留稳定路径，但尚无可作为结果使用的正式文件。 |
| `written` | 正式文件已由同目录临时文件原子 Rename 落盘，且已记录 `written_file_hash`；目标验证尚未通过。 |
| `verified` | 文件格式、哈希和所需引用均通过目标验证。该状态本身不代表来源质量为 `full`；降级条目的目标 Artifact 也可以是 `verified`。 |
| `conflict` | 当前 Job 因检测到用户或外部修改而拒绝不安全更新；现有文件保留，当前 Job 不得把该状态当作目标成功。 |
| `superseded` | 产物为审计或历史保留，但已由更新的 canonical 或经批准的替代产物取代；不得进入清理资格或常规索引计数。 |
| `invalid` | 文件曾写入，但当前验证发现格式、哈希、附件引用或实体完整性不合格；具体重试或终态由条目状态和 `migration_attempts` 决定。 |

允许的主路径为 `planned → written → verified`；验证失败可使 `written → invalid`，经明确替代后可使 `verified → superseded`。`conflict` 是安全拒写结论，不得通过跳过哈希比较直接转为 `verified`。只有 `status = 'verified'` 的来源绑定 Artifact 才能证明目标成功；源端清理还必须额外满足 `artifact_kind = 'note'` 和来源质量完整。

来源绑定 Artifact 使用部分唯一索引：

```sql
CREATE UNIQUE INDEX uq_target_artifacts_source_bound
ON target_artifacts(migration_job_id, source_item_id, artifact_kind)
WHERE source_item_id IS NOT NULL;
```

索引、报告等 Job 级 Artifact 的 `source_item_id` 为 `NULL`。SQLite 对 `UNIQUE` 中的 `NULL` 视为彼此不同，因此不能依赖 `(migration_job_id, source_item_id, artifact_kind)` 约束这类记录；必须额外使用：

```sql
CREATE UNIQUE INDEX uq_target_artifacts_job_path
ON target_artifacts(migration_job_id, artifact_kind, relative_path)
WHERE source_item_id IS NULL;
```

哈希语义：

- `source_items.source_content_hash`：标准化来源内容。
- `target_artifacts.target_content_hash`：目标渲染后的逻辑内容。
- `target_artifacts.written_file_hash`：磁盘精确字节。

### 16.7 `migration_attempts`

该表只记录迁移读取、转换、附件、目标写入、目标验证和冲突处理尝试，不记录源端清理动作。尝试分为 Job 级和条目级，必须显式记录作用域。

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
migration_job_id TEXT NOT NULL
  REFERENCES migration_jobs(id) ON DELETE CASCADE,
attempt_scope TEXT NOT NULL
  CHECK(attempt_scope IN ('job', 'item')),
source_item_id INTEGER
  REFERENCES source_items(id) ON DELETE CASCADE,
target_artifact_id INTEGER
  REFERENCES target_artifacts(id) ON DELETE SET NULL,
stage TEXT NOT NULL,
action_code TEXT NOT NULL DEFAULT 'stage_attempt',
attempt_no INTEGER NOT NULL,
candidate_quality TEXT,
candidate_degradations_json TEXT,
candidate_source_content_hash TEXT,
overwrite_policy TEXT,
expected_written_file_hash TEXT,
observed_prewrite_file_hash TEXT,
result_written_file_hash TEXT,
audit_metadata_json TEXT NOT NULL DEFAULT '{}',
started_at TEXT NOT NULL,
finished_at TEXT,
success INTEGER,
error_code TEXT,
error_message TEXT,
http_status INTEGER,
diagnostic_path TEXT,
created_at TEXT NOT NULL,
CHECK(
  (attempt_scope = 'job' AND source_item_id IS NULL)
  OR
  (attempt_scope = 'item' AND source_item_id IS NOT NULL)
)
```

Job 级尝试允许用于 `preflight`、`scanning`、`planning`、`generating_indexes`、`reporting` 等尚未或无需绑定具体条目的阶段；条目级提取、规范化、附件、写入、验证和冲突处理必须提供 `source_item_id`。`source_item_id IS NULL` 不是“无需防重”的例外。

SQLite 对 `NULL` 采用 distinct 语义，因此不得使用包含可空 `source_item_id` 的单一表级 `UNIQUE`。必须使用两个部分唯一索引：

```sql
CREATE UNIQUE INDEX uq_migration_attempts_item
ON migration_attempts(
  migration_job_id,
  source_item_id,
  stage,
  action_code,
  attempt_no
)
WHERE attempt_scope = 'item' AND source_item_id IS NOT NULL;

CREATE UNIQUE INDEX uq_migration_attempts_job
ON migration_attempts(
  migration_job_id,
  stage,
  action_code,
  attempt_no
)
WHERE attempt_scope = 'job' AND source_item_id IS NULL;
```

字段语义：

- `candidate_quality`、`candidate_degradations_json` 和 `candidate_source_content_hash` 保存本次尝试尚未提交的标准化结果；目标验证成功后，核心才在事务中提交到 `source_items`。
- `action_code` 的核心保留值至少包括 `stage_attempt`、`source_update`、`quality_upgrade`、`forced_overwrite`、`write_new_variant` 和 `metadata_update`；具体触发场景、阶段分配和同一逻辑更新中的多记录关系见 §17.5。适配器扩展遵循 §16.6 相同的命名空间规则。
- `target_artifact_id` 在目标写入、冲突处理和覆盖审计时建立尝试与 Artifact 的直接关系。
- `overwrite_policy` 与三个文件哈希字段用于 §13.9 的覆盖审计。`expected_written_file_hash` 是数据库中原记录，`observed_prewrite_file_hash` 是覆盖前磁盘实际值，`result_written_file_hash` 是新文件验证后的精确字节哈希。
- `audit_metadata_json` 只保存结构化操作上下文、原因码和相对路径；不得保存 Cookie、Authorization、验证码、手机号、完整请求头或正文内容。

### 16.8 `cleanup_plans`

```sql
id TEXT PRIMARY KEY,
source_instance_id TEXT NOT NULL
  REFERENCES source_instances(id) ON DELETE RESTRICT,
migration_job_id TEXT NOT NULL
  REFERENCES migration_jobs(id) ON DELETE RESTRICT,
action TEXT NOT NULL,
plan_hash TEXT NOT NULL,
config_hash TEXT NOT NULL,
candidate_count INTEGER NOT NULL,
excluded_count INTEGER NOT NULL,
status TEXT NOT NULL,
created_at TEXT NOT NULL
```

### 16.9 `cleanup_jobs`

```sql
id TEXT PRIMARY KEY,
plan_id TEXT NOT NULL
  REFERENCES cleanup_plans(id) ON DELETE RESTRICT,
plan_hash TEXT NOT NULL,
action TEXT NOT NULL,
status TEXT NOT NULL,
candidate_count INTEGER NOT NULL,
processed_count INTEGER NOT NULL DEFAULT 0,
success_count INTEGER NOT NULL DEFAULT 0,
skipped_count INTEGER NOT NULL DEFAULT 0,
failed_count INTEGER NOT NULL DEFAULT 0,
unknown_count INTEGER NOT NULL DEFAULT 0,
started_at TEXT,
finished_at TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

### 16.10 `cleanup_items`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
job_id TEXT NOT NULL
  REFERENCES cleanup_jobs(id) ON DELETE CASCADE,
source_item_id INTEGER NOT NULL
  REFERENCES source_items(id) ON DELETE RESTRICT,
precheck_status TEXT NOT NULL,
pre_action_state TEXT,
action_status TEXT NOT NULL,
post_action_state TEXT,
attempt_count INTEGER NOT NULL DEFAULT 0,
action_started_at TEXT,
action_finished_at TEXT,
verified_at TEXT,
last_error_code TEXT,
last_error_message TEXT,
diagnostic_path TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
UNIQUE(job_id, source_item_id)
```

### 16.11 `cleanup_action_attempts`

清理动作必须保留逐次审计记录，不能只保留最后一次错误。

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
cleanup_item_id INTEGER NOT NULL
  REFERENCES cleanup_items(id) ON DELETE CASCADE,
attempt_no INTEGER NOT NULL,
pre_action_state TEXT,
action_result TEXT,
post_action_state TEXT,
started_at TEXT NOT NULL,
finished_at TEXT,
error_code TEXT,
error_message TEXT,
diagnostic_path TEXT,
created_at TEXT NOT NULL,
UNIQUE(cleanup_item_id, attempt_no)
```

### 16.12 数据库事务与删除策略

Foreign Key 的 `ON DELETE` 策略按数据角色分层：

- `assets`、`migration_attempts`、`cleanup_action_attempts` 等从属明细随其直接父记录 `CASCADE`，避免孤儿行。
- `target_artifacts.source_item_id` 使用 `SET NULL`，使来源目录记录被清理后仍能保留目标 Artifact 的审计和路径信息。
- `cleanup_items.source_item_id` 使用 `RESTRICT`，只要存在源端写操作审计，就禁止删除对应来源条目。
- 来源实例、目标实例和清理计划等控制记录使用 `RESTRICT`，避免破坏任务历史。
- 数据库级联只影响数据库记录，绝不自动删除 Vault 中的物理笔记或附件；物理文件删除必须是独立、显式且另行验收的功能，本规格不提供该功能。

事务规则：

- 每个条目关键状态转换在事务中完成。
- 文件写入和数据库更新使用可恢复的两阶段约定。
- 启动时扫描 `writing`、`executing` 等悬挂状态并转为 `interrupted` 或重新验证。
- 数据库迁移失败必须回滚并停止。
- 自动化测试必须断言 `PRAGMA foreign_keys` 已开启，并验证删除/更新约束实际生效。

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

### 17.5 来源内容变化与质量升级

同一来源条目在后续扫描中正文、元数据或资源变化时：

- 通过稳定身份确认是同一条目，不以标题相同作为依据。
- 计算新的候选 `source_content_hash`，并在本次尝试中记录“新条目”“普通来源更新”或“质量升级候选”。
- 若目标未被用户修改，可按 `overwritePolicy` 安全更新。
- 若目标被用户修改，按 §13.9 产生冲突、显式替换或写入新 Artifact。
- 迁移报告必须区分新条目、普通来源更新、质量升级成功、升级延后和升级冲突。

#### 尝试分类与 `action_code`

`migration_attempts.action_code` 按单个阶段尝试记录动作语义，不得把多个动作压进一个自由文本值：

| 场景 | `action_code` |
|---|---|
| 首次迁移或没有更新语义的普通阶段尝试 | `stage_attempt` |
| 同一稳定条目已有已提交结果，来源内容或资源发生变化，但不构成 `degraded → full` | `source_update` |
| 上次已提交质量为 `degraded`，本次重新提取返回 `quality: full` 的升级链路 | `quality_upgrade` |
| `metadata-only` 策略只更新允许的 Properties | `metadata_update` |
| 目标已被修改，`write-new` 创建并验证 `note_variant` | `write_new_variant` |
| 目标已被修改，显式 `replace` 覆盖 canonical 文件 | `forced_overwrite` |

一次逻辑更新可以产生多条、不同阶段的尝试记录。提取、规范化和附件阶段保留 `source_update` 或 `quality_upgrade`；未进入冲突处置时，目标写入和验证阶段也继续使用该更新分类。若写入阶段进入冲突处置，则相应写入/验证动作改用 `write_new_variant` 或 `forced_overwrite`，但不得覆盖或删除前序更新分类记录。`forced_overwrite` 必须使用 §13.9 的独立审计列；`metadata_update` 不得被用于正文或附件升级。

#### `degraded → verified` 受控升级

当某条目上一次已提交结果为 `degraded`，而后续 Job 的来源适配器针对同一 Fingerprint 重新返回 `quality: full` 且 `degradations` 为空时，按以下流程处理：

1. 将本次结果标记为 `quality_upgrade_candidate`；不能仅修改状态为 `verified`。本升级链路默认从提取到目标验证均使用 `action_code = 'quality_upgrade'`；若目标写入阶段进入冲突处置，则仅该处置及其验证记录改用 `forced_overwrite` 或 `write_new_variant`。
2. 重新执行安全规范化、附件处理、目标渲染和目标验证。
3. 写入前比较磁盘当前哈希与原 `written_file_hash`。
4. 目标未被用户修改，且策略为 `preserve`、`replace` 或 `write-new` 时，允许原子更新 canonical 目标内容；此时 `write-new` 与 `preserve` 行为相同，不额外生成变体文件。目标验证通过后，才将最终状态改为 `verified`、提交新的 `quality: full`、清空旧降级原因并更新三类哈希。
5. 目标已被用户修改时：`preserve` 产生 `conflict`；`replace` 按显式选择的 `replace` 策略执行覆盖，并在 `migration_attempts` 以 `action_code = 'forced_overwrite'` 记录 `target_artifact_id`、覆盖策略、期望哈希、覆盖前观察哈希和验证后的结果哈希；`write-new` 保留原文件，以 `action_code = 'write_new_variant'` 创建并验证新的 `note_variant` Artifact。
6. `metadata-only` 仅能以 `action_code = 'metadata_update'` 更新允许的 Properties，不允许完成涉及正文或附件完整性的质量升级；条目保持原 `degraded` 结果，并报告 `quality_upgrade_deferred`。
7. 转换、附件、写入或验证任一步失败时，旧的已验证降级 Artifact 必须保留，不得被半成品破坏；本次尝试按错误模型记录，可重试时进入 `retryable_failed`。
8. 只有在新的目标 Artifact 通过验证、Job 计数完成提交后，条目才能进入后续清理候选判断。

“核心不得自动升级质量”指核心不能在没有适配器新提取证据或没有目标复核的情况下自行把 `degraded` 改为 `full`；本节定义的是基于后续重新提取和完整迁移闭环的显式升级。

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
- HTTP 429 先按退避策略重试；当服务端冷却要求超出当前重试窗口时，Job 进入 `paused` 并记录 `rate_limited`，不得持续高频请求。
- 认证失效、验证码或账号安全验证触发受控 `paused`，分别记录 `auth_required` 或 `challenge_required`；用户解除前置条件后通过 `resume` 重新预检。
- `Ctrl+C`、进程崩溃、浏览器异常退出或主机重启进入 `interrupted`，不得误记为 `paused`。
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
- 所有 HTML 到 Markdown 的处理必须遵循 §12.9 的固定安全流水线。
- JSDOM 禁止脚本执行和远程资源自动加载。
- 站点专用提取器、结构化数据和 Readability 输出都必须再次执行允许列表 Sanitization。
- Turndown 只能接收清洗后的 HTML；转换后还要执行 Markdown 协议和原始 HTML 检查。
- SVG 按 `svgPolicy` 决定保留、清洗或转为远程链接；默认不落地。
- 文件扩展名不能替代 MIME、Magic Bytes 和内容检查。

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
  itemDisposition?:
    | 'permanent_failed'
    | 'unsupported'
    | 'blocked';
  userMessage: string;
  technicalMessage?: string;
  cause?: unknown;
}
```

契约规则：

- `itemDisposition` 只用于条目级、不可重试错误。
- `retryable: true` 时不得同时给出 `itemDisposition`，核心统一进入 `retryable_failed`。
- 条目级 `retryable: false` 时必须给出 `itemDisposition`；缺失属于适配器契约错误，核心不得根据字符串或 `category` 猜测。
- Job 级配置、认证、限流、安全验证或内部系统错误可以不提供 `itemDisposition`，必须按 §11.1 的 Job 生命周期和状态边界处理；整个来源实例的认证失效或安全验证应进入受控 `paused`，不得批量把条目标记为 `blocked`。
- `unsupported` 表示能力缺失；`blocked` 表示能力存在但被权限、策略或外部前置条件阻断；其余不可恢复的技术或数据错误使用 `permanent_failed`。

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

运行中的示例：

```text
任务：mig-20260622-143000-a81f
状态：running
阶段：extracting
来源：toutiao-main
目标：personal-vault

扫描：1328
已验证：1194
已降级：83
等待处理：21
可重试失败：17
失败合计：8
  ├─ 永久失败：5
  ├─ 不支持：2
  └─ 阻断：1
冲突：5
跳过：0
```

`失败合计` 对应 `migration_jobs.failed_count`。三项明细从该 Job 的条目状态实时派生；可重试失败不计入该字段。

暂停时还必须显示：

```text
状态：paused
阶段：extracting
暂停原因：auth_required
暂停时间：2026-06-22T14:30:00+08:00
恢复提示：完成登录后运行 inkmigrate resume --job <job-id>
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

- `scan_count`、`candidate_count` 和实际处理数。
- `verified_count`、`degraded_count`、`failed_count`、`conflict_count` 和 `skipped_count`。
- `failed_count` 的三类明细：`permanent_failed_count`、`unsupported_count`、`blocked_count`。
- 运行结束时从条目状态重新派生的计数与 `migration_jobs` 缓存计数对账结果。
- 按来源类型统计。
- 附件成功和失败数量。
- 重试次数。
- 普通来源更新数量。
- 质量升级候选、成功、延后、冲突和失败数量。
- 未解析链接。
- 人工处理清单。

报告中的“失败”不得把 `retryable_failed`、`conflict` 或 `skipped` 混入 `failed_count`；这些状态必须单独展示。

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

以下清理命令仅在产品 v1.1 及以后可用；v1.0 对这些命令必须返回“能力未启用”或不注册该命令。

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
- Fingerprint、Stable Key、Item Key 和 Stable Short ID，包括前缀碰撞延长。
- 文件名清理。
- Windows 保留名称。
- Unicode NFC。
- 路径穿越和符号链接逃逸。
- YAML 特殊字符和 `source_collections` 映射。
- HTML/ENML 安全流水线与 Markdown 后清洗。
- 懒加载图片解析。
- MIME、Magic Bytes、扩展名和 SVG 策略。
- `source_content_hash`、`target_content_hash` 和 `written_file_hash` 的独立语义。
- `quality` / `degradations` 契约和状态映射。
- 用户修改检测。
- 配置 Schema。
- 日志脱敏。
- 状态机、`current_stage`、`paused` / `interrupted` 区分和错误码。
- `failed_count` 聚合语义、明细派生和完整性方程。
- `degraded → verified` 质量升级策略矩阵及旧 Artifact 保护。
- `InkMigrateError.itemDisposition` 对 `unsupported`、`blocked` 和 `permanent_failed` 的显式映射。
- `artifact_kind` 核心保留值、命名空间扩展和清理资格规则。
- `target_artifacts.status` 受控值、状态转换、目标成功与清理资格边界。
- `migration_attempts` 的 Job/条目作用域、CHECK 约束和两个部分唯一索引。
- `action_code` 对普通更新、质量升级、元数据更新、变体写入和强制覆盖的阶段分配。
- `replace` 强制覆盖审计字段及失败审计保留。
- 计划哈希。
- 排他锁。
- Foreign Key 实际启用。

### 24.2 适配器契约测试

`@inkmigrate/testkit` 提供统一契约：

- 来源扫描的每个 Ref 必须有合法 Fingerprint。
- 来源提取成功必须返回显式 `quality`；降级必须有结构化原因。
- 来源提取失败必须返回领域错误。
- `adapterApiVersion` 必须存在且落在核心支持范围。
- 能力对象与实际接口一致；未实现清理时不得声明支持。
- 目标写入必须原子。
- 目标验证不得只信任数据库。
- 通用 `renderIndex` 可以缺省；Obsidian v1.1 必须实现。
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

v1.1 清理 Fixture：

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

v1.0 CI 必须覆盖：

1. 扫描到 SQLite。
2. 提取到标准模型并验证质量字段。
3. 安全转换为 Markdown。
4. 写临时 Vault。
5. 验证 YAML、集合属性和附件。
6. 再次运行无重复。
7. 用户修改后产生冲突。
8. 中断后恢复，并正确显示 `current_stage`。
9. 认证失效或安全验证触发受控 `paused`，与 `Ctrl+C` 的 `interrupted` 明确区分。
10. Dry-run 无目标写入。
11. `failed_count` 等于 `permanent_failed + unsupported + blocked`，完整性方程与实际列一致。
12. 首次降级、后续重新提取为完整内容且目标未修改时，可安全升级到 `verified`。
13. 质量升级遇到用户修改时按策略冲突或写新文件；升级失败时旧降级 Artifact 保持可用。
14. 索引类 `source_item_id IS NULL` 的 Artifact 由 Job + 类型 + 路径唯一约束。
15. Foreign Key 删除策略分层生效且不删除目标物理文件。
16. Job 级和条目级 `migration_attempts` 分别受部分唯一索引约束，`source_item_id IS NULL` 时仍不能重复写入同一尝试号。
17. `replace` 覆盖用户修改文件时，成功与失败路径都留下包含覆盖前后哈希的 `forced_overwrite` 审计记录，独立列与 `audit_metadata_json` 的字段归属正确。
18. `unsupported`、`blocked` 和 `permanent_failed` 由显式 `itemDisposition` 决定，认证失效不会被批量误记为 `blocked`。
19. `artifact_kind` 使用受控值；`note_variant` 不会被误判为 canonical 笔记或清理候选。
20. 普通更新、质量升级、`metadata-only`、`write-new` 和 `replace` 分别使用规定的 `action_code`，同一逻辑更新的前序分类记录不会被冲突处置记录覆盖。
21. `target_artifacts.status` 只接受受控值，并遵循 `planned → written → verified` 等规定转换；非 `verified` Artifact 不能证明清理候选归属。
22. Evernote 契约 Fixture 可被核心注册但 v1.0 不要求完整迁移。

v1.1 追加：

1. 清理 Dry-run 无点击。
2. 计划必须显式绑定 Migration Job。
3. 候选必须通过该 Job 的已验证、来源绑定 `target_artifacts` 记录判定。
4. 降级条目不能进入清理计划。
5. 清理结果不明时不重复点击。
6. `batchSize` 只触发顺序检查点，不产生并发动作。
7. 索引按配置分片且重复生成幂等。

### 24.6 端到端测试与发布 Gate

真实今日头条账号端到端测试是**发布前人工 Gate**，不得放入普通 CI，也不得把真实 Cookie、Profile 或账号数据作为 CI Secret。

冻结一份发布验收清单，至少包括：

- 20 篇在测试开始前已确认可正常访问的普通文章。
- 3 条短文本。
- 2 个图集。
- 1 条失效内容。
- 1 条预期降级内容。

“普通文章正文提取成功率不低于 95%”的分母是上述冻结清单中 `contentKind = article`、测试开始时页面可正常加载、且不存在删除、付费墙、权限或登录阻断的条目。清单必须在提取前固定并保存 ID/URL；不可访问条目不得事后从分母静默删除，只能按预先规则单独记账。20 篇样本意味着至少 19 篇达到 `quality: full`。

v1.1 清理 E2E 必须使用专用测试收藏，数量小于等于 10，并在人工确认后逐条执行。不得使用用户全部收藏进行首次验收。

Evernote v2.0 验收数据至少：

- 1000 篇人工生成 ENEX 笔记。
- 重复标题和大小写冲突。
- 多种资源。
- 内部链接环。
- 畸形单条笔记。

### 24.7 跨平台测试

CI 至少覆盖 Windows、macOS 和 Linux，运行单元、Fixture、适配器契约和不依赖真实账号的集成测试。

重点验证路径、中文文件名、大小写冲突、符号链接防护、原子重命名差异和 SQLite Foreign Keys。真实账号 E2E 不属于跨平台 CI 必过项，但发布记录必须注明实际执行平台和结果。

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

发布 Gate：

- 产品 v1.0 必须通过 §26.1、§26.2、§26.3 和 §26.6 中适用于迁移的条目。
- 产品 v1.1 必须先满足 v1.0，再通过 §26.4 和全部源端写操作安全条目。
- 产品 v2.0 必须先满足核心契约，再通过 §26.5。

### 26.1 核心架构

1. CLI 使用 `inkmigrate` 名称。
2. 来源和目标通过注册表加载。
3. 核心包不依赖具体适配器。
4. 新增来源无需修改 Obsidian 写入核心。
5. 新增目标无需修改今日头条解析逻辑。
6. `adapterApiVersion` 不兼容时明确拒绝。
7. 配置错误在执行前一次性列出。
8. 数据库 Schema 可迁移和回滚。
9. Job 同时记录 `status` 和 `current_stage`。
10. `paused` 只由受控、可恢复前置条件触发；`Ctrl+C` 和非受控终止进入 `interrupted`。
11. `failed_count` 严格等于 `permanent_failed`、`unsupported`、`blocked` 三类终态之和，完整性方程只使用实际持久化计数列。
12. 所有声明的 Foreign Keys 在运行时实际启用，删除策略分层符合 §16.12。
13. 条目级不可重试错误通过 `itemDisposition` 显式区分 `unsupported`、`blocked` 和 `permanent_failed`；缺失处置不得被核心猜测。
14. `migration_attempts` 明确区分 Job/条目作用域，并使用两个部分唯一索引约束可空 `source_item_id` 场景。
15. `migration_attempts.action_code` 按 §17.5 的动作和阶段规则写入；普通更新、质量升级与后续冲突处置的记录均可追溯且不会互相覆盖。

### 26.2 今日头条迁移（v1.0）

1. 用户无需填写密码、Cookie 或 Token。
2. 手动登录后重启仍可复用认证。
3. 登录判断至少使用两类信号，冲突时不猜测成功。
4. 能完成无限滚动扫描并报告结束原因。
5. 冻结验收清单中的可访问普通文章正文完整提取率不低于 95%，分母定义见 §24.6。
6. 正文失败仍生成显式 `quality: degraded` 的元数据占位笔记。
7. 后续重新提取得到完整内容时，未被用户修改的降级笔记可按策略安全升级为 `verified`；升级失败不得破坏原降级笔记。
8. 单篇失败不终止全局任务。
9. `Ctrl+C` 后数据库不损坏。
10. `resume` 能分别处理 `paused` 和 `interrupted`，并显示准确阶段和暂停原因。
11. 连续执行两次，重复笔记为 0。
12. 连续执行两次，重复附件为 0。
13. 完整性方程成立且没有悬挂状态。

### 26.3 Obsidian 目标（v1.0）

1. 所有成功和降级笔记 YAML 可解析。
2. 所有要求本地化的附件链接存在且非零字节。
3. 输出路径不逃逸 Vault。
4. 中文和跨平台文件名正常。
5. 用户编辑过的笔记默认不覆盖。
6. 不依赖 Obsidian 社区插件即可读取。
7. 每篇笔记包含稳定且唯一的 `inkmigrate_id`。
8. `source_collections` 按默认规则保存，且不会未经配置改变标签或目录。
9. 三类内容/文件哈希语义不混用。
10. `write-new` 在目标未修改时不会无条件创建新文件；`replace` 强制覆盖用户修改文件时，覆盖前后哈希和目标 Artifact 均可审计。
11. `target_artifacts.status` 只使用 §16.6 的受控值，目标成功、冲突、失效和替代状态与来源条目状态明确分离。

### 26.4 v1.1 索引、诊断与今日头条清理

1. Obsidian 索引按配置分片，不生成单一超大文件。
2. `renderIndex` 在 Obsidian v1.1 中实现且重复执行幂等。
3. 索引和报告 Artifact 即使 `source_item_id IS NULL`，也受 Job、类型和路径唯一约束。
4. 诊断 HTML 和截图经过脱敏且不进入 Vault。
5. 默认不产生源端写操作。
6. 修改配置本身不足以触发取消收藏。
7. `cleanup plan` 必须显式指定 `--migration-job`，不得隐式选择最新任务。
8. 候选归属必须通过该 Job 的已验证、来源绑定 `target_artifacts` 记录判定，不能从 `source_items` 当前状态推断。
9. 未验证或 `quality: degraded` 的条目绝不进入计划。
10. 没有计划无法执行，计划被修改后拒绝执行。
11. 确认文本数量必须完全匹配。
12. 每条操作前检查当前状态，每条操作后复核。
13. 结果不明时不盲目重试，重复运行不会重新收藏。
14. v1.1 按顺序逐条操作；`batchSize` 不产生并发或页面批量勾选。
15. 不删除本地文件、收藏夹或计划外内容。
16. 中断后可恢复且不重复已成功动作。
17. 二次扫描仍存在时不得报成功。
18. 每次动作尝试都有独立审计记录。
19. 清理候选只接受 `artifact_kind = 'note'` 的 canonical 已验证笔记；`note_variant`、索引、报告和清单均不得证明候选归属。

### 26.5 Evernote v2.0

1. ENEX 输入笔记总数与结果总数一致。
2. 不因单条畸形笔记静默丢弃其他笔记。
3. 标题重复、同名笔记本和大小写冲突不覆盖。
4. 创建/更新时间、标签、笔记本和 Stack 尽可能保留。
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
4. HTML 到 Markdown 严格遵循固定安全流水线。
5. 不支持验证码破解或 stealth。
6. v1.0 不暴露未实现的清理能力。
7. v1.1 清理操作在代码审查中可被明确定位。

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
- 用户只能迁移其有权访问的数据，并需自行遵守来源平台服务条款、账号规则和适用法律。
- Node.js、pnpm、Playwright 安装。
- 从零初始化。
- 添加今日头条来源和 Obsidian 目标。
- 手动登录。
- 20 条小规模扫描和迁移。
- 正式迁移。
- 中断恢复。
- 验证和报告。
- v1.0 不包含源端清理的说明；v1.1 文档必须说明清理风险和确认流程。
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

### 产品 v1.0 / P0

#### 阶段 1：基础工程

1. Monorepo 和 TypeScript 严格模式。
2. 配置 Schema。
3. SQLite、Foreign Keys 和 Schema Migration。
4. 领域模型、显式质量契约、错误码、状态机和稳定键。
5. 来源/目标适配器注册表与 API 版本检查。

#### 阶段 2：Obsidian 目标

1. 路径和符号链接防护。
2. 文件名与稳定键规则。
3. Properties、集合映射和 Markdown 渲染。
4. 附件写入。
5. 原子写入、三类哈希和验证。
6. 冲突保护。

#### 阶段 3：今日头条只读来源

1. 浏览器 Profile。
2. 多信号手动登录验证。
3. 收藏页定位。
4. DOM 和网络观察扫描。
5. 详情提取和显式质量结果。
6. 固定 HTML → Markdown 安全流水线。
7. 图片下载。
8. Fixture 测试。

#### 阶段 4：v1.0 迁移闭环

1. Job 调度、`current_stage` 和受控 `paused` 语义。
2. 断点续传及 `paused` / `interrupted` 差异化恢复。
3. 重试。
4. 聚合失败计数、明细派生和完整性对账。
5. 跨运行 `degraded → verified` 质量升级。
6. 报告。
7. 跨平台 CI。
8. 发布前人工真实账号 E2E。

完成阶段 4 且通过 v1.0 验收后，才能发布 v1.0。

### 产品 v1.1 / P1

#### 阶段 5：索引与增强诊断

1. Obsidian 分片索引。
2. 选择器诊断。
3. 脱敏 HTML/截图。
4. 磁盘预估和备份提示。

#### 阶段 6：源端清理

1. 候选资格和 Migration Job 强绑定。
2. 计划和哈希。
3. Dry-run。
4. 顺序逐条取消收藏。
5. 前后状态复核。
6. 恢复和二次扫描。
7. 独立动作审计报告。

页面批量编辑不属于 v1.1。只有阶段 5、6 全部通过后才能发布 v1.1。

### 产品 v2.0 / P2

#### 阶段 7：Evernote

1. ENEX 流式扫描。
2. ENML 转换。
3. 资源提取。
4. 笔记本稳定键、Stack 和标签。
5. 内部链接两遍重写。
6. HTML 回退。
7. 万级清单验证和报告。

每个阶段结束必须执行类型检查、测试和构建，不得积累未修复错误到下一阶段。

## 29. AI 编程工具执行指令

> 请按照《InkMigrate 产品需求与技术规格》创建一个可实际运行的 TypeScript Monorepo。项目名、仓库名和 CLI 统一使用 InkMigrate / `inkmigrate`，不得沿用 `tt2obs`。
>
> 第一交付目标只能是产品 v1.0 / P0：只读今日头条来源、Obsidian 写入、恢复、验证和完整性报告。不要在 v1.0 中暴露取消收藏命令或把 `supportsSourceCleanup` 设为 `true`。v1.0 验收通过后，才开始产品 v1.1 / P1 的索引、诊断和源端清理。
>
> Evernote 适配器按 v2.0 / P2 实施，但 v1.0 的核心接口、数据库和目录必须从第一天起支持多来源和多目标，禁止把通用表命名为 `favorites` 或把核心流程写死到今日头条。
>
> 来源适配器、目标适配器和源端清理能力必须解耦。今日头条适配器不能直接写 Obsidian 文件；Obsidian 适配器不能访问 Playwright 页面；核心层只处理标准领域模型。
>
> `SourceItem` 必须返回显式 `quality` 和结构化 `degradations`。不得从 warnings 猜测降级状态。在一次尝试内核心只能降级，不能凭空升级；同一条目在后续 Job 中由适配器重新返回 `full` 时，必须按 §17.5 完成目标安全更新和再次验证后，才能从 `degraded` 升级为 `verified`。升级失败不得破坏原降级 Artifact。
>
> `version` 和 `adapterApiVersion` 必须分别实现。核心启动时按 SemVer 范围检查适配器 API，不兼容时拒绝运行。
>
> 登录无法自动识别、收藏页无法定位或页面结构变化时，进入人工辅助或受控 `paused`，并记录暂停原因；`Ctrl+C`、崩溃和非受控终止进入 `interrupted`。不得要求用户提供密码、Cookie、Token，不得使用验证码破解、stealth、坐标点击或签名破解。
>
> 所有 HTML/ENML 必须经过固定的预清洗、提取、允许列表 Sanitization、Turndown 和 Markdown 后清洗流水线。所有目标文件使用临时文件、校验和原子重命名。任何单条内容失败不能终止整个迁移。每个输入条目必须有明确结果，不得静默丢失。`migration_jobs.failed_count` 必须聚合 `permanent_failed + unsupported + blocked`，完整性方程只能引用实际持久化列，报告再拆分明细。
>
> 条目级不可重试错误必须通过 `itemDisposition` 显式声明 `permanent_failed`、`unsupported` 或 `blocked`；核心不得根据错误消息猜测。Job 级认证、限流和安全验证按 §11.1 进入相应生命周期，不能批量落为条目级 `blocked`。`migration_attempts` 必须区分 Job/条目作用域，并为 `source_item_id IS NULL` 与非空场景分别建立部分唯一索引。`action_code` 必须按 §17.5 区分普通更新、质量升级、元数据更新、变体写入和强制覆盖。`artifact_kind` 与 `target_artifacts.status` 均使用受控值；canonical 内容笔记统一为 `note`，冲突变体统一为 `note_variant`，非 `verified` Artifact 不得证明源端清理资格。
>
> `write-new` 仅在目标已被修改时生成变体；目标未修改时仍更新 canonical 路径。`replace` 强制覆盖用户修改文件时，必须在 `migration_attempts` 写入 `forced_overwrite` 审计，保存目标 Artifact、覆盖策略、期望哈希、覆盖前观察哈希和验证后结果哈希；失败路径也必须保留审计记录。
>
> v1.1 的 `sourceCleanup.enabled` 默认必须为 `false`。`cleanup plan` 必须显式接收 `--migration-job`，不得选择最新任务。条目归属必须由该 Job 的已验证、来源绑定 `target_artifacts` 记录证明；不能从 `source_items` 当前状态推断。取消收藏只能处理质量完整且进入不可变计划的条目。每次点击前检查收藏状态，每次点击后复核。状态不明时不得盲目重试。v1.1 逐条顺序执行，`batchSize` 只表示检查点，不表示并发或批量勾选。
>
> Evernote v2.0 使用用户导出的 ENEX/HTML 文件，不直接登录账号。ENEX 必须流式解析；资源通过哈希关联；同名笔记本目录必须带稳定区分键；内部链接使用两遍处理；输入总数与结果总数必须严格对账。
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
> 完成 v1.1 源端清理后额外运行：
>
> ```bash
> pnpm inkmigrate cleanup --help
> ```
>
> CI 只运行 Fixture、契约、集成和跨平台测试；真实今日头条账号 E2E 是发布前人工 Gate。修复全部类型错误、测试错误和构建错误。README.zh-CN.md 必须提供从零开始的中文操作命令。不要只输出架构说明、伪代码或未连接的 Demo。

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
| 1.4 | 2026-06-22 | 根据第四轮工程复评完成契约一致性收口：统一 `replace` 的执行措辞；明确强制覆盖审计的独立列与 `audit_metadata_json` 字段归属；把 Job 级认证和安全验证显式回引至状态边界；定义 `action_code` 在普通更新、质量升级、元数据更新、`write-new` 和强制覆盖中的阶段使用；为 `target_artifacts.status` 增加受控值、CHECK 约束、转换语义及清理资格边界。 |
| 1.3 | 2026-06-22 | 根据第三轮工程复评收口实现契约：将条目状态拆为可恢复状态与完成终态并定义 `blocked` 边界；为不可重试条目错误增加显式 `itemDisposition`；为 `migration_attempts` 增加 Job/条目作用域、CHECK 约束及两个部分唯一索引；定义 `artifact_kind` 受控值和 `note`/`note_variant` 清理语义；澄清 `write-new` 行为，并把 `replace` 强制覆盖审计落到目标 Artifact 与覆盖前后三类哈希字段。 |
| 1.2 | 2026-06-22 | 根据第二轮工程复评修订：采用聚合 `failed_count` 方案并使完整性方程与数据库列完全一致；定义失败明细派生口径和 CLI/报告展示；补充受控 `paused` 与 `interrupted` 的触发及恢复语义；定义跨 Job 的 `degraded → verified` 质量升级、覆盖策略和旧 Artifact 保护；明确清理候选通过指定 Job 的 `target_artifacts` 判定；概括 Foreign Key 删除策略；修正文档目录记号，并为 `source_item_id IS NULL` 的索引 Artifact 增加唯一性契约。 |
| 1.1 | 2026-06-22 | 根据工程评审修订：将产品 v1.0 收敛为 P0 迁移闭环，源端清理和索引移至 v1.1；增加显式降级质量契约、`adapterApiVersion`、集合映射、安全转换流水线、稳定键术语、完整配置、`current_stage`、独立哈希字段、明确 Migration/Cleanup 尝试表和 Foreign Keys；修复清理计划参数、Evernote 同名笔记本路径、E2E/CI 边界与 95% 分母定义。 |
| 1.0 | 2026-06-22 | 采用 InkMigrate 名称；将今日头条专项需求重构为多来源、多目标架构；整合 Obsidian 输出、今日头条取消收藏安全流程，并预留 Evernote ENEX/HTML 迁移规格。 |
