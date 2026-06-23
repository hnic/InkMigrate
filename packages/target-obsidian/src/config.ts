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
    importSubdir: z.string().default('Imports/InkMigrate'),
    /** §13.7 附件根目录（相对 Vault），默认 `Attachments/InkMigrate`。 */
    attachmentsSubdir: z.string().default('Attachments/InkMigrate'),
    /** §13.7 链接风格，默认 wikilink。 */
    linkStyle: z.enum(['wikilink', 'markdown']).default('wikilink'),
    /** §13.9 覆盖策略，默认 preserve（最安全）。 */
    overwritePolicy: z
      .enum(['preserve', 'replace', 'write-new', 'metadata-only'])
      .default('preserve'),
    /** §13.5 集合映射策略，默认原样写入 source_collections，不转标签/目录。 */
    collectionMapping: z
      .object({
        toTags: z.boolean().default(false),
        toFolders: z.boolean().default(false),
      })
      .default({ toTags: false, toFolders: false }),
    /** §13.4 文件名主体最大长度，默认 100。 */
    maxFilenameLength: z.number().int().positive().default(100),
  })
  .strict();

export type ObsidianTargetConfig = z.infer<typeof ObsidianTargetConfigSchema>;
