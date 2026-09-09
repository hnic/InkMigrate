import { z } from 'zod';

/**
 * §15.1/§15.2 Evernote 来源配置。
 *
 * `formats` 当前仅接受 `enex`：HTML 导出解析尚未实现，显式报错而非静默忽略，
 * 避免用户以为 HTML 目录会被处理（§15.12 为后续增量）。
 */
export const EvernoteSourceConfigSchema = z
  .object({
    sourceInstanceId: z.string().min(1),
    /** 相对路径相对 workspaceDir 解析；支持文件或目录（目录递归收集 .enex）。 */
    inputPaths: z.array(z.string().min(1)).min(1),
    formats: z
      .array(z.enum(['enex', 'html']))
      .min(1)
      .default(['enex']),
    /** §15.5 `Stack@@@Notebook.enex` 命名约定的分隔符。 */
    stackSeparator: z.string().min(1).default('@@@'),
    assets: z
      .object({
        /** §15.6 正文远程 <img> 是否按 §12.10 管线下载。默认关闭（不发起网络请求）。 */
        downloadImages: z.boolean().default(false),
        maxImageBytes: z.number().int().positive().default(20 * 1024 * 1024),
        /** §15.7.3 单资源上限，默认 DTD 规定的 25 MB。 */
        maxResourceBytes: z.number().int().positive().default(25 * 1024 * 1024),
      })
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
