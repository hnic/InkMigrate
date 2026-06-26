import { Command } from 'commander';
import { openDatabase, type DB } from '@inkmigrate/core';
import {
  createToutiaoSource,
  profilePath,
  profileExists,
  type ToutiaoBrowserAdapterConfig,
} from '@inkmigrate/source-toutiao';
import { join } from 'node:path';

/**
 * §12.7 `inkmigrate cleanup unfavorite` 命令。
 *
 * 从数据库读取已迁移（verified）的条目，逐条打开文章详情页点击取消收藏。
 *
 * 用法：
 *   inkmigrate cleanup unfavorite \
 *     --source toutiao-main \
 *     --state-dir .inkmigrate \
 *     --max-items 3
 */
export function createCleanupCommand(): Command {
  const cleanup = new Command('cleanup').description('源端清理：取消收藏');

  cleanup
    .command('unfavorite')
    .description('打开浏览器，逐条取消已迁移条目的收藏')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option('--max-items <n>', '最多取消收藏的条目数（默认全部）')
    .action(async (opts: {
      source: string;
      stateDir: string;
      maxItems?: string;
    }) => {
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      const db: DB = openDatabase({ path: dbPath });
      try {
        // 读取已迁移的条目
        const limit = opts.maxItems ? parseInt(opts.maxItems, 10) : undefined;
        const rows = db
          .prepare(
            `SELECT canonical_url, title, external_id, content_kind
             FROM source_items
             WHERE source_instance_id = ? AND status = 'verified'
             ORDER BY source_position ASC
             ${limit ? 'LIMIT ?' : ''}`,
          )
          .all(opts.source, ...(limit ? [limit] : [])) as Array<{
            canonical_url: string;
            title: string;
            external_id: string | null;
            content_kind: string;
          }>;

        if (rows.length === 0) {
          console.log('没有已迁移的条目可清理。');
          return;
        }

        console.log(`找到 ${rows.length} 条已迁移条目。`);
        console.log('即将逐条打开文章详情页并取消收藏。');
        console.log('');

        // 检查 Profile
        const pPath = profilePath(opts.stateDir, opts.source);
        if (!profileExists(opts.stateDir, opts.source)) {
          console.error(`未找到 Profile：${pPath}`);
          console.error(
            `请先运行：inkmigrate auth login --source ${opts.source} --state-dir ${opts.stateDir}`,
          );
          process.exit(1);
        }

        const adapterConfig: ToutiaoBrowserAdapterConfig = {
          sourceInstanceId: opts.source,
          profileDir: pPath,
          headless: true,
        };
        const adapter = createToutiaoSource(adapterConfig);

        await adapter.prepare({ config: {}, workspaceDir: opts.stateDir });

        let successCount = 0;
        let skipCount = 0;
        let failCount = 0;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const title = row.title?.substring(0, 50) ?? '(无标题)';
          console.log(`[${i + 1}/${rows.length}] ${title}`);
          console.log(`  URL: ${row.canonical_url}`);

          const ref = {
            sourceInstanceId: opts.source,
            canonicalUrl: row.canonical_url,
            originalUrl: row.canonical_url,
            title: row.title,
            contentKind: row.content_kind as 'article',
            discoveredAt: new Date().toISOString(),
            fingerprint: '',
            sourceMetadata: {},
            ...(row.external_id ? { externalId: row.external_id } : {}),
          };

          try {
            const result = await adapter.cleanup!.executeAction(
              ref,
              'unfavorite',
              { config: {}, workspaceDir: opts.stateDir },
            ) as { success: boolean; wasCollected: boolean; isCollected: boolean; reason?: string };

            if (result.success) {
              if (result.wasCollected) {
                console.log('  ✅ 已取消收藏');
                successCount++;
              } else {
                console.log('  ⏭️  本来就未收藏，跳过');
                skipCount++;
              }
            } else {
              console.log(`  ❌ 失败：${result.reason ?? '未知原因'}`);
              failCount++;
            }
          } catch (e) {
            console.log(`  ❌ 异常：${(e as Error).message}`);
            failCount++;
          }
        }

        await adapter.close();

        console.log('\n========== 清理完成 ==========');
        console.log(`  成功取消收藏: ${successCount}`);
        console.log(`  跳过（未收藏）: ${skipCount}`);
        console.log(`  失败: ${failCount}`);
      } finally {
        db.close();
      }
    });

  return cleanup;
}
