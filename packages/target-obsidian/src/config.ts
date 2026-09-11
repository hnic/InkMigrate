import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { rejectsTraversal } from '@inkmigrate/core';

/**
 * §13.3/§13.7 Vault 内相对子目录的共用校验：
 * - I16: 拒绝 `..` 路径段（含反斜杠分隔形式，复用 core 的 rejectsTraversal——
 *   Windows 的 path.resolve 把 `\` 当分隔符，仅按 `/` 切分会漏放行），防止配置
 *   错误/恶意配置生成逃逸风格的相对路径。resolveWithin 在写入时会兜底拦截，
 *   但配置校验阶段就拒绝能让 plan 阶段不生成畸形 relativePath，
 *   避免 plan 成功、write 才炸的语义割裂。
 * - 拒绝绝对路径（POSIX `/x` 与 Windows 盘符 `C:\x`）：绝对值会让
 *   `[subdir, ...].join('/')` 产出以 `/` 开头的路径，同样只在 write 阶段才炸。
 */
const vaultRelativeSubdir = (field: string) =>
  z
    .string()
    .refine((s) => !rejectsTraversal(s), {
      message: `${field} 不得包含 ".." 路径段`,
    })
    .refine((s) => !s.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(s), {
      message: `${field} 必须是相对 Vault 根的相对路径，不能是绝对路径`,
    });

/**
 * §13.2/§13.7/§13.9 Obsidian 目标适配器运行时配置。
 *
 * 这个 schema 由本包导出，CLI/registry 在校验 `targets[].config` 时合并使用
 * （§10.3 适配器扩展点）。所有路径都是相对 Vault 根的 POSIX 风格。
 */
export const ObsidianTargetConfigSchema = z
  .object({
    /** §13.2 Vault 根目录绝对路径。 */
    vaultPath: z
      .string()
      .min(1)
      // 相对 vaultPath 会被 resolveWithin 按 process.cwd 解析，换目录运行时
      // 写到意外位置；在校验阶段即拒绝。isAbsolute 覆盖本平台的 `/x`/`C:\x`，
      // 盘符正则补齐跨平台校验（如在 POSIX 上校验 Windows 风格路径）。
      .refine((s) => isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s), {
        message: 'vaultPath 必须是绝对路径',
      }),
    /** §13.3 笔记导入根目录（相对 Vault），默认 `Imports/InkMigrate`。 */
    importSubdir: vaultRelativeSubdir('importSubdir').default('Imports/InkMigrate'),
    /** §13.7 附件根目录（相对 Vault），默认 `Attachments/InkMigrate`。 */
    attachmentsSubdir: vaultRelativeSubdir('attachmentsSubdir').default(
      'Attachments/InkMigrate',
    ),
    /** §13.7 链接风格，默认 wikilink。 */
    linkStyle: z.enum(['wikilink', 'markdown']).default('wikilink'),
    /** §13.9 覆盖策略，默认 preserve（最安全）。 */
    overwritePolicy: z
      .enum(['preserve', 'replace', 'write-new', 'metadata-only'])
      .default('preserve'),
    /**
     * §13.5 集合映射策略，默认原样写入 source_collections，不转标签/目录。
     *
     * **阶段 2 边界**：本字段在 schema 中接受并校验，但 `frontmatter.ts`/
     * `paths.ts` 当前不读取它。`toTags: true` / `toFolders: true` 在阶段 2
     * 是静默 no-op。完整映射逻辑（按 §13.5 把 collection 转成标签或目录段）
     * 在阶段 4 Job 编排层接入时实现，届时会同步加测试。
     */
    collectionMapping: z
      .object({
        toTags: z.boolean().default(false),
        toFolders: z.boolean().default(false),
      })
      .default({ toTags: false, toFolders: false }),
    /** §13.4 文件名主体最大长度，默认 100。 */
    maxFilenameLength: z.number().int().positive().default(100),
    /**
     * §13.4 笔记文件名是否携带 stableShortId 后缀（`标题-<shortId>.md`）。
     * 默认 false（纯标题名，75cfaa6 口径——用户对输出文件名的一贯要求；
     * d8c3f7b 曾按 PRD 设为 true 造成短哈希后缀回归）。true 时同目录同名
     * 标题靠 shortId 区分保证重跑幂等；false 时靠 plan 阶段 -2/-3 序号兜底，
     * 重跑/续跑可能产生副本——适合一次性迁移、追求干净文件名的场景。
     */
    filenameShortId: z.boolean().default(false),
    /**
     * §13.7 附件目录布局：
     * - `by-note`（默认）`：<attachmentsSubdir>/<sourceInstanceId>/<itemKey>/<file>`，跨笔记隔离。
     * - `flat`：`<attachmentsSubdir>/<file>` 直接平铺；同名但内容不同的资源
     *   在 plan 阶段检测到磁盘冲突时自动追加 `-<sha256前8位>` 后缀。
     */
    attachmentPathLayout: z.enum(['by-note', 'flat']).default('by-note'),
    /**
     * §13.8 分片索引分组维度（有序数组）。默认 `['month', 'content-type']`。
     * 可组合 `month`、`content-type`、`collection`。空数组 = 单一分片。
     * 供 Obsidian 适配器的 renderIndex 生成分片索引用。
     *
     * `notebook` 维度此前在枚举中声明但 buildShardKey 未实现（IndexEntry 无
     * notebook 字段），配置后所有条目静默落入单一分片。现从枚举移除以保持
     * 配置契约与实现一致；待阶段 4 notebook 数据源接入后再补回。
     */
    indexGroupBy: z
      .array(z.enum(['month', 'content-type', 'collection']))
      .default(['month', 'content-type']),
    /**
     * 内部注入键（非用户配置）：Job Runner 注入的 migration_job_id，
     * 用于 frontmatter。用户配置中不需要提供。`.strict()` 仍然生效，
     * 但这个键是允许的内部扩展点。
     */
    __migrationJobId: z.string().optional(),
  })
  .strict();

export type ObsidianTargetConfig = z.infer<typeof ObsidianTargetConfigSchema>;
