// 生成 tests/fixtures/evernote/ 下的确定性 ENEX fixture（PRD §24.4：人工构造，非真实数据）。
// 资源字节与 en-media hash 由脚本计算，保证 MD5 一致性可被解析器验证。
// 修改后运行：pnpm gen:fixtures
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'tests', 'fixtures', 'evernote');
mkdirSync(OUT, { recursive: true });

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const b64 = (buf) => Buffer.from(buf).toString('base64');

// 1x1 PNG（红）与 1x1 PNG（蓝）：两个不同字节的图片资源。
const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_MIN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

/** 按 76 字符折行（模拟真实导出的 Base64 空白，解析器必须容忍）。 */
function wrapped(b64Text) {
  return b64Text.replace(/(.{76})/g, '$1\n');
}

function enex(notes) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">
<en-export export-date="20260901T000000Z" application="Evernote" version="10.0">
${notes.join('\n')}
</en-export>
`;
}

function resource({ bytes, mime, fileName, attachment }) {
  const attrs = [];
  if (fileName !== undefined) attrs.push(`      <file-name>${fileName}</file-name>`);
  if (attachment !== undefined) attrs.push(`      <attachment>${attachment}</attachment>`);
  const attrBlock =
    attrs.length > 0 ? `\n    <resource-attributes>\n${attrs.join('\n')}\n    </resource-attributes>` : '';
  return `  <resource>
    <data encoding="base64">${wrapped(b64(bytes))}</data>
    <mime>${mime}</mime>${attrBlock}
  </resource>`;
}

function note({ title, content, created, updated, tags = [], attrs = {}, resources = [] }) {
  const parts = [`    <title>${title}</title>`];
  parts.push(`    <content><![CDATA[${content}]]></content>`);
  if (created) parts.push(`    <created>${created}</created>`);
  if (updated) parts.push(`    <updated>${updated}</updated>`);
  for (const t of tags) parts.push(`    <tag>${t}</tag>`);
  const attrEntries = Object.entries(attrs);
  if (attrEntries.length > 0) {
    parts.push('    <note-attributes>');
    for (const [k, v] of attrEntries) parts.push(`      <${k}>${v}</${k}>`);
    parts.push('    </note-attributes>');
  }
  parts.push(...resources);
  return `  <note>\n${parts.join('\n')}\n  </note>`;
}

const ENML_HEAD =
  '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">\n<en-note>';
const enml = (inner) => `${ENML_HEAD}${inner}</en-note>`;

// ─── basic.enex：两条无资源笔记，元数据/标签/外链 ───
writeFileSync(
  join(OUT, 'basic.enex'),
  enex([
    note({
      title: '第一条笔记',
      created: '20190503T082000Z',
      updated: '20251112T164500Z',
      tags: ['阅读', '项目/子项'],
      attrs: {
        author: '张三',
        'source-url': 'https://example.com/original',
        source: 'web.clip',
      },
      content: enml(
        '<div>正文第一段。</div><h1>小标题</h1><div><a href="https://example.com/link">外部链接</a></div>',
      ),
    }),
    note({
      title: 'Second Note',
      created: '20200815T101010Z',
      content: enml('<div>table row</div><table><tr><td>a</td><td>b</td></tr></table>'),
    }),
  ]),
);

// ─── Work@@@Projects.enex：文件名 Stack@@@Notebook 推断 + en-todo ───
writeFileSync(
  join(OUT, 'Work@@@Projects.enex'),
  enex([
    note({
      title: '项目会议纪要',
      created: '20240115T083000Z',
      updated: '20240601T120000Z',
      tags: ['工作'],
      content: enml(
        '<div>待办事项：</div><div><en-todo checked="true"/>已完成任务</div><div><en-todo/>未完成任务</div>',
      ),
    }),
  ]),
);

// ─── resources-named.enex：命名资源 + en-media + en-crypt + 内链 + 同名冲突 ───
const HASH_RED = md5(PNG_RED);
writeFileSync(
  join(OUT, 'resources-named.enex'),
  enex([
    note({
      title: '带附件的笔记',
      created: '20210601T090000Z',
      tags: ['附件'],
      content: enml(
        `<div>截图如下：</div>` +
          `<en-media type="image/png" hash="${HASH_RED}" alt="截图"/>` +
          `<div><a href="https://example.com/x">外链</a> <a href="evernote:///view/999/s1/11111111-2222-3333-4444-555555555555/11111111-2222-3333-4444-555555555555/">相关笔记</a></div>` +
          `<div><en-crypt hint="银行密码" cipher="RC2" length="64">YWJjZGVmZ2hpamtsbW5vcA==</en-crypt></div>`,
      ),
      resources: [
        resource({ bytes: PNG_RED, mime: 'image/png', fileName: '截图.png', attachment: false }),
        resource({ bytes: PDF_MIN, mime: 'application/pdf', fileName: '报告.pdf', attachment: true }),
        // 与第一个资源同名（不同字节）：触发 -<sha256前8位> 冲突后缀，且未被正文引用。
        resource({ bytes: PNG_BLUE, mime: 'image/png', fileName: '截图.png', attachment: false }),
      ],
    }),
  ]),
);

// ─── resources-unnamed.enex：无 file-name → 序号命名 ───
const HASH_BLUE = md5(PNG_BLUE);
writeFileSync(
  join(OUT, 'resources-unnamed.enex'),
  enex([
    note({
      title: '未命名资源的笔记',
      created: '20220301T100000Z',
      content: enml(
        `<div>两张图：</div><en-media type="image/png" hash="${HASH_RED}"/><en-media type="image/png" hash="${HASH_BLUE}"/>`,
      ),
      resources: [
        resource({ bytes: PNG_RED, mime: 'image/png' }),
        resource({ bytes: PNG_BLUE, mime: 'image/png' }),
      ],
    }),
  ]),
);

// ─── resource-hash-mismatch.enex：en-media hash 无匹配 + 未引用资源 ───
writeFileSync(
  join(OUT, 'resource-hash-mismatch.enex'),
  enex([
    note({
      title: '哈希不匹配的笔记',
      created: '20230101T000000Z',
      content: enml(
        `<div>占位：</div><en-media type="image/png" hash="0000000000000000000000000000dead"/>`,
      ),
      resources: [resource({ bytes: PNG_RED, mime: 'image/png', fileName: '孤儿.png' })],
    }),
  ]),
);

// ─── remote-images.enex：正文远程 <img>（网页剪藏常见）───
writeFileSync(
  join(OUT, 'remote-images.enex'),
  enex([
    note({
      title: '剪藏笔记',
      created: '20241201T120000Z',
      attrs: { source: 'web.clip', 'source-url': 'https://example.com/clipped' },
      content: enml(
        `<div>剪藏正文。</div><img src="https://example.invalid/remote.png" alt="远程图"/>`,
      ),
    }),
  ]),
);

// ─── malformed.enex：第 1 条完好，第 2 条 XML 损坏（title 未闭合）───
writeFileSync(
  join(OUT, 'malformed.enex'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">
<en-export export-date="20260901T000000Z" application="Evernote" version="10.0">
  <note>
    <title>完好的笔记</title>
    <content><![CDATA[<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>ok</div></en-note>]]></content>
    <created>20200101T000000Z</created>
  </note>
  <note>
    <title>损坏的笔记
    <content><![CDATA[<en-note><div>broken</div></en-note>]]></content>
  </note>
</en-export>
`,
);

// ─── yinxiang-export.notes：印象笔记专有加密格式构造样本（用于拒绝测试）───
writeFileSync(join(OUT, 'yinxiang-export.notes'), '构造样本（非真实数据）：印象笔记 base64:aes 加密导出\n');

console.log(`fixtures written to ${OUT}`);
