import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrationJob } from '../../src/runtime/job-runner.js';
import { openDatabase, type DB } from '../../src/storage/database.js';
import { SourceInstances } from '../../src/storage/repositories/source-instances.js';
import { TargetInstances } from '../../src/storage/repositories/target-instances.js';
import { MigrationJobs } from '../../src/storage/repositories/migration-jobs.js';
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
});
