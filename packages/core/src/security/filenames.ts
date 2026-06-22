/**
 * §13.4 Windows 保留名：CON、PRN、AUX、NUL、COM1-9、LPT1-9（含带扩展的形式）。
 * 注意不要误判把保留名作为子串的合法文件名（如 "CONCEPT"）。
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * §13.4 在 Windows/macOS/Linux 上都不允许出现在文件名中的字符。
 * 同时覆盖全角变体（`？`、`＊` 等），因为它们在终端/同步工具中容易造成歧义。
 */
const ILLEGAL = /[\\/:*?"<>|？＊]/g;

/** §13.4 控制字符（C0）。 */
const CONTROL = /[\x00-\x1f]/g;

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
  s = s.replace(ILLEGAL, '-').replace(CONTROL, '');
  s = s.replace(/[\s.]+$/g, '');
  // 先截断（截断可能产生保留名，例如 'CONCEPT' → 'CON'），
  // 之后再删除结尾并检查保留名，避免截断后再次逃逸。
  if (s.length > max) {
    s = s.slice(0, max).replace(/[\s.]+$/g, '');
  }
  if (RESERVED.test(s)) {
    s = '_' + s;
  }
  return s || '_';
}
