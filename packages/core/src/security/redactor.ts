import { homedir } from 'node:os';

/** §19.2 统一脱敏函数：输入字符串，输出脱敏后的字符串。 */
export type Redactor = (input: string) => string;

// Cookie：`cookie`/`Cookie`/`Set-Cookie` 后跟 `:` 或 `=`，然后整个值（含 `;`-分隔的额外 cookie）。
// I22: `\bcookie\b` 不匹配 `Set-Cookie`（`-` 是单词边界），需显式覆盖 Set-Cookie 响应头。
const COOKIE_RE = /(\b(?:set-)?cookie\s*[:=]\s*)([^\n\r]+)/gi;
// Authorization 头：整个剩余值。
const AUTH_RE = /(\bauthorization\s*[:=]\s*)([^\n\r]+)/gi;
// 任意 `*_token` 或单独 `token` 的赋值。
// 注意：`[\w-]*` 含下划线，故 `access_token_count: 5` 也会匹配——这是【有意的
// 过度脱敏】（false positive 优于泄漏真实 token）。安全工具宁多脱敏勿少脱敏。
const TOKEN_RE = /(\b[\w-]*token\s*[:=]\s*)(\S+)/gi;
// I22: password / passwd / pwd / secret / client_secret / apikey / api_key / passphrase
// 等凭据赋值（头、query、JSON）。与 token 同样宁多脱敏勿少脱敏。
const SECRET_RE = /(\b(?:pass(?:word|wd|phrase)?|secret|client_secret|api[_-]?key|apikey)\s*[:=]\s*)(\S+)/gi;
// I22 / C11: 头条收藏页 URL 内嵌的会话 token：
// `https://www.toutiao.com/c/user/token/<TOKEN>?tab=fav`。把 token 段替换为 <redacted>。
const FAVORITES_TOKEN_RE = /(\/c\/user\/token\/)[^/?\s"']+/gi;
// 中英文验证码：保留前缀冒号或等号。
const VERIFYCODE_RE =
  /(验证码|verification code|otp)(\s*[:=]?\s*)(\d{4,8})/gi;
// 中国大陆 11 位手机号：1[3-9]xxxxxxxxx，可选 +86 前缀。
const PHONE_RE = /(\+?86[- ]?)?1[3-9]\d{9}/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export function createRedactor(): Redactor {
  const home = homedir();
  const homeRe = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return (input: string) => {
    let s = input;
    s = s.replace(COOKIE_RE, '$1[REDACTED]');
    s = s.replace(AUTH_RE, '$1[REDACTED]');
    s = s.replace(TOKEN_RE, '$1[REDACTED]');
    s = s.replace(SECRET_RE, '$1[REDACTED]');
    s = s.replace(FAVORITES_TOKEN_RE, '$1<redacted>');
    s = s.replace(VERIFYCODE_RE, '$1$2[REDACTED]');
    s = s.replace(EMAIL_RE, '[REDACTED_EMAIL]');
    s = s.replace(PHONE_RE, '[REDACTED_PHONE]');
    s = s.replace(homeRe, '[HOME]');
    return s;
  };
}
