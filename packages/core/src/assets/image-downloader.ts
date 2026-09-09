import { lookup } from 'node:dns/promises';

export interface DownloadInput {
  url: string;
  /** §12.10 单张大小上限；写入前和流式下载过程中都检查。 */
  maxBytes: number;
  /** 最大尝试次数（含首次），默认 3。 */
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

// 云元数据主机名（AWS/GCP/Azure/阿里云），fetch 前直接拒绝
const META_HOSTS = new Set([
  '169.254.169.254', // AWS/GCP
  'metadata.google.internal', // GCP
  'metadata.azure.com', // Azure
  '100.100.100.200', // 阿里云
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
    // 4xx 是确定性失败（403 防盗链/404 已删除），重试只会白白多发请求，直接返回。
    // 5xx 可重试但无需退避。用结构化 httpStatus 判定而非字符串正则：
    // 后者依赖 reason 文案，本地化/重构会失效。
    if (
      !result.ok &&
      result.httpStatus !== undefined &&
      result.httpStatus >= 400 &&
      result.httpStatus < 500
    ) {
      return result;
    }
    // 指数退避仅对网络错误（无 httpStatus 的失败：DNS/超时/内容校验等）。
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

/**
 * 将 IPv6 文本展开为 8 组 hextet（0-65535）；支持 `::` 压缩与尾部内嵌 IPv4
 * （点分形式）。无法解析时返回 undefined。
 */
function parseIpv6(ip: string): number[] | undefined {
  const lower = ip.toLowerCase();
  const halves = lower.split('::');
  if (halves.length > 2) return undefined;
  const expand = (segment: string): number[] | undefined => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const part of segment.split(':')) {
      const v4 = part.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (v4) {
        const bytes = v4.slice(1).map(Number);
        if (bytes.some((b) => b > 255)) return undefined;
        groups.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        groups.push(parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return groups;
  };
  if (halves.length === 1) {
    const head = expand(halves[0]!);
    return head !== undefined && head.length === 8 ? head : undefined;
  }
  const head = expand(halves[0]!);
  const tail = expand(halves[1]!);
  if (head === undefined || tail === undefined) return undefined;
  if (head.length + tail.length > 7) return undefined;
  return [
    ...head,
    ...new Array<number>(8 - head.length - tail.length).fill(0),
    ...tail,
  ];
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
  // IPv6：字符串前缀匹配覆盖不了内嵌 IPv4 的各种变体（十六进制/点分 mapped、
  // IPv4-compatible、NAT64、6to4、Teredo），先展开成 8 组 hextet 再判定。
  const g = parseIpv6(ip);
  if (g === undefined) return true; // 解析失败一律视为不安全
  const h = (i: number) => g[i]!;
  const isZero = (from: number, to: number) =>
    g.slice(from, to).every((x) => x === 0);
  // 末 32 位还原成内嵌 IPv4（mapped/compatible/NAT64 共用）
  const embeddedV4 = `${h(6) >> 8}.${h(6) & 0xff}.${h(7) >> 8}.${h(7) & 0xff}`;
  if (isZero(0, 5) && h(5) === 0xffff) {
    // ::ffff:0:0/96 IPv4-mapped（含 ::ffff:7f00:1 等十六进制写法），按内嵌 IPv4 判定
    return isPrivateOrLoopback(embeddedV4);
  }
  if (isZero(0, 6)) {
    // ::/96 IPv4-compatible（:: 与 ::1 的内嵌 0.0.0.x 同样命中 0/8 判定）
    return isPrivateOrLoopback(embeddedV4);
  }
  if ((h(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((h(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((h(0) & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (h(0) === 0x64 && h(1) === 0xff9b) {
    // NAT64 64:ff9b::/96：内嵌 IPv4 在末 32 位
    return isPrivateOrLoopback(embeddedV4);
  }
  if (h(0) === 0x2002) {
    // 6to4 2002::/16：内嵌 IPv4 在第 2~3 组
    const v4 = `${h(1) >> 8}.${h(1) & 0xff}.${h(2) >> 8}.${h(2) & 0xff}`;
    return isPrivateOrLoopback(v4);
  }
  if (h(0) === 0x2001 && h(1) === 0x0000) {
    // Teredo 2001::/32：内嵌地址经混淆无法静态判定，整体视为不可信
    return true;
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
    // R3-M3: redirect:'manual' + 逐跳重新校验目标 IP（原 'follow' 不校验重定向目标，
    // 攻击者用 benign URL 302 到 169.254.169.254 即可绕过 SSRF 防护）。
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const fetchOpts: RequestInit = {
      redirect: 'manual',
      signal: timeoutSignal,
    };
    if (i.referer !== undefined) {
      fetchOpts.headers = { referer: i.referer };
    }
    response = await fetch(i.url, fetchOpts);

    // R3-M3: 手动跟随重定向，每跳重新 assertSafeImageUrl
    let currentUrl = i.url;
    let redirectCount = 0;
    while (response.status >= 300 && response.status < 400 && redirectCount < 5) {
      const location = response.headers.get('location');
      if (!location) break;
      // 相对 Location 必须基于"当前跳"的 URL 解析（RFC 7231），而非原始 i.url
      const targetUrl = new URL(location, currentUrl).toString();
      if (!i.allowPrivateTargets) {
        try {
          await assertSafeImageUrl(targetUrl);
        } catch (e) {
          return { ok: false, reason: `ssrf blocked (redirect): ${(e as Error).message}` };
        }
      }
      // 跨 origin 重定向不回放原始 referer（对齐浏览器对 Referer 的跨域限制）；
      // exactOptionalPropertyTypes 下不能写 headers = undefined，改为重建选项
      const crossOrigin = new URL(targetUrl).origin !== new URL(currentUrl).origin;
      const hopOpts: RequestInit = crossOrigin
        ? { redirect: 'manual', signal: timeoutSignal }
        : fetchOpts;
      response = await fetch(targetUrl, hopOpts);
      currentUrl = targetUrl;
      redirectCount++;
    }
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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > i.maxBytes) {
        // 主动取消读取，立即释放底层连接
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          reason: `size ${total} exceeds maxBytes ${i.maxBytes}`,
        };
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    // 中途超时/连接重置：AbortSignal.timeout 对 body 流同样生效；
    // 按 DownloadResult 契约返回失败，而非向上抛未处理 rejection
    return { ok: false, reason: `body read error: ${(e as Error).message}` };
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
  // R4-C3: 容忍 image/jpg（image/jpeg 的非标准但常见别名，magic bytes 报 image/jpeg）。
  // webp 检测已校验 offset 8 的 WEBP 标记，无需再整体豁免 content-type——
  // 否则任意字节流只要声称 image/webp 就能绕过一致性校验。
  if (
    sigMatch.mime !== contentType &&
    !(sigMatch.mime === 'image/jpeg' && contentType === 'image/jpg')
  ) {
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
