import { z } from 'zod';

/** §12.2/§18.1 今日头条来源运行时配置。 */
export const ToutiaoSourceConfigSchema = z
  .object({
    /** 来源实例 ID（如 `toutiao-main`）。 */
    sourceInstanceId: z.string().min(1),
    /** §18.1 抓取参数。嵌套对象同样 strict：拼错键（如 navgiationTimeoutMs）
     * 必须报错，不能被静默剥除后落回默认值。 */
    crawl: z
      .object({
        concurrency: z.number().int().min(1).max(3).default(1),
        intervalMs: z.number().int().positive().default(1500),
        navigationTimeoutMs: z.number().int().positive().default(45000),
        extractionTimeoutMs: z.number().int().positive().default(30000),
        maxRetries: z.number().int().nonnegative().default(3),
      })
      .strict()
      .default({}),
    /** §12.10 图片下载上限（字节）。 */
    maxImageBytes: z.number().int().positive().default(50 * 1024 * 1024),
    /**
     * §12.10 SVG 策略。L19: 当前实现固定为「不落地」（SVG 不在 image-downloader 的
     * ALLOWED_MIME 白名单，且 stage 3 sanitize 默认 strip svg 标签），本字段被接受
     * 但暂无代码读取分支。保留为前向兼容点，供后续 preserve/sanitize 模式实现。
     */
    svgPolicy: z.enum(['preserve', 'sanitize', 'remote-link']).default('remote-link'),
  })
  .strict();

export type ToutiaoSourceConfig = z.infer<typeof ToutiaoSourceConfigSchema>;
