import { z } from 'zod';

/** §12.2/§18.1 今日头条来源运行时配置。 */
export const ToutiaoSourceConfigSchema = z
  .object({
    /** 来源实例 ID（如 `toutiao-main`）。 */
    sourceInstanceId: z.string().min(1),
    /** §18.1 抓取参数。 */
    crawl: z
      .object({
        concurrency: z.number().int().min(1).max(3).default(1),
        intervalMs: z.number().int().positive().default(1500),
        navigationTimeoutMs: z.number().int().positive().default(45000),
        extractionTimeoutMs: z.number().int().positive().default(30000),
        maxRetries: z.number().int().nonnegative().default(3),
      })
      .default({}),
    /** §12.10 图片下载上限（字节）。 */
    maxImageBytes: z.number().int().positive().default(50 * 1024 * 1024),
    /** §12.10 SVG 策略：默认 remote-link 不落地。 */
    svgPolicy: z.enum(['preserve', 'sanitize', 'remote-link']).default('remote-link'),
  })
  .strict();

export type ToutiaoSourceConfig = z.infer<typeof ToutiaoSourceConfigSchema>;
