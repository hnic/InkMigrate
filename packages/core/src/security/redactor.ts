import { homedir } from 'node:os';

/** §19.2 统一脱敏函数：输入字符串，输出脱敏后的字符串。 */
export type Redactor = (input: string) => string;

// Cookie：`cookie`/`Cookie`/`Set-Cookie` 后跟 `:` 或 `=`，然后整个值（含 `;`-分隔的额外 cookie）。
// I22: `\bcookie\b` 不匹配 `Set-Cookie`（`-` 是单词边界），需显式覆盖 Set-Cookie 响应头。
// 键后与值前的可选引号（`['"]?`）：JSON 形态 `"cookie": "a=b"` 的键以引号结尾，
// 无引号容忍时四个键值正则全部失配、值原样泄漏——字符串化的 JSON 恰是错误
// 消息/日志最常见形态。值捕获会连带吞掉值的收尾引号，属既定的过度脱敏。
const COOKIE_RE = /(\b(?:set-)?cookie['"]?\s*[:=]\s*['"]?)([^\n\r]+)/gi;
// Authorization 头：整个剩余值。同上容忍 JSON 引号形态。
const AUTH_RE = /(\bauthorization['"]?\s*[:=]\s*['"]?)([^\n\r]+)/gi;
// 任意 `*_token` 或单独 `token` 的赋值。
// 注意：`[\w-]*` 含下划线，故 `access_token_count: 5` 也会匹配——这是【有意的
// 过度脱敏】（false positive 优于泄漏真实 token）。安全工具宁多脱敏勿少脱敏。
// H2: 原用 (\S+) 只匹配首个非空白词，含空格的密钥值（如 `client_secret: a b c`）
// 会泄漏空格后的部分。改用 [^\n\r]+ 匹配到行/记录尾，与 COOKIE/AUTH 一致。
const TOKEN_RE = /(\b[\w-]*token['"]?\s*[:=]\s*['"]?)([^\n\r]+)/gi;
// I22: password / passwd / pwd / secret / client_secret / apikey / api_key / passphrase
// 等凭据赋值（头、query、JSON）。与 token 同样宁多脱敏勿少脱敏。
// H2: 同上，(\S+) 改为 [^\n\r]+，避免多词密钥泄漏。
// `[\w-]*` 前缀与 TOKEN_RE 同法：`\b` 紧贴 alternation 时，`_` 属单词字符，
// `db_password` / `smtp_passwd` / `oauth_client_secret` 等下划线前缀键内无
// 词边界、全部失配泄漏（连字符前缀 `db-password` 则能命中）；前缀吸收后
// 无此盲区，原 alternation 中更具体的 client_secret 也由前缀覆盖，不再依赖
// 分支排序。
const SECRET_RE =
  /(\b[\w-]*(?:pass(?:word|wd|phrase)?|secret|api[_-]?key|apikey)['"]?\s*[:=]\s*['"]?)([^\n\r]+)/gi;
// PEM 块（私钥/证书）：单行正则的值捕获止于行尾，多行 base64 主体一行都
// 匹配不到——必须在逐行模式之前整体替换。
const PEM_KEY_RE =
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/g;
// CLI 风格空格分隔凭据（`--token abc`、`--password hunter2`）：上方键值正则
// 只认 `:`/`=` 分隔。不给 `--` 加 \b——前面是空白时并无词边界可用。
// `--password=abc` 的等号形态已由 SECRET_RE 覆盖。
const CLI_SECRET_RE = /(--(?:token|pass(?:word|wd)?|secret|api[_-]?key)\s+)(\S+)/gi;
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
  // 大小写不敏感 + 双分隔符容忍：Windows/macOS 文件系统大小写不敏感，日志中
  // `c:\users\name` / `C:/Users/name` / `C:\Users\name` 变体都会出现；先把
  // 分隔符归一为 `/` 再转义、最后展开为字符类，两种斜杠与任意大小写均命中。
  const homeRe =
    home.length > 1 && home !== '/'
      ? new RegExp(
          home
            .replace(/[\\/]/g, '/')
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\//g, '[\\/]'),
          'gi',
        )
      : null;
  return (input: string) => {
    let s = input;
    // PEM 块须先于逐行键值正则：后者的值捕获不跨行，base64 主体对它们不可见
    s = s.replace(PEM_KEY_RE, '[REDACTED_KEY]');
    s = s.replace(COOKIE_RE, '$1[REDACTED]');
    s = s.replace(AUTH_RE, '$1[REDACTED]');
    s = s.replace(TOKEN_RE, '$1[REDACTED]');
    s = s.replace(SECRET_RE, '$1[REDACTED]');
    s = s.replace(CLI_SECRET_RE, '$1[REDACTED]');
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
