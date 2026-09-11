import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrationJob } from '../../src/runtime/job-runner.js';
import { openDatabase, type DB } from '../../src/storage/database.js';
import { SourceInstances } from '../../src/storage/repositories/source-instances.js';
import { TargetInstances } from '../../src/storage/repositories/target-instances.js';
import { MigrationJobs } from '../../src/storage/repositories/migration-jobs.js';
import { SourceItems } from '../../src/storage/repositories/source-items.js';
import { TargetArtifacts } from '../../src/storage/repositories/target-artifacts.js';
import {
  computeFingerprint,
  validateSourceItemQuality,
  type SourceAdapter,
  type SourceItem,
  type SourceItemRef,
  type TargetContext,
  type TargetAdapter,
  type TargetPlan,
  type TargetWriteResult,
  type TargetVerification,
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

  it('importSubdir 为空时索引生成不崩溃（pathSeg 回退 + indexDir 不产生绝对路径）', async () => {
    // 回归：CLI migrate 默认 importSubdir=''，笔记直接落 Vault 根（裸文件名）。
    // 此前 pathSeg 反解在裸文件名上退化为文件名、indexDir 拼接产生 '/...' 绝对路径
    // → resolveWithin 抛 escapes root → 索引生成失败。
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'jidx-root', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });
    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');
    const targetCtx: TargetContext = {
      config: {},
      workspaceDir: dbDir,
      vaultPath: vaultDir,
      targetConfig: {
        vaultPath: vaultDir, importSubdir: '', attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink', overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false }, maxFilenameLength: 100,
      } as Record<string, unknown>,
    };

    const result = await runMigrationJob({
      db, jobId: 'jidx-root',
      sourceAdapter: createFixtureSource(favoritesHtml, articleHtml),
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: targetCtx, workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });
    expect(result.status).toBe('completed');
    // 索引 artifact 落库（不因 escapes root 而失败）
    const indexArtifacts = new TargetArtifacts(db)
      .listByJob('jidx-root')
      .filter((a) => a.artifactKind === 'index');
    expect(indexArtifacts.length).toBeGreaterThan(0);
    // 索引文件写入 Vault 内（相对路径，不以 / 开头；落 Vault 根的 _索引/ 下）
    for (const a of indexArtifacts) {
      expect(!a.relativePath.startsWith('/')).toBe(true);
      expect(existsSync(join(vaultDir, a.relativePath))).toBe(true);
    }
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

  it('§13 限流条目标为可恢复态 interrupted（非 skipped），Job 进入 paused', async () => {
    // 缺陷13：限流（429/503）时未处理条目被标为 'skipped'，与用户主动跳过的 skipped
    // 混淆，不利审计与断点续跑。按规格 §11.1：限流是 Job 级 paused（pause_reason=
    // rate_limited），未处理条目应为可恢复态 interrupted（completed 前须为 0），
    // 不计入完成对账终态，且绝不与 skipped 混淆。
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
    // retryable:false 让 withRetry 立即抛出（绕过生产 3 次退避重试，加速测试）。
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

    // Job 因限流进入 paused（非 completed），pause_reason=rate_limited
    expect(result.status).toBe('paused');
    expect(result.reconciliationOk).toBe(false);
    expect(result.reconciliationReason).toBe('rate_limited');
    // 限流未处理条目不得误归 skipped（与用户主动跳过区分）
    const counts = result.finalStateCounts as Record<string, number>;
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

  it('scan 幂等兜底：同 external_id 不同 fingerprint 不触发 UNIQUE 约束违反', async () => {
    // 回归场景：DB 里已有用【旧 fingerprint 算法】写入的 source_item（external_id='7428...'），
    // 本次 scan 用【新 fingerprint 算法】算出不同 fingerprint。仅按 fingerprint 查重会放过
    // 这条 ref，随后被 UNIQUE(source_instance_id, external_id) 约束拒绝（UNIQUE constraint
    // failed: source_items.source_instance_id, source_items.external_id）。
    // 修复：persistSourceItemRef 在 fingerprint 未命中时，再用 external_id 兜底查重。
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j-dedup', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });

    // 预置一条【旧算法 fingerprint】的 source_item（模拟历史数据），
    // external_id 与本次 scan 即将产生的 ref 相同。
    const oldFingerprint = 'sha256:' + '0'.repeat(64); // 故意不同于新算法
    new SourceItems(db).create({
      sourceInstanceId: 's1',
      externalId: '7428193012345678901',
      fingerprint: oldFingerprint,
      stableKey: 'sk-old',
      itemKey: 'ik-old',
      stableShortId: 'sid-old',
      canonicalUrl: 'https://www.toutiao.com/article/7428193012345678901/',
      contentKind: 'article',
      discoveredAt: 't',
      status: 'discovered',
      createdAt: 't',
      updatedAt: 't',
    });

    // 适配器产出【新算法 fingerprint】但相同 external_id 的 ref
    const newFp = computeFingerprint(
      deriveFingerprintInput({ contentId: '7428193012345678901' }),
    );
    expect(newFp).not.toBe(oldFingerprint); // 确认新旧 fingerprint 不同
    const adapter: SourceAdapter = {
      ...createToutiaoSource(),
      async *scan() {
        const ref: SourceItemRef = {
          sourceInstanceId: 's1',
          externalId: '7428193012345678901',
          canonicalUrl: 'https://www.toutiao.com/article/7428193012345678901/',
          title: '历史文章',
          contentKind: 'article',
          discoveredAt: new Date().toISOString(),
          fingerprint: newFp,
          sourceMetadata: {},
        };
        yield ref;
      },
      async extract(ref) {
        const item: SourceItem = {
          ref,
          title: '历史文章',
          tags: [], collections: [], assets: [], links: [],
          quality: 'full', degradations: [],
          extractionMethod: 'fixture', extractionWarnings: [], sourceMetadata: {},
        };
        return item;
      },
    };

    const targetCtx: TargetContext = {
      config: {},
      workspaceDir: dbDir,
      vaultPath: vaultDir,
      targetConfig: {
        vaultPath: vaultDir, importSubdir: '', attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink', overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false }, maxFilenameLength: 100,
      } as Record<string, unknown>,
    };

    // 修复前：抛 UNIQUE constraint failed: source_items.source_instance_id, source_items.external_id
    // 修复后：external_id 兜底命中，跳过插入，Job 正常完成
    const result = await runMigrationJob({
      db,
      jobId: 'j-dedup',
      sourceAdapter: adapter,
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1',
      targetInstanceId: 't1',
      targetContext: targetCtx,
      workspaceDir: dbDir,
      reportsDir: join(dbDir, 'reports'),
    });
    expect(result.scanCount).toBe(1);
    expect(result.status).toBe('completed');
    expect(result.reconciliationOk).toBe(true);
  });

  it('target_artifacts 重跑幂等：同路径已有 artifact 时 UPDATE 而非 UNIQUE 冲突', async () => {
    // 回归场景：UNIQUE(target_instance_id, relative_path) 是跨 Job 约束。
    // 上一轮 migrate 已写入某文章（artifact 落库），但因中途失败/中断该 source_item
    // 状态未置为 verified，重跑时 processOneItem 不跳过、走到 commitTxn 的 create →
    // 撞 UNIQUE 约束，被误判为 conflict（日志：路径并发冲突 UNIQUE constraint failed）。
    // 修复：create 前用 findByTargetPath 探测，命中即 updateCommitted 刷新既有记录。
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j-first', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j-reup', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't2', updatedAt: 't2',
    });

    const fp = computeFingerprint(deriveFingerprintInput({ contentId: '9990001112223' }));
    const makeAdapter = (): SourceAdapter => ({
      ...createToutiaoSource(),
      async *scan() {
        const ref: SourceItemRef = {
          sourceInstanceId: 's1',
          externalId: '9990001112223',
          canonicalUrl: 'https://www.toutiao.com/article/9990001112223/',
          title: '999 title',
          contentKind: 'article',
          discoveredAt: new Date().toISOString(),
          fingerprint: fp,
          sourceMetadata: {},
        };
        yield ref;
      },
      async extract(ref) {
        const item: SourceItem = {
          ref, title: '999 title',
          tags: [], collections: [], assets: [], links: [],
          quality: 'full', degradations: [],
          extractionMethod: 'fixture', extractionWarnings: [], sourceMetadata: {},
        };
        return item;
      },
    });
    const targetCtx: TargetContext = {
      config: {},
      workspaceDir: dbDir, vaultPath: vaultDir,
      targetConfig: {
        vaultPath: vaultDir, importSubdir: '', attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink', overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false }, maxFilenameLength: 100,
      } as Record<string, unknown>,
    };

    // 第一轮：正常迁移，source_item 落 verified + artifact 落库
    const r1 = await runMigrationJob({
      db, jobId: 'j-first',
      sourceAdapter: makeAdapter(), targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: targetCtx, workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });
    expect(r1.status).toBe('completed');
    const arts1 = new TargetArtifacts(db).listByJob('j-first').filter((a) => a.artifactKind === 'note');
    expect(arts1.length).toBe(1);
    const notePath = arts1[0]!.relativePath;

    // 模拟"上轮未完成提交"：把 source_item 状态退回 discovered（artifact 保留）。
    // 这样第二轮 processOneItem 不会因 status='verified' 跳过，会走到 commitTxn 的 create。
    db.prepare(`UPDATE source_items SET status='discovered' WHERE fingerprint=?`).run(fp);

    // 第二轮：同路径已有 artifact。修复前 → UNIQUE constraint failed → conflict；
    // 修复后 → findByTargetPath 命中 → updateCommitted 刷新 → 正常 verified。
    const r2 = await runMigrationJob({
      db, jobId: 'j-reup',
      sourceAdapter: makeAdapter(), targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: targetCtx, workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });
    expect(r2.status).toBe('completed');
    expect((r2.finalStateCounts as Record<string, number>).conflict ?? 0).toBe(0);
    // artifact 被刷新到本轮 job（迁移归属更新），仍是同一条记录（无 UNIQUE 冲突）
    const refreshed = new TargetArtifacts(db).findByTargetPath('t1', notePath);
    expect(refreshed).toBeDefined();
    expect(refreshed!.migrationJobId).toBe('j-reup');
  });

  it('R3-T1/H-1: mark_conflict (skippedWrite=true) 归为 conflict 而非 verified', async () => {
    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');

    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j-conflict', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });

    const targetCtx: TargetContext = {
      config: {}, workspaceDir: dbDir, vaultPath: vaultDir,
      targetConfig: {
        vaultPath: vaultDir, importSubdir: '', attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink', overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false }, maxFilenameLength: 100,
      } as Record<string, unknown>,
    };

    // mock target adapter：write 返回 skippedWrite=true（模拟 mark_conflict）
    const conflictTarget: TargetAdapter = {
      kind: 'mock', version: '1.0.0', adapterApiVersion: '1.0.0',
      capabilities: { supportsCleanup: false, contentKinds: ['article'] },
      async validateConfig() { return { ok: true }; },
      async prepare() {},
      async plan(_ref) {
        return {
          relativePath: 'mock-note.md',
          artifactKind: 'note',
          sourceContentHash: 'sha256:mock',
        } satisfies TargetPlan;
      },
      async write(_plan, _ctx): Promise<TargetWriteResult> {
        // H-1 核心：返回 skippedWrite=true，不写文件
        return {
          relativePath: 'x.md',
          targetContentHash: 'sha256:mock-target',
          writtenFileHash: 'sha256:mock-written',
          skippedWrite: true,
        };
      },
      async verify(_r, _ctx): Promise<TargetVerification> {
        // verify 不应被调用（skippedWrite 跳过），但若被调用返回 ok=true 会暴露 H-1 bug
        return { ok: true };
      },
      async close() {},
    };

    const result = await runMigrationJob({
      db, jobId: 'j-conflict',
      sourceAdapter: createFixtureSource(favoritesHtml, articleHtml), targetAdapter: conflictTarget,
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: targetCtx, workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });

    // H-1: skippedWrite → conflict（不是 verified）
    expect(result.status).toBe('completed');
    expect((result.finalStateCounts as Record<string, number>).conflict ?? 0).toBeGreaterThan(0);
  });

  it('R4-C2: 取消 in-flight extract 归为 skipped 而非 permanent_failed', async () => {
    const favoritesHtml = readFileSync(join(FIXTURES, 'favorites-list.html'), 'utf8');
    const articleHtml = readFileSync(join(FIXTURES, 'article.html'), 'utf8');
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'j-abort', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });
    const targetCtx: TargetContext = {
      config: {}, workspaceDir: dbDir, vaultPath: vaultDir,
      targetConfig: {
        vaultPath: vaultDir, importSubdir: '', attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink', overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false }, maxFilenameLength: 100,
      } as Record<string, unknown>,
    };
    // mock source adapter: extract 抛 AbortError（模拟取消信号中断 in-flight extract）
    const abortSource: SourceAdapter = {
      ...createFixtureSource(favoritesHtml, articleHtml),
      async extract() {
        // R4-C2: 模拟 adapter 收到 abort 信号后抛 AbortError
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      },
    };
    const result = await runMigrationJob({
      db, jobId: 'j-abort',
      sourceAdapter: abortSource, targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1', targetInstanceId: 't1',
      targetContext: targetCtx, workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
    });
    // R4-C2: AbortError 应归为 skipped（可恢复），而非 permanent_failed
    const counts = result.finalStateCounts as Record<string, number>;
    expect(counts.permanent_failed ?? 0).toBe(0);
    expect(counts.skipped).toBeGreaterThan(0);
  });

  it('§17.2 幂等跳过校验磁盘产物：文件在→跳过；文件被删→重跑重建', async () => {
    // 回归场景（2026-09-11 真实事故）：用户手动删除 Vault 里的迁移文件后重跑，
    // source_items 仍是 verified → processOneItem 直接跳过 → Job "completed 440
    // verified" 但 0 文件落盘。DB 说 verified 不等于文件还在——跳过前必须用
    // note artifact 的相对路径到 vaultPath 下核实磁盘存在，缺失即降级为重迁移。
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'toutiao', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    for (const j of ['j-keep', 'j-del', 'j-del2']) {
      new MigrationJobs(db).create({
        id: j, sourceInstanceId: 's1', targetInstanceId: 't1',
        status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
      });
    }

    const fp = computeFingerprint(deriveFingerprintInput({ contentId: '7770001112223' }));
    let extractCalls = 0;
    const makeAdapter = (): SourceAdapter => ({
      ...createToutiaoSource(),
      async *scan() {
        const ref: SourceItemRef = {
          sourceInstanceId: 's1',
          externalId: '7770001112223',
          canonicalUrl: 'https://www.toutiao.com/article/7770001112223/',
          title: '777 磁盘校验',
          contentKind: 'article',
          discoveredAt: new Date().toISOString(),
          fingerprint: fp,
          sourceMetadata: {},
        };
        yield ref;
      },
      async extract(ref) {
        extractCalls++;
        const item: SourceItem = {
          ref, title: '777 磁盘校验',
          tags: [], collections: [], assets: [], links: [],
          quality: 'full', degradations: [],
          extractionMethod: 'fixture', extractionWarnings: [], sourceMetadata: {},
        };
        return item;
      },
    });
    const targetCtx: TargetContext = {
      config: {},
      workspaceDir: dbDir, vaultPath: vaultDir,
      targetConfig: {
        vaultPath: vaultDir, importSubdir: '', attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink', overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false }, maxFilenameLength: 100,
      } as Record<string, unknown>,
    };
    const run = (jobId: string) =>
      runMigrationJob({
        db, jobId,
        sourceAdapter: makeAdapter(), targetAdapter: createObsidianTarget(),
        sourceInstanceId: 's1', targetInstanceId: 't1',
        targetContext: targetCtx, workspaceDir: dbDir, reportsDir: join(dbDir, 'reports'),
      });

    // 第一轮：迁移成功，文件落盘
    const r1 = await run('j-keep');
    expect(r1.status).toBe('completed');
    const arts1 = new TargetArtifacts(db).listByJob('j-keep').filter((a) => a.artifactKind === 'note');
    expect(arts1.length).toBe(1);
    const notePath = join(vaultDir, arts1[0]!.relativePath);
    expect(existsSync(notePath)).toBe(true);
    expect(extractCalls).toBe(1);

    // 第二轮（文件仍在）：§17.2 正常幂等——不 extract、不重写
    const r2 = await run('j-del');
    expect(r2.status).toBe('completed');
    expect(extractCalls).toBe(1);

    // 第三轮（文件被用户删除）：修复前静默跳过（completed 但 0 文件）；
    // 修复后降级为重迁移——重新 extract 并重建文件
    rmSync(notePath);
    const r3 = await run('j-del2');
    expect(r3.status).toBe('completed');
    expect(existsSync(notePath)).toBe(true);
    expect(extractCalls).toBe(2);
    const refreshed = new TargetArtifacts(db).findByTargetPath('t1', arts1[0]!.relativePath);
    expect(refreshed).toBeDefined();
  });
});
