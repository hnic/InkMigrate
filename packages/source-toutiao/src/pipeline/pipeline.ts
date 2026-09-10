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
   * 在非 test 环境传入会直接抛错（而非静默忽略），让接线错误立刻暴露。
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
 * 降级为纯文本或元数据占位"。本流水线对**完全为空**与**剔除图片语法后无文本**
 *（正文被清洗剥空、只剩裸图链）两类输出降级；其余"非空但可疑"的输出由
 * stage 5（dompurify）+ stage 8（post-clean）静默移除危险内容而不单独标记。
 * 更复杂的"非空但无法证明安全"的降级由调用方（detail-extractor）根据多个信号
 *（提取器失败、结构异常、内容被大量剥离）综合决定，因为单凭流水线无法判断
 * "内容是否可疑"——它只能保证"已移除已知危险内容"。
 */
/** body-missing 降级项：空输入与空产出两处共用，保持 code/stage 口径一致。 */
function bodyMissing(
  stage: SourceDegradation['stage'],
  message: string,
): SourceDegradation {
  return { code: 'body-missing', stage, message };
}

/** 空输入与 stage 失败两条降级出口共用同一结果形状，防止字段漂移。 */
function degradedOutput(degradation: SourceDegradation): PipelineOutput {
  return {
    html: '',
    markdown: '',
    images: [],
    lazyLoadImages: [],
    quality: 'degraded',
    degradations: [degradation],
  };
}

export function runSafetyPipeline(
  html: string,
  options: PipelineOptions,
): PipelineOutput {
  // baseUrl 是调用方配置（非不可信文档内容），入口即校验并响亮失败：
  // 空/畸形 base 会让 stage 6 的每个 new URL(相对路径, base) 抛 TypeError，
  // 整条被误分类为 'unsupported-structure'（内容问题），掩盖上游配置 bug
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch {
    throw new Error(
      `runSafetyPipeline: invalid baseUrl ${JSON.stringify(options.baseUrl).slice(0, 100)}`,
    );
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error(`runSafetyPipeline: baseUrl must be http(s), got ${baseUrl.protocol}`);
  }

  const trimmed = html.trim();
  if (trimmed.length === 0) {
    return degradedOutput(bodyMissing('extract', 'empty body after trim'));
  }

  let resolved: ReturnType<typeof resolveLazyLoadAndUrls>;
  let markdown: string;
  // 内部阶段归因标签：SourceDegradationStage 枚举只到 'normalize' 粒度
  //（scan/extract/normalize/assets），无法逐 stage 区分，故把内部阶段名写进
  // message、stage 保持合法枚举值，诊断时不丢归因（§12.9 逐阶段降级契约）
  let failedStage = 'pre-clean';
  try {
    // stage 3
    const preCleaned = preCleanHtml(trimmed);
    failedStage = 'sanitize';
    // stage 5
    const sanitized = sanitizeHtml(preCleaned);
    failedStage = 'resolve-lazy-load';
    // stage 6
    resolved = resolveLazyLoadAndUrls(sanitized, baseUrl.toString());
    failedStage = 'turndown';
    // stage 7
    markdown = htmlToMarkdownSafe(resolved.html);
    if (options.injectForPostCleanTest !== undefined) {
      if (process.env.NODE_ENV !== 'test') {
        // 测试钩子在非 test 环境被传入即响亮失败：该旁路注入的内容不经
        // stage 5 允许列表清洗，静默忽略（或静默生效）都会掩盖接线错误
        throw new Error(
          'injectForPostCleanTest is a test-only hook; refusing to run outside NODE_ENV=test',
        );
      }
      markdown = markdown + '\n' + options.injectForPostCleanTest;
    }
    failedStage = 'post-clean';
    // stage 8
    markdown = postCleanMarkdown(markdown);
  } catch (error) {
    // 降级契约（§12.9 rule 7）：stage 3-8 任一异常（畸形/恶意输入让 jsdom、
    // DOM 操作或 turndown 抛出）也按降级返回，不让单篇坏文档击穿整个提取流程。
    // message 去控制字符/换行并截断：jsdom/turndown 的报文常内嵌不可信文档
    // 片段，原样进入结构化输出会构成日志注入与无限膨胀
    const raw = error instanceof Error ? error.message : String(error);
    const message = `pipeline stage failed (${failedStage}): ${raw}`
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 300);
    return degradedOutput({
      code: 'unsupported-structure',
      stage: 'normalize',
      message,
    });
  }

  const degradations: SourceDegradation[] = [];
  let quality: SourceItemQuality = 'full';
  if (markdown.trim().length === 0) {
    quality = 'degraded';
    degradations.push(
      bodyMissing('normalize', 'pipeline produced empty markdown after sanitize+convert'),
    );
  } else if (markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim().length === 0) {
    // 多信号检查的最小落地：剔除图片语法后无任何文本（正文被清洗剥空、只剩
    // 裸图链）也按 degraded + body-missing 标记，不再以 'full' 交付
    quality = 'degraded';
    degradations.push(
      bodyMissing('normalize', 'pipeline produced image-only markdown after sanitize+convert'),
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
