import { describe, it, expect } from 'vitest';
import { renderBody, htmlToMarkdown } from '../src/body.js';
import { makeFullArticleItem, makeDegradedItem } from './helpers/fixtures.js';

describe('htmlToMarkdown (§13.6 turndown)', () => {
  it('converts basic HTML to Markdown', () => {
    expect(htmlToMarkdown('<p>hello <strong>world</strong></p>')).toContain(
      'hello **world**',
    );
  });
  it('converts GFM table', () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </table>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('|');
    expect(md).toContain('A');
    expect(md).toContain('---');
  });
  it('strips script tags', () => {
    const md = htmlToMarkdown('<p>x</p><script>alert(1)</script>');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('<script');
  });
  it('returns empty string for empty/whitespace input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('renderBody (§13.6 正文模板)', () => {
  const item = makeFullArticleItem();

  it('includes 来源信息 callout without H1 title', () => {
    const body = renderBody({
      item,
      markdownBody: '正文第一段。',
      assetLinks: [],
    });
    // 标题仅在 frontmatter 中保留，正文不再注入 H1 标头。
    expect(body).not.toContain('# 人工智能如何改变软件开发');
    expect(body).toContain('> [!info] 来源信息');
    expect(body).toContain('今日头条'); // source label
    expect(body).toContain('示例作者');
    expect(body).toContain('2025-12-20 10:35');
    expect(body).toContain('2026-01-04 21:13');
    expect(body).toContain('https://www.toutiao.com/article/7428193012345678901/');
  });

  it('includes rendered body without ## 正文 heading', () => {
    const body = renderBody({
      item,
      markdownBody: '正文第一段。',
      assetLinks: [],
    });
    expect(body).not.toContain('## 正文');
    expect(body).toContain('正文第一段。');
  });

  it('omits author/publish/favorite lines when not present', () => {
    const minimal = Object.assign({}, item, {
      author: undefined,
      publishedAt: undefined,
      favoritedAt: undefined,
    });
    const { author, publishedAt, favoritedAt, ...rest } = minimal;
    void author;
    void publishedAt;
    void favoritedAt;
    const body = renderBody({
      item: rest,
      markdownBody: 'x',
      assetLinks: [],
    });
    expect(body).not.toContain('作者');
    expect(body).not.toContain('发布时间');
    expect(body).not.toContain('收藏时间');
  });

  it('does not include 迁移说明 callout', () => {
    const body = renderBody({
      item,
      markdownBody: 'x',
      assetLinks: [],
    });
    expect(body).not.toContain('迁移说明');
  });

  it('renders wikilink-style asset embeds when linkStyle=wikilink', () => {
    const body = renderBody({
      item,
      markdownBody: '{{ASSET_0}}',
      assetLinks: [
        {
          markdownPlaceholder: '{{ASSET_0}}',
          relativePath: 'Attachments/InkMigrate/toutiao-main/im-x/cover.webp',
        },
      ],
      linkStyle: 'wikilink',
    });
    expect(body).toContain(
      '![[Attachments/InkMigrate/toutiao-main/im-x/cover.webp]]',
    );
  });

  it('renders markdown-style asset embeds when linkStyle=markdown', () => {
    const body = renderBody({
      item,
      markdownBody: '{{ASSET_0}}',
      assetLinks: [{ markdownPlaceholder: '{{ASSET_0}}', relativePath: 'a/b.webp' }],
      linkStyle: 'markdown',
    });
    expect(body).toContain('![](a/b.webp)');
  });

  it('renders degraded item with source info but no H1 title and empty body', () => {
    const degraded = makeDegradedItem();
    const body = renderBody({
      item: degraded,
      markdownBody: '',
      assetLinks: [],
    });
    // 标题仅在 frontmatter 中，正文不注入 H1。
    expect(body).not.toContain('# 人工智能如何改变软件开发');
    expect(body).toContain('来源信息');
  });
});
