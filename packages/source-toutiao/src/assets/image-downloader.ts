import { lookup } from 'node:dns/promises';

export interface DownloadInput {
  url: string;
  /** §12.10 单张大小上限；写入前和流式下载过程中都检查。 */
  maxBytes: number;
  /** 重试次数，默认 3。 */
  maxRetries?: number;
  /** 可选 Referer（§12.10 使用当前浏览器会话和正常 Referer）。 */
  referer?: string;
  /** C7: 总下载超时毫秒（含连接 + 流式读取），默认 30000。防止慢/挂图片服务器永久阻塞。 */
  timeoutMs?: number;
  /**
   * C7: 是否允许回环/私网目标。生产环境恒为 false（防 SSRF）；
   * 仅测试用例连接本地 mock 服务器时显式传 true。生产调用方不得设置。
   */
  allowPrivateTargets?: boolean;
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
  extraOffset?: number;
  extraPrefix?: ReadonlyArray<number>;
}> = [
  { mime: 'image/jpeg', prefix: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', prefix: [0x52, 0x49, 0x46, 0x46], extraOffset: 8, extraPrefix: [0x57, 0x45, 0x42, 0x50] }, // RIFF + WEBP at offset 8
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
    // 指数退避（仅对网络错误，不对 HTTP 状态码错误——4xx/5xx 重试无意义）。
    // 用结构化 httpStatus 判定而非字符串正则：后者依赖 reason 文案，本地化/重构会失效。
    const isHttpError = !result.ok && result.httpStatus !== undefined;
    if (attempt < maxRetries && !isHttpError) {
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  return lastError;
}

/**
 * C7: SSRF 防护。文章正文里的图片 URL 由来源内容控制（半可信甚至不可信），
 * 直接 fetch 会暴露内网：`http://169.254.169.254/latest/meta-data/...`（云元数据）、
 * `http://127.0.0.1:port/...`、`http://10.x/192.168.x/...`（内网扫描）。
 * Magic Bytes 校验限制了数据回显，但请求本身仍被发出（盲打时序/端口扫描/触发内部 endpoint）。
 *
 * 这里在 fetch 前校验：协议仅 https/http；DNS 解析后拒绝私网/回环/链路本地/云元数据地址。
 * 注意：DNS 解析与实际连接之间存在 rebinding 窗口，但对 local-first 工具威胁较低；
 * 拒绝解析到内网 IP 已能挡住绝大多数静态 SSRF payload。
 */
async function assertSafeImageUrl(urlStr: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`invalid image url: ${urlStr}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`image url scheme not allowed: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  // 云元数据主机名（AWS/GCP/Azure）直接拒绝
  const META_HOSTS = new Set([
    '169.254.169.254', // AWS/GCP
    'metadata.google.internal', // GCP
    'metadata.azure.com', // Azure
    '100.100.100.200', // 阿里云
  ]);
  if (META_HOSTS.has(host)) {
    throw new Error(`image url points to cloud metadata endpoint: ${host}`);
  }
  // DNS 解析后逐个校验 IP（hostname 可能解析到多个 A 记录）
  let addrs: { address: string }[];
  try {
    const result = await lookup(host, { all: true });
    addrs = result;
  } catch {
    throw new Error(`image url host unresolvable: ${host}`);
  }
  for (const a of addrs) {
    if (isPrivateOrLoopback(a.address)) {
      throw new Error(
        `image url resolves to private/loopback address ${a.address} (SSRF blocked)`,
      );
    }
  }
}

/** 判断 IP 是否为私网/回环/链路本地/保留地址。 */
function isPrivateOrLoopback(ip: string): boolean {
  // IPv4
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6，复用 IPv4 判定
    const v4part = lower.slice('::ffff:'.length);
    return isPrivateOrLoopback(v4part);
  }
  return false;
}

async function tryDownloadOnce(i: DownloadInput): Promise<DownloadResult> {
  // C7: SSRF 防护——fetch 前校验 URL 不指向内网/元数据（生产环境强制）。
  // allowPrivateTargets 仅测试用例连接本地 mock 服务器时使用，生产调用方不得设置。
  if (!i.allowPrivateTargets) {
    try {
      await assertSafeImageUrl(i.url);
    } catch (e) {
      return { ok: false, reason: `ssrf blocked: ${(e as Error).message}` };
    }
  }

  let response: Response;
  try {
    // I3: 总超时（连接 + 读取），防止慢/挂图片服务器永久阻塞 extract。
    const timeoutMs = i.timeoutMs ?? 30000;
    const fetchOpts: RequestInit = {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    };
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

  // Magic Bytes 一致性（含可选的偏移校验，如 webp 的 WEBP 标记）
  const sigMatch = MAGIC_SIGNATURES.find((s) => {
    if (!s.prefix.every((b, idx) => bytes[idx] === b)) return false;
    if (s.extraOffset !== undefined && s.extraPrefix !== undefined) {
      return s.extraPrefix.every((b, idx) => bytes[s.extraOffset! + idx] === b);
    }
    return true;
  });
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
