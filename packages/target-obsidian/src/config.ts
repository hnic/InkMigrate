import { z } from 'zod';

/**
 * §13.2/§13.7/§13.9 Obsidian 目标适配器运行时配置。
 *
 * 这个 schema 由本包导出，CLI/registry 在校验 `targets[].config` 时合并使用
 * （§10.3 适配器扩展点）。所有路径都是相对 Vault 根的 POSIX 风格。
 */
export const ObsidianTargetConfigSchema = z
  .object({
    /** §13.2 Vault 根目录绝对路径。 */
    vaultPath: z.string().min(1),
    /** §13.3 笔记导入根目录（相对 Vault），默认 `Imports/InkMigrate`。 */
    importSubdir: z
      .string()
      // I16: 拒绝 `..` 路径段，防止配置错误/恶意配置生成逃逸风格的相对路径。
      // resolveWithin 在写入时会兜底拦截，但配置校验阶段就拒绝能让 plan 阶段
      // 不生成畸形 relativePath，避免 plan 成功、write 才炸的语义割裂。
      .refine((s) => !s.split('/').some((seg) => seg === '..'), {
        message: 'importSubdir 不得包含 ".." 路径段',
      })
      .default('Imports/InkMigrate'),
    /** §13.7 附件根目录（相对 Vault），默认 `Attachments/InkMigrate`。 */
    attachmentsSubdir: z
      .string()
      .refine((s) => !s.split('/').some((seg) => seg === '..'), {
        message: 'attachmentsSubdir 不得包含 ".." 路径段',
      })
      .default('Attachments/InkMigrate'),
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
