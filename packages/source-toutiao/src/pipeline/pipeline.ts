import type { SourceDegradation, SourceItemQuality } from '@inkmigrate/core';
import { preCleanHtml } from './pre-clean.js';
import { sanitizeHtml } from './sanitize.js';
import { resolveLazyLoadAndUrls } from './lazy-load.js';
import { htmlToMarkdownSafe, postCleanMarkdown } from './post-clean.js';

export interface PipelineOptions {
  /** 用于解析相对 URL 和懒加载资源。 */
  baseUrl: string;
  /**
   * 测试钩子：模拟 turndown 漏过的 HTML，验证 post-clean。
   * 仅在 NODE_ENV=test 下生效——注入内容不经过 stage 5 允许列表清洗，
   * 生产路径不接受该旁路，调用方不得向其转发任何不可信数据。
   */
  injectForPostCleanTest?: string;
}

export interface PipelineOutput {
  /** §12.9 stage 5/6 之后的清洗 HTML。 */
  html: string;
  /** §12.9 stage 7/8 之后的可信 Markdown。 */
  markdown: string;
  /** §12.9 stage 6 收集的最终图片 URL 清单（供附件下载）。 */
  images: string[];
  lazyLoadImages: string[];
  quality: SourceItemQuality;
  degradations: SourceDegradation[];
}

/**
 * §12.9 固定 9 阶段 HTML→Markdown 安全流水线。
 *
 * 顺序不可改变：
 *   1. 获取独立 DOM/HTML 快照（调用方传入；本函数从 stage 2 开始）
 *   2. jsdom 创建（禁脚本）——在各阶段内部完成
 *   3. 预清洗：移除脚本、事件、iframe、object、embed、危险 URI
 *   4. 站点提取器 / 结构化数据 / Readability —— 由调用方在 stage 3 之前完成
 *   5. 允许列表 HTML Sanitization（dompurify）
 *   6. 解析相对 URL、懒加载资源、附件引用
 *   7. Turndown 转 Markdown
 *   8. Markdown 后清洗
 *   9. （stage 9 验证由调用方做，本函数返回结构化结果）
 *
 * 当输入为空或全空白时，返回 `quality: 'degraded'` + `body-missing`。
 *
 * **设计决策（degradation rule 7，§12.9）**：规格要求"任一步无法证明安全或完整时，
 * 降级为纯文本或元数据占位"。本流水线只对**完全为空**的输出降级；对于"非空但
 * 可疑"的输出，stage 5（dompurify）+ stage 8（post-clean）会静默移除危险内容
 * 而不单独标记。"非空但无法证明安全"的降级路径由调用方（detail-extractor）根据
 * 多个信号（提取器失败、结构异常、内容被大量剥离）综合决定，因为单凭流水线
 * 无法判断"内容是否可疑"——它只能保证"已移除已知危险内容"。
 */
/** body-missing 降级项：空输入与空产出两处共用，保持 code/stage 口径一致。 */
function bodyMissing(
  stage: SourceDegradation['stage'],
  message: string,
): SourceDegradation {
  return { code: 'body-missing', stage, message };
}

export function runSafetyPipeline(
  html: string,
  options: PipelineOptions,
): PipelineOutput {
  const trimmed = html.trim();
  if (trimmed.length === 0) {
    return {
      html: '',
      markdown: '',
      images: [],
      lazyLoadImages: [],
      quality: 'degraded',
      degradations: [bodyMissing('extract', 'empty body after trim')],
    };
  }

  let resolved: ReturnType<typeof resolveLazyLoadAndUrls>;
  let markdown: string;
  try {
    // stage 3
    const preCleaned = preCleanHtml(trimmed);
    // stage 5
    const sanitized = sanitizeHtml(preCleaned);
    // stage 6
    resolved = resolveLazyLoadAndUrls(sanitized, options.baseUrl);
    // stage 7
    markdown = htmlToMarkdownSafe(resolved.html);
    if (
      options.injectForPostCleanTest !== undefined &&
      process.env.NODE_ENV === 'test'
    ) {
      markdown = markdown + '\n' + options.injectForPostCleanTest;
    }
    // stage 8
    markdown = postCleanMarkdown(markdown);
  } catch (error) {
    // 降级契约（§12.9 rule 7）：stage 3-8 任一异常（畸形/恶意输入让 jsdom、
    // DOM 操作或 turndown 抛出）也按降级返回，不让单篇坏文档击穿整个提取流程
    return {
      html: '',
      markdown: '',
      images: [],
      lazyLoadImages: [],
      quality: 'degraded',
      degradations: [
        {
          code: 'unsupported-structure',
          stage: 'normalize',
          message: `pipeline stage failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const degradations: SourceDegradation[] = [];
  let quality: SourceItemQuality = 'full';
  if (markdown.trim().length === 0) {
    quality = 'degraded';
    degradations.push(
      bodyMissing('normalize', 'pipeline produced empty markdown after sanitize+convert'),
    );
  }

  return {
    html: resolved.html,
    markdown,
    images: resolved.images,
    lazyLoadImages: resolved.lazyLoadImages,
    quality,
    degradations,
  };
}
