import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MigrationJobs,
  SourceInstances,
  TargetInstances,
  openDatabase,
  runMigrationJob,
  type DB,
} from '@inkmigrate/core';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { createEvernoteSource } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'evernote');

/**
 * §24.5 端到端：ENEX fixture → scan → extract → Obsidian 写入（临时 Vault）→
 * 附件按 §15.7.4 落盘（原名保留/序号命名/附件区）→ 幂等重跑。
 */
describe('evernote e2e migrate', () => {
  function setupWorkspace(): { dbDir: string; vaultDir: string; inputDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'inkmigrate-evernote-e2e-'));
    const dbDir = join(root, 'state');
    const vaultDir = join(root, 'vault');
    const inputDir = join(root, 'imports', 'evernote');
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(inputDir, { recursive: true });
    for (const f of [
      'basic.enex',
      'Work@@@Projects.enex',
      'resources-named.enex',
      'resources-unnamed.enex',
      'resource-hash-mismatch.enex',
      'remote-images.enex',
      'interlinks.enex',
    ]) {
      copyFileSync(join(FIXTURES, f), join(inputDir, f));
    }
    return { dbDir, vaultDir, inputDir };
  }

  async function setupAndRun(dbDir: string, vaultDir: string, inputDir: string, run: number) {
    const db: DB = openDatabase({ path: join(dbDir, 'inkmigrate.sqlite') });
    if (run === 1) {
      new SourceInstances(db).create({
        id: 'evernote-archive',
        adapterKind: 'evernote',
        adapterVersion: '0.1.0',
        adapterApiVersion: '1.0.0',
        configHash: 'h',
        createdAt: 't',
        updatedAt: 't',
      });
      new TargetInstances(db).create({
        id: 'personal-vault',
        adapterKind: 'obsidian',
        adapterVersion: '1.0.0',
        adapterApiVersion: '1.0.0',
        configHash: 'h',
        createdAt: 't',
        updatedAt: 't',
      });
    }
    const jobId = `j-${Date.now()}-${run}`;
    new MigrationJobs(db).create({
      id: jobId,
      sourceInstanceId: 'evernote-archive',
      targetInstanceId: 'personal-vault',
      status: 'created',
      currentStage: 'preflight',
      createdAt: 't',
      updatedAt: 't',
    });
    const result = await runMigrationJob({
      db,
      jobId,
      sourceAdapter: createEvernoteSource({
        sourceInstanceId: 'evernote-archive',
        inputPaths: [inputDir],
      }),
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 'evernote-archive',
      targetInstanceId: 'personal-vault',
      targetContext: {
        config: {},
        workspaceDir: dbDir,
        vaultPath: vaultDir,
        targetConfig: {
          vaultPath: vaultDir,
          importSubdir: 'Imports/InkMigrate',
          attachmentsSubdir: 'Attachments/InkMigrate',
          linkStyle: 'wikilink',
          overwritePolicy: 'preserve',
          collectionMapping: { toTags: false, toFolders: false },
          maxFilenameLength: 100,
        } as Record<string, unknown>,
      },
      workspaceDir: dbDir,
      reportsDir: join(dbDir, 'reports'),
    });
    return { result, db };
  }

  // e2e 全链路真实耗时 >20s：显式放宽 timeout（全局默认已收紧到 10s）
  it('完整迁移：笔记/图片/附件区落盘且对账通过', { timeout: 60_000 }, async () => {
    const w = setupWorkspace();
    try {
      const { result } = await setupAndRun(w.dbDir, w.vaultDir, w.inputDir, 1);
      expect(result.status).toBe('completed');
      expect(result.scanCount).toBe(9);
      expect(result.reconciliationOk).toBe(true);

      // §13.3 笔记目录：evernote-archive/<笔记本>-<shortId>/（有 Stack 时在 Stack 下）
      const archiveDir = join(w.vaultDir, 'Imports/InkMigrate/evernote-archive');
      expect(existsSync(archiveDir)).toBe(true);
      const mdFiles: Array<{ path: string; content: string }> = [];
      // 深度 ≥1 的 .md 才是笔记（archiveDir 根下的 <source>收藏索引.md 是索引文件）
      const walkMd = (d: string, depth = 0) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory() && e.name !== '_索引') walkMd(full, depth + 1);
          else if (e.name.endsWith('.md') && depth >= 1) {
            mdFiles.push({ path: full, content: readFileSync(full, 'utf8') });
          }
        }
      };
      walkMd(archiveDir);
      expect(mdFiles).toHaveLength(9);
      // §15.10：互链笔记的 wikilink 指向真实落盘文件名
      const noteB = mdFiles.find((m) => m.path.includes('笔记乙'))!;
      expect(noteB).toBeDefined();
      expect(noteB.path).toMatch(/笔记乙\.md$/); // filenameShortId 默认 false → 纯标题
      const noteA = mdFiles.find((m) => m.path.includes('笔记甲'))!;
      // 链接文字与目标标题相同时省略别名（§15.10）
      expect(noteA.content).toContain('[[笔记乙]]');
      // Work@@@Projects.enex → Work/Projects/ 层级（notebookShortId 默认 false → 纯名）
      const workNote = mdFiles.find((m) => m.content.includes('项目会议纪要'))!;
      expect(workNote.path).toMatch(/\/Work\/Projects\//);
      // 笔记本目录用纯名称（默认 notebookShortId=false）
      const notebookDirs = readdirSync(archiveDir).filter((d) => !d.startsWith('_') && !d.startsWith('.'));
      expect(notebookDirs).toContain('basic');
      expect(notebookDirs).toContain('Work');

      // 附件目录按 item-key 隔离（§15.7.4）
      const attachRoot = join(w.vaultDir, 'Attachments/InkMigrate/evernote-archive');
      expect(existsSync(attachRoot)).toBe(true);
      const itemDirs = readdirSync(attachRoot);
      expect(itemDirs.every((d) => d.startsWith('im-'))).toBe(true);

      // 找到带附件笔记的附件目录：包含 原名截图.png、报告.pdf、冲突名后缀文件
      const allFiles: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else allFiles.push(e.name);
        }
      };
      walk(attachRoot);
      expect(allFiles).toContain('截图.png');
      expect(allFiles).toContain('报告.pdf');
      expect(allFiles.some((f) => /^截图-[0-9a-f]{8}\.png$/.test(f))).toBe(true);
      expect(allFiles).toContain('001.png');
      expect(allFiles).toContain('002.png');
      expect(allFiles).toContain('孤儿.png'); // 哈希不匹配笔记的未引用资源

      // 带附件笔记正文：图片内嵌 wikilink + 附件区列表 + 加密占位（§15.7.5/§15.11）
      const namedNote = mdFiles.find((m) => m.content.includes('带附件的笔记'))!.content;
      expect(namedNote).toContain('![[Attachments/InkMigrate/evernote-archive/im-');
      expect(namedNote).toContain('截图.png]]');
      expect(namedNote).toContain('## 附件');
      expect(namedNote).toContain('[[Attachments/InkMigrate/evernote-archive/im-');
      expect(namedNote).toContain('加密内容未迁移');

      // 剪藏笔记保留远程链接（未下载）
      const remoteNote = mdFiles.find((m) => m.content.includes('剪藏笔记'))!.content;
      expect(remoteNote).toContain('https://example.invalid/remote.png');

      // §15.10 未解析内部链接进入报告 unresolved-links.csv
      const reportFiles: string[] = [];
      const walkReports = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walkReports(full);
          else reportFiles.push(full);
        }
      };
      walkReports(join(w.dbDir, 'reports'));
      const csvPath = reportFiles.find((f) => f.endsWith('unresolved-links.csv'));
      expect(csvPath).toBeDefined();
      const csv = readFileSync(csvPath!, 'utf8');
      // interlinks 的失效链接 + resources-named 的无 GUID 链接
      expect(csv).toContain('99999999-8888-7777-6666-555555555555');
      expect(csv).toContain('笔记甲');
      expect(csv.split('\n').length).toBeGreaterThanOrEqual(3); // 表头 + ≥2 行数据

      // 幂等重跑（§24.5 #6）：无新增文件、对账仍通过
      const before = mdFiles.length;
      const r2 = await setupAndRun(w.dbDir, w.vaultDir, w.inputDir, 2);
      expect(r2.result.reconciliationOk).toBe(true);
      const after: string[] = [];
      const walkAgain = (d: string, depth = 0) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory() && e.name !== '_索引') walkAgain(full, depth + 1);
          else if (e.name.endsWith('.md') && depth >= 1) after.push(full);
        }
      };
      walkAgain(archiveDir);
      expect(after).toHaveLength(before);
    } finally {
      rmSync(w.dbDir, { recursive: true, force: true });
      rmSync(w.vaultDir, { recursive: true, force: true });
    }
  });

  it('HTML 导出迁移（§15.12）：笔记/图片/附件落盘且对账通过', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkmigrate-evernote-e2e-html-'));
    const dbDir = join(root, 'state');
    const vaultDir = join(root, 'vault');
    const inputDir = join(root, 'html-export');
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(inputDir, { recursive: true });
    copyFileSync(join(FIXTURES, 'html-export', '剪藏.html'), join(inputDir, '剪藏.html'));
    const { cpSync } = await import('node:fs');
    cpSync(join(FIXTURES, 'html-export', '工作笔记本'), join(inputDir, '工作笔记本'), { recursive: true });
    try {
      const db: DB = openDatabase({ path: join(dbDir, 'inkmigrate.sqlite') });
      new SourceInstances(db).create({
        id: 'evernote-archive',
        adapterKind: 'evernote',
        adapterVersion: '0.1.0',
        adapterApiVersion: '1.0.0',
        configHash: 'h',
        createdAt: 't',
        updatedAt: 't',
      });
      new TargetInstances(db).create({
        id: 'personal-vault',
        adapterKind: 'obsidian',
        adapterVersion: '1.0.0',
        adapterApiVersion: '1.0.0',
        configHash: 'h',
        createdAt: 't',
        updatedAt: 't',
      });
      new MigrationJobs(db).create({
        id: 'j-html-1',
        sourceInstanceId: 'evernote-archive',
        targetInstanceId: 'personal-vault',
        status: 'created',
        currentStage: 'preflight',
        createdAt: 't',
        updatedAt: 't',
      });
      const result = await runMigrationJob({
        db,
        jobId: 'j-html-1',
        sourceAdapter: createEvernoteSource({
          sourceInstanceId: 'evernote-archive',
          inputPaths: [inputDir],
          formats: ['html'],
        }),
        targetAdapter: createObsidianTarget(),
        sourceInstanceId: 'evernote-archive',
        targetInstanceId: 'personal-vault',
        targetContext: {
          config: {},
          workspaceDir: dbDir,
          vaultPath: vaultDir,
          targetConfig: {
            vaultPath: vaultDir,
            importSubdir: 'Imports/InkMigrate',
            attachmentsSubdir: 'Attachments/InkMigrate',
            linkStyle: 'wikilink',
            overwritePolicy: 'preserve',
            collectionMapping: { toTags: false, toFolders: false },
            maxFilenameLength: 100,
          } as Record<string, unknown>,
        },
        workspaceDir: dbDir,
        reportsDir: join(dbDir, 'reports'),
      });
      expect(result.status).toBe('completed');
      expect(result.scanCount).toBe(3);
      expect(result.reconciliationOk).toBe(true);

      // §13.3 HTML 笔记目录：工作笔记本/（notebookShortId 默认 false → 纯名）
      const archiveDir = join(vaultDir, 'Imports/InkMigrate/evernote-archive');
      const contents: string[] = [];
      // 深度 ≥1 的 .md 才是笔记（根下的收藏索引是索引文件）
      const walkMd = (d: string, depth = 0) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory() && e.name !== '_索引') walkMd(full, depth + 1);
          else if (e.name.endsWith('.md') && depth >= 1) contents.push(readFileSync(full, 'utf8'));
        }
      };
      walkMd(archiveDir);
      expect(contents).toHaveLength(3);
      expect(readdirSync(archiveDir)).toContain('工作笔记本');
      const meeting = contents.find((c) => c.includes('会议记录'))!;
      expect(meeting).toBeDefined();
      // 图片内嵌 wikilink（原文件名）+ PDF 进附件区，脚本被清洗
      expect(meeting).toContain('![[Attachments/InkMigrate/evernote-archive/im-');
      expect(meeting).toContain('白板照片.png]]');
      expect(meeting).toContain('## 附件');
      expect(meeting).toContain('议程.pdf');
      expect(meeting).not.toContain('<script');
      const attachDir = join(vaultDir, 'Attachments/InkMigrate/evernote-archive');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else files.push(e.name);
        }
      };
      walk(attachDir);
      expect(files).toContain('白板照片.png');
      expect(files).toContain('议程.pdf');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
