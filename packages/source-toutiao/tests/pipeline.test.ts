import { describe, it, expect } from 'vitest';
import { runSafetyPipeline } from '../src/pipeline/pipeline.js';

describe('runSafetyPipeline (§12.9 fixed 9-stage)', () => {
  it('strips <script> in pre-clean', () => {
    const out = runSafetyPipeline('<p>x</p><script>alert(1)</script>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.html).not.toContain('<script');
    expect(out.html).not.toContain('alert');
  });

  it('strips on* event handler attributes', () => {
    const out = runSafetyPipeline('<p onclick="evil()">x</p>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.html).not.toMatch(/on\w+\s*=/i);
  });

  it('strips iframe/object/embed', () => {
    const out = runSafetyPipeline(
      '<p>x</p><iframe src="evil"></iframe><object data="x"></object><embed src="y">',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.html).not.toContain('<iframe');
    expect(out.html).not.toContain('<object');
    expect(out.html).not.toContain('<embed');
  });

  it('strips javascript: URIs', () => {
    const out = runSafetyPipeline('<a href="javascript:evil">x</a>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.html.toLowerCase()).not.toContain('javascript:');
  });

  it('converts relative URLs to absolute (§12.9 stage 6)', () => {
    const out = runSafetyPipeline(
      '<a href="/article/2/">link</a><img src="img/x.webp">',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.html).toContain('https://www.toutiao.com/article/2/');
    expect(out.html).toContain('https://www.toutiao.com/article/1/img/x.webp');
  });

  it('resolves lazy-load attributes (data-src, data-original)', () => {
    const out = runSafetyPipeline(
      '<img data-src="lazy.webp" data-original="orig.jpg">',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.lazyLoadImages.length).toBeGreaterThan(0);
    // I-B: data-original 优先级最高（高清原图），高于 data-src。
    // 此前 srcset 先解析、data-* 后覆盖会颠倒优先级；现 data-original 胜出。
    expect(out.lazyLoadImages).toContain(
      'https://www.toutiao.com/article/1/orig.jpg',
    );
  });

  it('produces Markdown via turndown', () => {
    const out = runSafetyPipeline('<p>hello <strong>world</strong></p>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.markdown).toContain('hello **world**');
  });

  it('post-clean strips residual raw HTML in markdown', () => {
    const out = runSafetyPipeline('<p>x</p>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
      injectForPostCleanTest: '<script>alert(1)</script>',
    });
    expect(out.markdown).not.toContain('<script');
  });

  it('post-clean strips dangerous URL schemes in markdown links', () => {
    const out = runSafetyPipeline('<a href="javascript:evil">x</a>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.markdown.toLowerCase()).not.toContain('javascript:');
  });

  it('post-clean strips invisible control characters', () => {
    const out = runSafetyPipeline('<p>he\u0000llo\u0001</p>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.markdown).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  });

  it('collapses consecutive blank lines to max 2', () => {
    const out = runSafetyPipeline('<p>a</p><p>b</p><p>c</p>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.markdown).not.toMatch(/\n{3,}/);
  });

  it('returns quality=degraded with empty markdown for empty/whitespace input', () => {
    const out = runSafetyPipeline('   ', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.quality).toBe('degraded');
    expect(out.degradations.some((d) => d.code === 'body-missing')).toBe(true);
    expect(out.markdown).toBe('');
  });

  it('removes script content (jsdom runScripts: outside-only)', () => {
    const out = runSafetyPipeline(
      '<p>x</p><script>window.__pwned = true;</script>',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.html).not.toContain('__pwned');
  });

  it('strips vbscript: URIs', () => {
    const out = runSafetyPipeline('<a href="vbscript:evil">x</a>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.html.toLowerCase()).not.toContain('vbscript:');
  });

  it('strips data: URIs (uncontrolled)', () => {
    const out = runSafetyPipeline(
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.html.toLowerCase()).not.toMatch(/data:text\/html/);
  });

  it('strips file: URIs', () => {
    const out = runSafetyPipeline('<a href="file:///etc/passwd">x</a>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.html.toLowerCase()).not.toContain('file:');
  });

  it('strips <form>/<input>/<button> (FORBID_TAGS)', () => {
    const out = runSafetyPipeline(
      '<p>x</p><form><input><button>go</button></form>',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.html).not.toContain('<form');
    expect(out.html).not.toContain('<input');
    expect(out.html).not.toContain('<button');
  });

  it('resolves srcset first candidate to src (§12.9 stage 6)', () => {
    const out = runSafetyPipeline(
      '<img srcset="big.webp 2x, small.webp 1x">',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.images).toContain(
      'https://www.toutiao.com/article/1/big.webp',
    );
  });

  it('folds abnormally nested links to inner link (§12.9 stage 8 异常嵌套链接)', () => {
    const out = runSafetyPipeline(
      '<p>[outer [inner](https://inner.example/)](https://outer.example/)</p>',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    // 嵌套链接折叠后应保留内层链接
    expect(out.markdown).toContain('https://inner.example/');
    // 不应保留为畸形双层链接
    expect(out.markdown).not.toMatch(/\]\(https:\/\/outer\.example\/\]\(/);
  });

  it('§13.6 decodes &quot; leaked from attribute values into markdown', () => {
    // HTML 经多次 innerHTML 序列化后，title/alt 属性值里的 " 被重编码为 &quot;。
    // 链接 title 属性会被 turndown 输出为 [text](url "title")，未经解码时
    // 会字面泄漏 &quot; 到 markdown。解码后 turndown 按 Markdown 规范把 title 内
    // 的 " 转义为 \"（这是正确行为），关键是 &quot; 不再字面出现。
    const out = runSafetyPipeline(
      '<a href="https://example.com/" title="Tom &quot;Jerry&quot;">link</a>',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.markdown).not.toContain('&quot;');
    // 解码后的 " 被 turndown 转义为 \" 放进链接 title，证明已从 &quot; 还原
    expect(out.markdown).toContain('\\"Jerry\\"');
  });

  it('§13.6 decodes &quot; in img alt text', () => {
    const out = runSafetyPipeline(
      '<img src="x.webp" alt="a&quot;b">',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.markdown).not.toContain('&quot;');
  });

  it('§13.6 decodes &amp; in body text', () => {
    const out = runSafetyPipeline('<p>Tom &amp; Jerry</p>', {
      baseUrl: 'https://www.toutiao.com/article/1/',
    });
    expect(out.markdown).toContain('Tom & Jerry');
    expect(out.markdown).not.toContain('&amp;');
  });

  it('preserves code blocks through post-clean (regression: placeholder boundary bug)', () => {
    // 此前代码块占位符用 \x00 作边界，被 CONTROL_CHARS 正则吞掉，还原失配后
    // 代码块内容变成字面量 "CODE0"。改用私有区码点 U+E000/E001 后修复。
    const out = runSafetyPipeline(
      '<p>intro</p><pre><code class="language-js">const x = 1;</code></pre><p>inline <code>List&lt;String&gt;</code> here</p>',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.markdown).toContain('const x = 1');
    expect(out.markdown).toContain('List<String>');
    // 不应出现未还原的占位字面量
    expect(out.markdown).not.toMatch(/CODE\d+/);
  });

  it('preserves code blocks when input also contains control chars', () => {
    // 控制字符必须被移除，但代码块占位符边界(U+E000/E001)不被误删。
    const out = runSafetyPipeline(
      '<p>bad\u0001char</p><pre><code>line1\nline2</code></pre>',
      { baseUrl: 'https://www.toutiao.com/article/1/' },
    );
    expect(out.markdown).not.toContain('\u0001');
    expect(out.markdown).toContain('line1');
    expect(out.markdown).toContain('line2');
    expect(out.markdown).not.toMatch(/CODE\d+/);
  });
});