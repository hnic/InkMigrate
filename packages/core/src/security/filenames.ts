/**
 * §13.4 Windows 保留名：CON、PRN、AUX、NUL、COM1-9、LPT1-9（含带扩展的形式）。
 * 注意不要误判把保留名作为子串的合法文件名（如 "CONCEPT"）。
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 文件名专用实体解码：仅解码 `&quot;`，不解码 `&amp;`。
 *
 * 正文解码（entities.ts）需要处理 `&amp;`，但文件名场景下 `&` 是合法字符、
 * 不该被改动；而 `&quot;` 解码出的 `"` 会被随后的 ILLEGAL 正则替换为 `-`。
 * 这里只针对 `&quot;` 一个实体，避免 `&amp;` / `&lt;` 等在文件名里被误改。
 */
const ENTITY_QUOT_RE = /&quot;/g;

/**
 * §13.4 在 Windows/macOS/Linux 上都不允许出现在文件名中的字符。
 * 同时覆盖全角变体（`／`：`＼`：`＜`＞`｜`？`＊` 等），因为它们在终端/同步工具中
 * 容易造成歧义。L1: 原仅覆盖 ？＊，补齐 ／＼：＜＞｜＂ 全角形式。
 */
const ILLEGAL = /[\\/:*?"<>|／＼：＜＞｜＂？＊]/g;

/** §13.4 控制字符（C0 + DEL + C1）+ BOM。M-8: 补全 C1(0x80-0x9f) 和 BOM(U+FEFF)。
 * 另含不可见/双向格式字符：ZWSP/ZWJ/ZWNJ（U+200B-200F，含 LRM/RLM）、行/段
 * 分隔符 U+2028/9、双向覆盖 U+202A-202E（RLO 是隐藏真实扩展名的经典文件名
 * 欺骗向量）、词连接符 U+2060-2064——与全角变体同属「终端/同步工具中易歧义」
 * 类，一并删除。 */
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2064\uFEFF]/g;

export interface SanitizeOptions {
  /** 主体最大长度，默认 100。 */
  maxLength?: number;
}

/**
 * §13.4 文件名清理。流程：
 *
 * 1. Unicode NFC 规范化（避免 NFD/组合字符造成的同名不同字节问题）。
 * 2. 把非法字符（`\/:*?"<>|`）替换为 `-`。
 * 3. 删除控制字符。
 * 4. 删除结尾的句点和空格（Windows 不允许）。
 * 5. 若命中 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）则前缀下划线。
 * 6. 截断到 `maxLength`，截断后再次去除结尾句点/空格。
 * 7. 全部清理后若为空，返回 `_` 作为非空占位。
 */
export function sanitizeFilename(
  input: string,
  opts: SanitizeOptions = {},
): string {
  const max = opts.maxLength ?? 100;
  let s = input.normalize('NFC');
  // §13.6 先解码标题里泄漏的 &quot;（HTML 多次序列化的副作用），解码出的 "
  // 会被随后的 ILLEGAL 正则替换为 -。不解码 &amp;/&lt; 等（见 ENTITY_QUOT_RE 注释）。
  s = s.replace(ENTITY_QUOT_RE, '"');
  s = s.replace(ILLEGAL, '-').replace(CONTROL, '');
  s = s.replace(/[\s.]+$/g, '');
  // 先截断（截断可能产生保留名，例如 'CONCEPT' → 'CON'），
  // 之后再删除结尾并检查保留名，避免截断后再次逃逸。
  // L1: 用 Array.from 按 code point 截断，避免 slice(0,max) 截断代理对（如 emoji）
  // 产生孤立代理导致无效文件名。判长与截断必须同一单位：guard 若用 UTF-16
  // code unit 计数（s.length），astral 密集输入（如 60 个 emoji = 120 units）会
  // 进入截断分支却按 code point 保留全部字符，结果仍超长（最多 2×max units）。
  const cps = Array.from(s);
  if (cps.length > max) {
    s = cps.slice(0, max).join('').replace(/[\s.]+$/g, '');
  }
  // 保留名前缀在截断之后追加，结果可能超出 maxLength 1 个字符——这是被测试
  // 固化的既有契约（'CONCEPT'+max3 → '_CON'）：SanitizeOptions 的 maxLength
  // 语义是「主体最大长度」，前缀是 Windows 保留名防护的额外开销，不为它
  // 牺牲主体信息量。
  if (RESERVED.test(s)) {
    s = '_' + s;
  }
  return s || '_';
}
