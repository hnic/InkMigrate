import { z } from 'zod';

/**
 * §15.1/§15.2 Evernote 来源配置。
 *
 * `formats` 接受 `enex` 与 `html`（§15.12）：ENEX 按文件递归收集、HTML 导出
 * 按目录扫描，每条 .html 生成一个笔记。
 */
export const EvernoteSourceConfigSchema = z
  .object({
    sourceInstanceId: z.string().min(1),
    /** 相对路径相对 workspaceDir 解析（绝对路径原样使用，不限定在 workspace 内，
     * 符号链接一律跳过防逃逸）；支持文件或目录（目录递归收集 .enex）。 */
    inputPaths: z.array(z.string().min(1)).min(1),
    formats: z
      .array(z.enum(['enex', 'html']))
      .min(1)
      .default(['enex']),
    /** §15.5 笔记本名推断策略；当前仅实现 filename（ENEX/HTML 文件名推断）。 */
    notebookNameStrategy: z.literal('filename').default('filename'),
    /** §15.5 `Stack@@@Notebook.enex` 命名约定的分隔符。 */
    stackSeparator: z.string().min(1).default('@@@'),
    /**
     * §15.5 用户映射清单覆盖：键为 ENEX 文件名（带或不带 .enex 后缀），
     * 值覆盖文件名推断出的 stack/notebook；mergeKey 非空的多个文件合并进
     * 同一笔记本目录（同组笔记本名必须一致，采集时校验）。
     * 同一文件的带/不带后缀两键并存（如 Notebook 与 Notebook.enex）时快速
     * 失败——扫描期「不带后缀键优先」的静默遮蔽会产生误导性未命中告警。
     */
    notebookMappings: z
      .record(
        z.string().min(1),
        z
          .object({
            /** 覆盖 Stack；null 表示清除文件名推断出的 Stack（merge 场景）。 */
            stack: z.string().min(1).nullable().optional(),
            notebook: z.string().min(1).optional(),
            mergeKey: z.string().min(1).nullable().default(null),
          })
          .strict(),
      )
      .superRefine((mappings, ctx) => {
        const seen = new Set<string>();
        for (const key of Object.keys(mappings)) {
          const normalized = key.replace(/\.enex$/, '');
          if (seen.has(normalized)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `notebookMappings 存在指向同一文件的重复键："${key}"（带/不带 .enex 后缀的键不得并存）`,
            });
          }
          seen.add(normalized);
        }
      })
      .default({}),
    /** §15.8 地理位置显式启用（默认关闭：位置信息敏感性高）。 */
    includeGeolocation: z.boolean().default(false),
    /**
     * §15.5 笔记本目录是否携带 notebookKey 前 8 位后缀（防同名笔记本合并）。
     * 默认 true（PRD 冲突安全要求）；false 时目录用纯笔记本名——同名笔记本
     * 会落入同一目录，适合已知无同名的干净导出。
     */
    notebookShortId: z.boolean().default(true),
    assets: z
      .object({
        /** §15.6 正文远程 <img> 是否按 §12.10 管线下载。默认关闭（不发起网络请求）。 */
        downloadImages: z.boolean().default(false),
        maxImageBytes: z.number().int().positive().default(20 * 1024 * 1024),
        /** §15.7.3 单资源上限，默认 DTD 规定的 25 MB。 */
        maxResourceBytes: z.number().int().positive().default(25 * 1024 * 1024),
      })
      // 嵌套对象同样 strict（与外层一致）：downloadImage 之类键名笔误若被静默
      // 剥离，用户以为启用了下载而实际没有
      .strict()
      .default({}),
  })
  .strict();

export type EvernoteSourceConfig = z.infer<typeof EvernoteSourceConfigSchema>;
/** 工厂输入：允许省略有默认值的字段。 */
export type EvernoteSourceConfigInput = z.input<typeof EvernoteSourceConfigSchema>;

/** 解析并校验适配器配置；非法配置抛 zod 错误（调用方转为 ValidationResult）。 */
export function parseEvernoteConfig(raw: unknown): EvernoteSourceConfig {
  return EvernoteSourceConfigSchema.parse(raw);
}
