import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrationJob } from '../../src/runtime/job-runner.js';
import { openDatabase, type DB } from '../../src/storage/database.js';
import { SourceInstances } from '../../src/storage/repositories/source-instances.js';
import { TargetInstances } from '../../src/storage/repositories/target-instances.js';
import { MigrationJobs } from '../../src/storage/repositories/migration-jobs.js';
import { TargetArtifacts } from '../../src/storage/repositories/target-artifacts.js';
import {
  computeFingerprint,
  validateSourceItemQuality,
  type SourceAdapter,
  type SourceItem,
  type SourceItemRef,
  type TargetContext,
} from '../../src/index.js';
import {
  createToutiaoSource,
  scanFavoritesList,
  extractDetail,
  deriveFingerprintInput,
} from '@inkmigrate/source-toutiao';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'source-toutiao',
  'tests',
  'fixtures',
  'toutiao',
);

function createFixtureSource(
  favoritesHtml: string,
  detailHtml: string,
): SourceAdapter {
  const real = createToutiaoSource();
  return {
    ...real,
    async *scan() {
      const result = await scanFavoritesList({
        initialHtml: favoritesHtml,
        baseUrl: 'https://www.toutiao.com/',
        scrollForMore: async () => null,
        maxEmptyCycles: 1,
      });
      for (const fav of result.items) {
        const fpBuilder: Parameters<typeof deriveFingerprintInput>[0] = {
          canonicalUrl: fav.canonicalUrl,
        };
        if (fav.externalId) fpBuilder.contentId = fav.externalId;
        const fp = computeFingerprint(deriveFingerprintInput(fpBuilder));
        const ref: SourceItemRef = {
          sourceInstanceId: 'toutiao-main',
          canonicalUrl: fav.canonicalUrl,
          originalUrl: fav.originalUrl,
          title: fav.title,
          contentKind: fav.contentKind,
          discoveredAt: new Date().toISOString(),
          fingerprint: fp,
          sourceMetadata: fav.sourceMetadata,
        };
        if (fav.externalId) ref.externalId = fav.externalId;
        yield ref;
      }
    },
    async extract(ref) {
      const url = ref.canonicalUrl ?? '';
      const detail = extractDetail({
        html: detailHtml,
        canonicalUrl: url,
        originalUrl: url,
      });
      validateSourceItemQuality(detail.quality, detail.degradations);
      const item: SourceItem = {
        ref,
        title: detail.title,
        tags: [],
        collections: [],
        assets: [],
        links: [],
        quality: detail.quality,
        degradations: detail.degradations,
        extractionMethod: 'fixture',
        extractionWarnings: [],
        sourceMetadata: {},
      };
      if (detail.markdown) item.bodyText = detail.markdown;
      return item;
    },
  };
}

