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

  it('完整迁移：笔记/图片/附件区落盘且对账通过', async () => {
    const w = setupWorkspace();
    try {
      const { result } = await setupAndRun(w.dbDir, w.vaultDir, w.inputDir, 1);
      expect(result.status).toBe('completed');
      expect(result.scanCount).toBe(7);
      expect(result.reconciliationOk).toBe(true);

      // 笔记目录：contentKind=note → 笔记/
      const notesDir = join(w.vaultDir, 'Imports/InkMigrate/evernote-archive/笔记');
      expect(existsSync(notesDir)).toBe(true);
      const notes = readdirSync(notesDir).filter((f) => f.endsWith('.md'));
      expect(notes).toHaveLength(7);

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
      const namedNote = readdirSync(notesDir)
        .map((f) => join(notesDir, f))
        .map((p) => readFileSync(p, 'utf8'))
        .find((c) => c.includes('带附件的笔记'));
      expect(namedNote).toBeDefined();
      expect(namedNote).toContain('![[Attachments/InkMigrate/evernote-archive/im-');
      expect(namedNote).toContain('截图.png]]');
      expect(namedNote).toContain('## 附件');
      expect(namedNote).toContain('[[Attachments/InkMigrate/evernote-archive/im-');
      expect(namedNote).toContain('加密内容未迁移');

      // 剪藏笔记保留远程链接（未下载）
      const remoteNote = readdirSync(notesDir)
        .map((f) => join(notesDir, f))
        .map((p) => readFileSync(p, 'utf8'))
        .find((c) => c.includes('剪藏笔记'));
      expect(remoteNote).toContain('https://example.invalid/remote.png');

      // 幂等重跑（§24.5 #6）：无新增文件、对账仍通过
      const before = readdirSync(notesDir).length;
      const r2 = await setupAndRun(w.dbDir, w.vaultDir, w.inputDir, 2);
      expect(r2.result.reconciliationOk).toBe(true);
      expect(readdirSync(notesDir)).toHaveLength(before);
    } finally {
      rmSync(w.dbDir, { recursive: true, force: true });
      rmSync(w.vaultDir, { recursive: true, force: true });
    }
  });
});
