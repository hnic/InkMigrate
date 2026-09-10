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
     * ALLOWED_MIME 白名单，且 stage 3 sanitize 默认 strip svg 标签）。
     * preserve/sanitize 模式尚未实现——非默认值会被拒绝而不是静默接受后忽略
     *（与 Evernote 配置 formats 的 fail-fast 口径一致：设置一个不生效的值会
     * 让运营者误以为 SVG 已保留，实际悄悄丢失）。实现后移除 refine 并放开枚举。
     */
    svgPolicy: z
      .enum(['preserve', 'sanitize', 'remote-link'])
      .default('remote-link')
      .refine((v) => v === 'remote-link', {
        message:
          "svgPolicy 'preserve'/'sanitize' 尚未实现，当前仅支持 'remote-link'（SVG 不落地）",
      }),
  })
  .strict();

export type ToutiaoSourceConfig = z.infer<typeof ToutiaoSourceConfigSchema>;