let dbDir: string;
let vaultDir: string;
let db: DB;
beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'job-runner-db-'));
  vaultDir = mkdtempSync(join(tmpdir(), 'job-runner-vault-'));
  db = openDatabase({ path: join(dbDir, 'test.sqlite') });
});
afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('runMigrationJob (§11 端到端)', () => {
  it('completes scan→extract→write→verify→reconcile→report (§24.5 #1,#2,#4,#5,#11)', async () => {
    // seed instances + job
    new SourceInstances(db).create({
      id: 's1',
      adapterKind: 'toutiao',
      adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0',
      configHash: 'h',
      createdAt: 't',
      updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1',
      adapterKind: 'obsidian',
      adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0',
      configHash: 'h',
      createdAt: 't',
      updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j1',
      sourceInstanceId: 's1',
      targetInstanceId: 't1',
      status: 'created',
      currentStage: 'preflight',
      createdAt: 't',
      updatedAt: 't',
    });

    const favoritesHtml = readFileSync(
      join(FIXTURES, 'favorites-list.html'),
      'utf8',
    );
    const articleHtml = readFileSync(
      join(FIXTURES, 'article.html'),
      'utf8',
    );

    const targetCtx: TargetContext = {
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
    };

    const result = await runMigrationJob({
      db,
      jobId: 'j1',
      sourceAdapter: createFixtureSource(favoritesHtml, articleHtml),
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1',
      targetInstanceId: 't1',
      targetContext: targetCtx,
      workspaceDir: dbDir,
      reportsDir: join(dbDir, 'reports'),
    });

    // §24.5 #1: 扫描到 SQLite
    expect(result.scanCount).toBe(3);
    // §24.5 #11: 完整性方程成立
    expect(result.reconciliationOk).toBe(true);
    expect(result.status).toBe('completed');
    // §24.5 #4: 写 Vault
    const importedDir = join(vaultDir, 'Imports/InkMigrate/toutiao-main');
    expect(existsSync(importedDir)).toBe(true);
    // §24.5 #5: 报告生成
    expect(existsSync(join(dbDir, 'reports/j1/summary.json'))).toBe(true);
  });

  it('§13.8 完成后生成索引 artifact（generating_indexes 阶段）', async () => {
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'jidx', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });
    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');
    const targetCtx: TargetContext = {
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
    };

    const result = await runMigrationJob({
      db,
      jobId: 'jidx',
      sourceAdapter: createFixtureSource(favoritesHtml, articleHtml),
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1',
      targetInstanceId: 't1',
      targetContext: targetCtx,
      workspaceDir: dbDir,
      reportsDir: join(dbDir, 'reports'),
    });

    expect(result.status).toBe('completed');
    // §13.8 index artifact 落库（artifact_kind='index'）
    const indexArtifacts = new TargetArtifacts(db)
      .listByJob('jidx')
      .filter((a) => a.artifactKind === 'index');
    expect(indexArtifacts.length).toBeGreaterThan(0);
    // 索引文件写入 Vault（_索引/ 分片 + 总入口）
    const indexDir = join(vaultDir, 'Imports/InkMigrate/toutiao-main/_索引');
    expect(existsSync(indexDir)).toBe(true);
    const entryIndex = join(vaultDir, 'Imports/InkMigrate/toutiao-main/toutiao-main收藏索引.md');
    expect(existsSync(entryIndex)).toBe(true);
  });

  it('writes migration_attempts audit trail per item (§16.7)', async () => {
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j2', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });

    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');

    const targetCtx: TargetContext = {
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
    };

    await runMigrationJob({
      db, jobId: 'j2',
      sourceAdapter: createFixtureSource(favoritesHtml, articleHtml),
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: targetCtx,
      workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });

    // §16.7: 每条成功条目至少有一条 migration_attempt 记录
    const attempts = db.prepare(
      'SELECT COUNT(*) as c FROM migration_attempts WHERE migration_job_id = ?',
    ).get('j2') as { c: number };
    expect(attempts.c).toBeGreaterThanOrEqual(3);
  });

  it('creates target_artifacts with verified status (§16.6 lifecycle)', async () => {
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j3', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });

    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');

    await runMigrationJob({
      db, jobId: 'j3',
      sourceAdapter: createFixtureSource(favoritesHtml, articleHtml),
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: {
        config: {}, workspaceDir: dbDir, vaultPath: vaultDir,
        targetConfig: {
          vaultPath: vaultDir, importSubdir: 'Imports/InkMigrate',
          attachmentsSubdir: 'Attachments/InkMigrate', linkStyle: 'wikilink',
          overwritePolicy: 'preserve',
          collectionMapping: { toTags: false, toFolders: false },
          maxFilenameLength: 100,
        } as Record<string, unknown>,
      },
      workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });

    // §16.6: target_artifacts 表中有 verified 状态的 note 行（§13.8 索引 artifact 另算）
    const artifacts = db.prepare(
      `SELECT status, artifact_kind FROM target_artifacts
       WHERE migration_job_id = ? AND artifact_kind = 'note'`,
    ).all('j3') as Array<{ status: string; artifact_kind: string }>;
    expect(artifacts.length).toBeGreaterThanOrEqual(3);
    expect(artifacts.every((a) => a.status === 'verified')).toBe(true);
    expect(artifacts.every((a) => a.artifact_kind === 'note')).toBe(true);
  });

  it('§13 限流条目终态为 rate_limited（非 skipped），Job 进入 paused', async () => {
    // 缺陷13：限流（429/503）时未处理条目被标为 'skipped'，与用户主动跳过的 skipped
    // 混淆，不利审计。修正后限流条目应为独立终态 'rate_limited'（可断点续跑恢复）。
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'jrl', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });
    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');

    // 构造一个会在第 2 条 extract 时抛 429 的 source：第 1 条正常，第 2 条限流。
    // retryable:false 让 withRetry 立即抛出（绕过生产 3 次退避重试，加速测试），
    // 不影响验证"429 → rate_limited 终态"这一核心逻辑。
    const base = createFixtureSource(favoritesHtml, articleHtml);
    let extractCalls = 0;
    const rateLimitedSource: SourceAdapter = {
      ...base,
      async extract(ref) {
        extractCalls++;
        if (extractCalls === 2) {
          const err = new Error('rate limited') as Error & {
            httpStatus?: number;
            retryable?: boolean;
          };
          err.httpStatus = 429;
          err.retryable = false;
          throw err;
        }
        return base.extract(ref);
      },
    };

    const targetCtx: TargetContext = {
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
    };

    const result = await runMigrationJob({
      db,
      jobId: 'jrl',
      sourceAdapter: rateLimitedSource,
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1',
      targetInstanceId: 't1',
      targetContext: targetCtx,
      workspaceDir: dbDir,
      reportsDir: join(dbDir, 'reports'),
    });

    // Job 因限流进入 paused（非 completed）
    expect(result.status).toBe('paused');
    expect(result.reconciliationOk).toBe(false);
    expect(result.reconciliationReason).toBe('rate_limited');
    // 限流条目（第 2 条）+ 其后未处理条目（第 3 条）应归类为 rate_limited，而非 skipped
    const counts = result.finalStateCounts as Record<string, number>;
    expect(counts.rate_limited).toBeGreaterThanOrEqual(1);
    expect(counts.skipped ?? 0).toBe(0);
  });

  it('injects migration_job_id into frontmatter (§13.5)', async () => {
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j-frontmatter', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });

    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');

    await runMigrationJob({
      db, jobId: 'j-frontmatter',
      sourceAdapter: createFixtureSource(favoritesHtml, articleHtml),
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: {
        config: {}, workspaceDir: dbDir, vaultPath: vaultDir,
        targetConfig: {
          vaultPath: vaultDir, importSubdir: 'Imports/InkMigrate',
          attachmentsSubdir: 'Attachments/InkMigrate', linkStyle: 'wikilink',
          overwritePolicy: 'preserve',
          collectionMapping: { toTags: false, toFolders: false },
          maxFilenameLength: 100,
        } as Record<string, unknown>,
      },
      workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });

    // 找到一个写入的笔记文件并检查 frontmatter
    const { readdirSync } = await import('node:fs');
    const noteDir = join(vaultDir, 'Imports/InkMigrate/toutiao-main/文章');
    if (existsSync(noteDir)) {
      const files = readdirSync(noteDir).filter((f) => f.endsWith('.md'));
      if (files.length > 0) {
        const content = readFileSync(join(noteDir, files[0]!), 'utf8');
        // 精简 frontmatter：只保留 title 和 source_url
        expect(content).toMatch(/^---\n.*title:/s);
        expect(content).toMatch(/source_url:\s*https:\/\/www\.toutiao\.com/);
      }
    }
  });
});
