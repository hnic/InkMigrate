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
// H2: 原用 (\S+) 只匹配首个非空白词，含空格的密钥值（如 `client_secret: a b c`）
// 会泄漏空格后的部分。改用 [^\n\r]+ 匹配到行/记录尾，与 COOKIE/AUTH 一致。
const TOKEN_RE = /(\b[\w-]*token\s*[:=]\s*)([^\n\r]+)/gi;
// I22: password / passwd / pwd / secret / client_secret / apikey / api_key / passphrase
// 等凭据赋值（头、query、JSON）。与 token 同样宁多脱敏勿少脱敏。
// H2: 同上，(\S+) 改为 [^\n\r]+，避免多词密钥泄漏。
// 注意：alternation 中把更具体的 client_secret 放在 secret 之前，避免 secret 先匹配
// 掉 client_secret 的尾部导致 `client_` 残留（虽仍脱敏了值，但前缀噪声不精确）。
const SECRET_RE =
  /(\b(?:pass(?:word|wd|phrase)?|client_secret|secret|api[_-]?key|apikey)\s*[:=]\s*)([^\n\r]+)/gi;
// I22 / C11: 头条收藏页 URL 内嵌的会话 token：
// `https://www.toutiao.com/c/user/token/<TOKEN>?tab=fav`。把 token 段替换为 <redacted>。
const FAVORITES_TOKEN_RE = /(\/c\/user\/token\/)[^/?\s"']+/gi;
// 中英文验证码：保留前缀冒号或等号。
const VERIFYCODE_RE =
  /(验证码|verification code|otp)(\s*[:=]?\s*)(\d{4,8})/gi;
// 中国大陆 11 位手机号：1[3-9]xxxxxxxxx，可选 +86 前缀。
// 词边界用前后非数字 lookaround（而非 \b），避免腐蚀日志里的合法数字串
//（订单号、时间戳、字节大小等超 11 位的数字串会被无边界正则误匹配中间 11 位）。
// (?<!\d) 要求前一个字符不是数字（或位于串首），(?!\d) 要求后一个字符不是数字。
const PHONE_RE = /(?<!\d)(\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export function createRedactor(): Redactor {
  const home = homedir();
  // L2: homedir() 在某些沙箱/CI 环境可能返回 '' 或 '/'。空串会构造出空正则
  //（匹配每个位置 → 在每个字符间插入 [HOME] 腐蚀日志），'/' 会把所有路径分隔符
  // 替换为 [HOME] 且仍泄漏子路径。仅当 home 是有意义的具体目录时才启用 home 脱敏。
  const homeRe =
    home.length > 1 && home !== '/'
      ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      : null;
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
    if (homeRe !== null) {
      s = s.replace(homeRe, '[HOME]');
    }
    return s;
  };
}
