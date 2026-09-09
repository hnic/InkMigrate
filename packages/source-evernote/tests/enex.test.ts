import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectEnexFiles,
  EvernoteNotesRejectedError,
  resolveInputPaths,
  splitStackNotebook,
} from '../src/enex/scan.js';
import { enexTimeToIso, streamNotes } from '../src/enex/sax-notes.js';
import { buildNoteIdentity } from '../src/enex/identity.js';
import { EvernoteSourceConfigSchema } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(__dirname, 'fixtures', 'evernote');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'inkmigrate-evernote-test-'));
}

describe('splitStackNotebook（§15.5）', () => {
  it('用分隔符拆出 Stack 与笔记本', () => {
    expect(splitStackNotebook('Work@@@Projects', '@@@')).toEqual({
      stack: 'Work',
      notebook: 'Projects',
    });
  });
  it('无分隔符时整体作为笔记本', () => {
    expect(splitStackNotebook('我的笔记本', '@@@')).toEqual({ notebook: '我的笔记本' });
  });
  it('分隔符在开头或结尾时回退整体命名', () => {
    expect(splitStackNotebook('@@@Projects', '@@@')).toEqual({ notebook: '@@@Projects' });
    expect(splitStackNotebook('Projects@@@', '@@@')).toEqual({ notebook: 'Projects@@@' });
  });
});

describe('enexTimeToIso（§15.8）', () => {
  it('转换 yyyymmddThhmmssZ 为 ISO 8601', () => {
    expect(enexTimeToIso('20190503T082000Z')).toBe('2019-05-03T08:20:00Z');
  });
  it('非法输入返回 undefined', () => {
    expect(enexTimeToIso('not-a-time')).toBeUndefined();
    expect(enexTimeToIso('20190503T082000')).toBeUndefined();
    expect(enexTimeToIso(undefined)).toBeUndefined();
  });
});

