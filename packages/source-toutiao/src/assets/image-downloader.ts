export interface DownloadInput {
  url: string;
  /** §12.10 单张大小上限；写入前和流式下载过程中都检查。 */
  maxBytes: number;
  /** 重试次数，默认 3。 */
  maxRetries?: number;
  /** 可选 Referer（§12.10 使用当前浏览器会话和正常 Referer）。 */
  referer?: string;
}

export type DownloadResult =
  | {
      ok: true;
      bytes: Buffer;
      mimeType: string;
      byteSize: number;
    }
  | {
      ok: false;
      reason: string;
      httpStatus?: number;
    };

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// 常见图片 Magic Bytes 前缀
const MAGIC_SIGNATURES: ReadonlyArray<{
  mime: string;
  prefix: ReadonlyArray<number>;
}> = [
  { mime: 'image/jpeg', prefix: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', prefix: [0x52, 0x49, 0x46, 0x46] }, // RIFF
];

/**
 * §12.10 图片下载与验证。
 *
 * 流程：
 * 1. HTTP GET（带可选 Referer）。
 * 2. 检查状态码 200。
 * 3. 检查 Content-Type 是允许的图片类型。
 * 4. 流式读取，累计字节数；超过 `maxBytes` 立即中止。
 * 5. 验证非零字节。
 * 6. 验证 Magic Bytes 与 Content-Type 一致。
 *
 * 失败最多重试 `maxRetries` 次（默认 3）。
 */
export async function downloadImage(i: DownloadInput): Promise<DownloadResult> {
  const maxRetries = i.maxRetries ?? 3;
  let lastError: DownloadResult = { ok: false, reason: 'no attempt made' };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await tryDownloadOnce(i);
    if (result.ok) return result;
    lastError = result;
    // 指数退避（仅对网络错误，不对 4xx）
    if (
      attempt < maxRetries &&
      !/status|4\d\d|5\d\d/i.test(result.reason)
    ) {
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  return lastError;
}

async function tryDownloadOnce(i: DownloadInput): Promise<DownloadResult> {
  let response: Response;
  try {
    const fetchOpts: RequestInit = { redirect: 'follow' };
    if (i.referer !== undefined) {
      fetchOpts.headers = { referer: i.referer };
    }
    response = await fetch(i.url, fetchOpts);
  } catch (e) {
    return { ok: false, reason: `network error: ${(e as Error).message}` };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `http status ${response.status}`,
      httpStatus: response.status,
    };
  }

  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_MIME.has(contentType)) {
    return {
      ok: false,
      reason: `content-type not allowed: ${contentType}`,
    };
  }

  // 流式读取，检查上限
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) {
    return { ok: false, reason: 'no response body' };
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > i.maxBytes) {
      return {
        ok: false,
        reason: `size ${total} exceeds maxBytes ${i.maxBytes}`,
      };
    }
    chunks.push(Buffer.from(value));
  }

  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) {
    return { ok: false, reason: 'empty/zero-byte response' };
  }

  // Magic Bytes 一致性
  const sigMatch = MAGIC_SIGNATURES.find((s) =>
    s.prefix.every((b, idx) => bytes[idx] === b),
  );
  if (sigMatch === undefined) {
    return {
      ok: false,
      reason: 'magic bytes do not match any known image format',
    };
  }
  // SVG 不在白名单（§12.10 svgPolicy 单独处理；stage 3 默认 remote-link 不落地）
  // 容忍 webp（RIFF 基础但 MIME 是 webp）
  if (sigMatch.mime !== contentType && contentType !== 'image/webp') {
    return {
      ok: false,
      reason: `magic bytes (${sigMatch.mime}) vs content-type (${contentType}) mismatch`,
    };
  }

  return {
    ok: true,
    bytes,
    mimeType: contentType,
    byteSize: bytes.length,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
