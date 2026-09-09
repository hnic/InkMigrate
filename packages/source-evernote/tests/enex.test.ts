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