describe('collectEnexFiles（§15.2/§15.2.1）', () => {
  it('递归收集 .enex 并推断笔记本/Stack/notebookKey', async () => {
    // 拷贝干净输入（fixture 目录含 yinxiang-export.notes 会被显式拒绝）
    const dir = tmp();
    try {
      for (const f of [
        'basic.enex',
        'Work@@@Projects.enex',
        'resources-named.enex',
        'resources-unnamed.enex',
      ]) {
        copyFileSync(join(FIXTURES, f), join(dir, f));
      }
      mkdirSync(join(dir, 'sub'), { recursive: true });
      copyFileSync(join(FIXTURES, 'remote-images.enex'), join(dir, 'sub', 'remote-images.enex'));
      writeFileSync(join(dir, 'readme.txt'), 'not enex');

      const { files, skipped } = await collectEnexFiles([dir], '@@@');
      const names = files.map((f) => f.baseName).sort();
      expect(names).toEqual([
        'Work@@@Projects',
        'basic',
        'remote-images',
        'resources-named',
        'resources-unnamed',
      ]);
      const work = files.find((f) => f.baseName === 'Work@@@Projects');
      expect(work?.stack).toBe('Work');
      expect(work?.notebook).toBe('Projects');
      expect(work?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(work?.notebookKey).toMatch(/^[0-9a-f]{64}$/);
      expect(skipped.join('\n')).toContain('readme.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('出现 .notes 输入时显式失败，错误含三条替代指引（§15.2.1）', async () => {
    const dir = tmp();
    try {
      copyFileSync(join(FIXTURES, 'basic.enex'), join(dir, 'basic.enex'));
      copyFileSync(
        join(FIXTURES, 'yinxiang-export.notes'),
        join(dir, 'yinxiang-export.notes'),
      );
      await expect(collectEnexFiles([dir], '@@@')).rejects.toBeInstanceOf(
        EvernoteNotesRejectedError,
      );
      try {
        await collectEnexFiles([dir], '@@@');
        expect.unreachable();
      } catch (e) {
        const msg = (e as EvernoteNotesRejectedError).message;
        expect(msg).toContain('evernote-backup');
        expect(msg).toContain('HTML');
        expect((e as EvernoteNotesRejectedError).files).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跳过符号链接（防路径逃逸）', async () => {
    const dir = tmp();
    try {
      copyFileSync(join(FIXTURES, 'basic.enex'), join(dir, 'basic.enex'));
      // symlink 指向另一个 enex —— 不跟随
      const { realpathSync } = await import('node:fs');
      writeFileSync(join(dir, 'decoy.txt'), 'x');
      try {
        await import('node:fs').then((fs) =>
          (fs as typeof fs).symlinkSync(realpathSync(join(FIXTURES, 'basic.enex')), join(dir, 'link.enex')),
        );
      } catch {
        // 平台不支持 symlink 时跳过本用例
        return;
      }
      const { files } = await collectEnexFiles([dir], '@@@');
      expect(files.map((f) => f.baseName)).toEqual(['basic']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('streamNotes（§15.3）', () => {
  it('headerOnly 模式产出标题索引', async () => {
    const notes: Array<{ ordinal: number; title: string }> = [];
    const outcome = await streamNotes(join(FIXTURES, 'basic.enex'), {
      headerOnly: true,
      onNote: (n) => notes.push({ ordinal: n.ordinal, title: n.title }),
    });
    expect(outcome.error).toBeUndefined();
    expect(notes).toEqual([
      { ordinal: 1, title: '第一条笔记' },
      { ordinal: 2, title: 'Second Note' },
    ]);
  });

  it('全量模式解析 content/tags/note-attributes/resources', async () => {
    let note: import('../src/enex/sax-notes.js').RawNote | undefined;
    await streamNotes(join(FIXTURES, 'resources-named.enex'), {
      stopAfterOrdinal: 1,
      onNote: (n) => {
        note = n;
      },
    });
    expect(note).toBeDefined();
    expect(note!.title).toBe('带附件的笔记');
    expect(note!.created).toBe('20210601T090000Z');
    expect(note!.tags).toEqual(['附件']);
    expect(note!.content).toContain('<en-note>');
    expect(note!.content).toContain('en-media');
    expect(note!.resources).toHaveLength(3);
    expect(note!.resources[0]!.fileName).toBe('截图.png');
    expect(note!.resources[0]!.attachment).toBe('false');
    expect(note!.resources[1]!.mime).toBe('application/pdf');
    // base64 文本含折行空白，解码由资源管线处理
    expect(note!.resources[0]!.dataBase64).toMatch(/\n/);
  });

  it('malformed：损坏笔记被隔离跳过并记录 issue（§15.3 损坏隔离）', async () => {
    const titles: string[] = [];
    const issues: string[] = [];
    const outcome = await streamNotes(join(FIXTURES, 'malformed.enex'), {
      headerOnly: true,
      onNote: (n) => titles.push(n.title),
      onIssue: (m) => issues.push(m),
    });
    expect(titles).toEqual(['完好的笔记']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('结构损坏');
    expect(outcome.error).toBeUndefined();
  });

  it('非 ENEX 文件报根元素错误', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'fake.enex'), '<?xml version="1.0"?><root><a/></root>');
      const outcome = await streamNotes(join(dir, 'fake.enex'), {
        headerOnly: true,
        onNote: () => undefined,
      });
      expect(outcome.error?.message).toContain('not an ENEX file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildNoteIdentity（§15.4）', () => {
  it('默认身份 = file#ordinal，指纹随序号/标题/文件哈希变化', () => {
    const a = buildNoteIdentity({
      fileSha256: 'a'.repeat(64),
      ordinal: 1,
      title: 'T',
      createdIso: '2020-01-01T00:00:00Z',
      fileBaseName: 'nb',
    });
    expect(a.externalId).toBe('enex:nb#1');
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const b = buildNoteIdentity({
      fileSha256: 'a'.repeat(64),
      ordinal: 2,
      title: 'T',
      createdIso: '2020-01-01T00:00:00Z',
      fileBaseName: 'nb',
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('App Link 优先作为 externalId', () => {
    const a = buildNoteIdentity({
      fileSha256: 'a'.repeat(64),
      ordinal: 1,
      title: 'T',
      appLink: 'evernote:///view/1/s1/g/g/',
      fileBaseName: 'nb',
    });
    expect(a.externalId).toBe('evernote-link:evernote:///view/1/s1/g/g/');
  });
});

describe('EvernoteSourceConfigSchema（§15.1）', () => {
  it('必填字段齐全时通过并填充默认值', () => {
    const cfg = EvernoteSourceConfigSchema.parse({
      sourceInstanceId: 'evernote-archive',
      inputPaths: ['imports/evernote'],
    });
    expect(cfg.formats).toEqual(['enex']);
    expect(cfg.stackSeparator).toBe('@@@');
    expect(cfg.assets.maxResourceBytes).toBe(25 * 1024 * 1024);
    expect(cfg.assets.downloadImages).toBe(false);
  });

  it('formats 接受 enex 与 html，拒绝未知格式', () => {
    expect(
      EvernoteSourceConfigSchema.safeParse({
        sourceInstanceId: 'x',
        inputPaths: ['a'],
        formats: ['enex', 'html'],
      }).success,
    ).toBe(true);
    const r = EvernoteSourceConfigSchema.safeParse({
      sourceInstanceId: 'x',
      inputPaths: ['a'],
      formats: ['pdf'],
    });
    expect(r.success).toBe(false);
  });

  it('未知字段被拒绝（strict）', () => {
    expect(
      EvernoteSourceConfigSchema.safeParse({
        sourceInstanceId: 'x',
        inputPaths: ['a'],
        oops: 1,
      }).success,
    ).toBe(false);
  });
});

describe('resolveInputPaths', () => {
  it('相对路径锚定 workspaceDir', () => {
    expect(resolveInputPaths(['imports/evernote'], '/w')).toEqual([
      '/w/imports/evernote',
    ]);
    expect(resolveInputPaths(['/abs'], '/w')).toEqual(['/abs']);
  });
});

describe('mkdir fixture 环境', () => {
  it('fixture 目录可访问', () => {
    mkdirSync(FIXTURES, { recursive: true });
    expect(FIXTURES.length).toBeGreaterThan(0);
  });
});

describe('notebookMappings（§15.5 用户映射覆盖）', () => {
  function dir2(): string {
    const d = tmp();
    copyFileSync(join(FIXTURES, 'basic.enex'), join(d, 'basic.enex'));
    copyFileSync(join(FIXTURES, 'Work@@@Projects.enex'), join(d, 'Work@@@Projects.enex'));
    return d;
  }

  it('覆盖文件名推断的 stack/notebook', async () => {
    const d = dir2();
    try {
      const { files } = await collectEnexFiles([d], '@@@', {
        notebookMappings: {
          basic: { stack: '自定义栈', notebook: '重命名笔记本', mergeKey: null },
        },
      });
      const basic = files.find((f) => f.baseName === 'basic')!;
      expect(basic.stack).toBe('自定义栈');
      expect(basic.notebook).toBe('重命名笔记本');
      // notebookKey 随映射后的名称派生（与未映射时不同）
      const unmapped = await collectEnexFiles([d], '@@@');
      expect(basic.notebookKey).not.toBe(
        unmapped.files.find((f) => f.baseName === 'basic')!.notebookKey,
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('mergeKey 相同且笔记本名一致的文件共享 notebookKey（合并目录）', async () => {
    const d = dir2();
    try {
      const { files } = await collectEnexFiles([d], '@@@', {
        notebookMappings: {
          basic: { notebook: '合并笔记本', mergeKey: 'merged' },
          'Work@@@Projects': { notebook: '合并笔记本', stack: null, mergeKey: 'merged' },
        },
      });
      const keys = files.map((f) => f.notebookKey);
      expect(keys[0]).toBe(keys[1]);
      expect(files.every((f) => f.notebook === '合并笔记本')).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('mergeKey 组内笔记本名不一致时显式校验失败', async () => {
    const d = dir2();
    try {
      await expect(
        collectEnexFiles([d], '@@@', {
          notebookMappings: {
            basic: { notebook: 'A', mergeKey: 'm' },
            'Work@@@Projects': { notebook: 'B', mergeKey: 'm' },
          },
        }),
      ).rejects.toThrow(/mergeKey.*不一致/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('映射键未命中与无 Stack 均产生警告（进报告）', async () => {
    const d = dir2();
    try {
      const { warnings } = await collectEnexFiles([d], '@@@', {
        notebookMappings: { '不存在的文件': { notebook: 'X', mergeKey: null } },
      });
      expect(warnings.join('\n')).toContain('未匹配任何输入文件');
      // basic.enex 无 Stack 且无映射 → 提示无法自动还原（Work@@@Projects 有分隔符不提示）
      expect(warnings.join('\n')).toContain('basic.enex：无 Stack 信息');
      expect(warnings.join('\n')).not.toContain('Work@@@Projects.enex：无 Stack');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('streamNotes 游标续读（§15.3 大文件顺序提取）', () => {
  it('从游标续读与从头读取产出一致，游标正确推进', async () => {
    const path = join(FIXTURES, 'basic.enex');
    // 全量基线
    const all: RawNote[] = [];
    await streamNotes(path, { onNote: (n) => all.push(n) });
    expect(all).toHaveLength(2);

    // 顺序提取：先 #1，再从游标续读 #2
    const cursorOut = await streamNotes(path, {
      stopAfterOrdinal: 1,
      onNote: (n) => {
        expect(n.ordinal).toBe(1);
      },
    });
    const cursor = cursorOut.cursor!;
    // 小文件单块即完：游标保守停在块前边界（ordinal 可能仍为 0）——续读正确性为准
    expect(typeof cursor.offset).toBe('number');

    const second: RawNote[] = [];
    const out2 = await streamNotes(path, {
      startOffset: cursor.offset,
      ordinalBase: cursor.ordinal,
      stopAfterOrdinal: 2,
      onNote: (n) => second.push(n),
    });
    // 续读窗口可含重叠块内的前序笔记（调用方按 ordinal 过滤）；目标笔记必须在内且序号绝对
    expect(second.map((n) => n.title)).toContain(all[1]!.title);
    expect(second.find((n) => n.title === all[1]!.title)!.ordinal).toBe(2);
    expect(out2.cursor!.ordinal).toBeGreaterThanOrEqual(cursor.ordinal);
  });

  it('乱序回退：目标序号小于游标时从 0 重读仍正确（由调用方回退，startOffset 语义自洽）', async () => {
    const path = join(FIXTURES, 'interlinks.enex');
    const all: RawNote[] = [];
    await streamNotes(path, { onNote: (n) => all.push(n) });
    expect(all).toHaveLength(2);
    // 从 0 基数重读 #1（模拟回退路径）
    const first: RawNote[] = [];
    await streamNotes(path, {
      startOffset: 0,
      ordinalBase: 0,
      stopAfterOrdinal: 1,
      onNote: (n) => first.push(n),
    });
    expect(first[0]!.guid).toBe(all[0]!.guid);
  });
});

describe('collectEnexFiles 的 Stack 目录约定（evernote-backup 导出）', () => {
  it('子目录中的 .enex 取父目录名为缺省 Stack', async () => {
    const d = tmp();
    try {
      mkdirSync(join(d, '技术 笔记本组'), { recursive: true });
      copyFileSync(join(FIXTURES, 'basic.enex'), join(d, '技术 笔记本组', 'Linux.enex'));
      copyFileSync(join(FIXTURES, 'Work@@@Projects.enex'), join(d, 'Work@@@Projects.enex'));
      copyFileSync(join(FIXTURES, 'basic.enex'), join(d, '顶层.enex'));
      const { files, warnings } = await collectEnexFiles([d], '@@@');
      const linux = files.find((f) => f.baseName === 'Linux')!;
      expect(linux.stack).toBe('技术 笔记本组');
      expect(linux.notebook).toBe('Linux');
      // 文件名 Stack@@@ 分隔符优先于目录约定（顶层文件仍取文件名 Stack）
      const sep = files.find((f) => f.baseName === 'Work@@@Projects')!;
      expect(sep.stack).toBe('Work');
      // 目录约定提供 Stack → 不产生"无 Stack"警告；无 Stack 的顶层文件仍提示
      expect(warnings.join('\n')).not.toContain('Linux.enex：无 Stack');
      expect(warnings.join('\n')).toContain('顶层.enex：无 Stack');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('游标续读多块回归（真实 70MB 文件暴露的 bug：单块 fixture 测不出）', () => {
  it('多块文件的顺序游标提取与全量一致（首个 note 关闭后仍能续读后续笔记）', async () => {
    // 构造 >64KB×若干 的多笔记文件：每条笔记正文填充 ~100KB
    const d = tmp();
    try {
      const filler = 'x'.repeat(100 * 1024);
      const parts: string[] = [];
      for (let i = 1; i <= 6; i++) {
        parts.push(`  <note>\n    <title>多块笔记${String(i).padStart(2, '0')}</title>\n    <content><![CDATA[<en-note><div>${filler}</div></en-note>]]></content>\n    <created>2024010${i}T000000Z</created>\n  </note>`);
      }
      const enex =
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">\n<en-export>\n${parts.join('\n')}\n</en-export>\n`;
      const p = join(d, 'multichunk.enex');
      writeFileSync(p, enex, 'utf8');
      expect(enex.length).toBeGreaterThan(600 * 1024); // 确实是多块

      const all: RawNote[] = [];
      await streamNotes(p, { onNote: (n) => all.push(n) });
      expect(all).toHaveLength(6);

      let cursor = { ordinal: 0, offset: 0 };
      for (let target = 1; target <= 6; target++) {
        let got: RawNote | null = null;
        const out = await streamNotes(p, {
          startOffset: cursor.offset,
          ordinalBase: cursor.ordinal,
          stopAfterOrdinal: target,
          onNote: (n) => { if (n.ordinal === target) got = n; },
        });
        if (out.cursor && out.cursor.ordinal >= cursor.ordinal && out.cursor.offset >= cursor.offset) {
          cursor = out.cursor;
        }
        expect(got, `第 ${target} 条`).not.toBeNull();
        expect((got as RawNote).title).toBe(all[target - 1]!.title);
        expect((got as RawNote).content?.length).toBe(all[target - 1]!.content?.length);
      }
      // 游标确实在笔记间推进（不是停在 0）
      expect(cursor.ordinal).toBeGreaterThan(0);
      expect(cursor.offset).toBeGreaterThan(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
