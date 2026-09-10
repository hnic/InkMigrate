import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { createRedactor } from './redactor.js';

describe('redactor (§19.2)', () => {
  const r = createRedactor();

  it('redacts Cookie header values', () => {
    expect(r('cookie: sessionid=abc123')).toBe('cookie: [REDACTED]');
    expect(r('Cookie: sessionid=abc123; foo=bar')).toBe('Cookie: [REDACTED]');
    expect(r('cookie=sessionid=abc123')).toBe('cookie=[REDACTED]');
  });

  it('redacts Authorization header values', () => {
    expect(r('authorization: Bearer xyz')).toBe('authorization: [REDACTED]');
    expect(r('Authorization=Token abc')).toBe('Authorization=[REDACTED]');
  });

  it('redacts token= values', () => {
    expect(r('csrf_token=abcdef')).toBe('csrf_token=[REDACTED]');
  });

  it('redacts Chinese verification codes', () => {
    expect(r('验证码: 123456')).toBe('验证码: [REDACTED]');
    expect(r('验证码 654321')).toBe('验证码 [REDACTED]');
  });

  it('redacts English verification codes', () => {
    expect(r('verification code: 1234')).toBe('verification code: [REDACTED]');
    expect(r('OTP=987654')).toBe('OTP=[REDACTED]');
  });

  it('redacts Chinese phone numbers (11 digits starting with 1[3-9])', () => {
    expect(r('联系 13800138000')).toBe('联系 [REDACTED_PHONE]');
    expect(r('电话：15912345678')).toBe('电话：[REDACTED_PHONE]');
  });

  it('does not redact arbitrary 11-digit numbers that are not phone-shaped', () => {
    expect(r('id=00000000000')).toBe('id=00000000000');
  });

  it('regression: 词边界防止腐蚀日志里的合法长数字串', () => {
    // 此前 PHONE_RE 无词边界，会匹配任何含 11 位连续数字子串的中间 11 位，
    // 腐蚀日志里的订单号、时间戳、字节大小等合法业务数据，影响诊断。
    expect(r('订单号 12345678901234')).toBe('订单号 12345678901234'); // 14 位
    expect(r('ts:1715000000000')).toBe('ts:1715000000000'); // 13 位时间戳
    expect(r('id:123456789012345')).toBe('id:123456789012345'); // 15 位
    // 恰好 11 位且前后非数字的仍正确脱敏
    expect(r('手机 13800138000 已记录')).toBe('手机 [REDACTED_PHONE] 已记录');
  });

  it('redacts emails', () => {
    expect(r('mail me a@b.com')).toBe('mail me [REDACTED_EMAIL]');
    expect(r('from john.doe@example.co.uk')).toBe(
      'from [REDACTED_EMAIL]',
    );
  });

  it('redacts local user home directory paths', () => {
    // 使用运行时 homedir() 构造测试输入，避免硬编码本机绝对路径导致跨机器失败
    const samplePath = `${homedir()}/secret/file`;
    expect(r(samplePath)).not.toContain(homedir());
    expect(r(samplePath)).toContain('[HOME]');
  });

  it('passes through innocuous content', () => {
    expect(r('hello world, the article is fine')).toBe(
      'hello world, the article is fine',
    );
  });

  it('handles multiple matches in one string', () => {
    const out = r('user a@b.com phone 13800138000 cookie=x');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain('13800138000');
    expect(out).not.toContain('=x');
  });

  it('redacts Set-Cookie response header (I22: \\bcookie\\b 不匹配 Set-Cookie)', () => {
    expect(r('Set-Cookie: sid=abc123; Path=/')).toBe('Set-Cookie: [REDACTED]');
  });

  it('redacts password / secret / apikey assignments (I22)', () => {
    expect(r('password=hunter2')).toBe('password=[REDACTED]');
    expect(r('api_key=sk_test_123')).toBe('api_key=[REDACTED]');
    expect(r('apikey=sk_test_123')).toBe('apikey=[REDACTED]');
    expect(r('client_secret=abc')).toBe('client_secret=[REDACTED]');
    // header / env 形式（key 后直接跟 : 或 =）
    expect(r('X-Secret: shh')).toBe('X-Secret: [REDACTED]');
  });

  it('redacts favorites-page session token embedded in URL (C11)', () => {
    const out = r('已获取收藏页 URL: https://www.toutiao.com/c/user/token/ABCDEF123456?tab=fav');
    expect(out).not.toContain('ABCDEF123456');
    expect(out).toContain('<redacted>');
    // URL 结构其余部分保留，便于诊断
    expect(out).toContain('toutiao.com/c/user/token/');
  });

  it('H2: redacts multi-word secret values containing whitespace', () => {
    // 原 (\S+) 只匹配首个非空白词，含空格的密钥泄漏空格后的部分。
    expect(r('client_secret: the quick brown')).toBe('client_secret: [REDACTED]');
    expect(r('password=hunter2 correct horse')).toBe('password=[REDACTED]');
    expect(r('api_key: sk_test_123 extra bits')).toBe('api_key: [REDACTED]');
  });

  it('H2: redacts multi-word token values containing whitespace', () => {
    expect(r('access_token: abc def ghi')).toBe('access_token: [REDACTED]');
  });

  it('#358: JSON 引号键形态的凭据也脱敏（字符串化 JSON 是错误消息的常见形态）', () => {
    expect(r('{"access_token": "abc"}')).not.toContain('abc');
    expect(r('{"client_secret":"xyz"}')).not.toContain('xyz');
    expect(r('{"cookie": "sid=1"}')).not.toContain('sid=1');
    expect(r('{"authorization":"Bearer t0k"}')).not.toContain('t0k');
  });

  it('#359: 下划线前缀的凭据键脱敏（\\b 不覆盖 _ 前缀）', () => {
    expect(r('db_password=hunter2')).toBe('db_password=[REDACTED]');
    expect(r('smtp_passwd: pw')).toBe('smtp_passwd: [REDACTED]');
    expect(r('oauth_client_secret=cs')).toBe('oauth_client_secret=[REDACTED]');
    // 连字符前缀（原本可命中）不回归
    expect(r('db-password=hunter2')).toBe('db-password=[REDACTED]');
  });

  it('#360: PEM 私钥/证书块整体脱敏（逐行键值正则看不到多行 base64 主体）', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAabcd1234 multiline',
      'secondbase64line',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = r(pem);
    expect(out).not.toContain('MIIEpA');
    expect(out).not.toContain('secondbase64line');
    expect(out).toContain('[REDACTED_KEY]');
  });

  it('#361: CLI 空格分隔凭据脱敏（--token abc / --password hunter2）', () => {
    expect(r('--token abc123')).not.toContain('abc123');
    expect(r('--password hunter2')).not.toContain('hunter2');
    expect(r('spawn --secret s3cret done')).not.toContain('s3cret');
    // 等号形态由 SECRET_RE 覆盖，不回归
    expect(r('--password=hunter2')).not.toContain('hunter2');
  });
});
