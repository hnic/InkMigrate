/**
 * 全量重跑图片本地化。
 *
 * 从 DB 读所有 verified 条目，逐条 extract（重新下载图片）→ 写入（用 DB 里的
 * relative_path 直接覆盖原文件，绕过 planNote 的 shortId 后缀路径，避免重复）。
 *
 * 正文里的远程图片 URL 会被替换成本地 ![[Attachments/...]] 嵌入。
 *
 * 用法：cd packages/core && node rerun-all-assets.mjs [--limit N] [--dry-run]
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createToutiaoSource } from "../source-toutiao/dist/adapters/adapter.js";
import { profilePath } from "../source-toutiao/dist/auth/profile.js";
import {
  sanitizeFilename,
  deriveItemKey,
  computeStableKey,
} from "./dist/index.js";

// 解析参数
const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
const DRY_RUN = args.includes("--dry-run");
const ONLY_ID = (() => {
  const i = args.indexOf("--only");
  return i >= 0 ? parseInt(args[i + 1], 10) : 0;
})();

const DB_PATH = "/Users/hnic/.inkmigrate/inkmigrate.sqlite";
const STATE_DIR = "/Users/hnic/.inkmigrate";
// 笔记在 toutiao/ 子目录，附件在 vault 根的 Attachments/。
// wikilink ![[Attachments/...]] 相对 vault 根，Obsidian 跨子目录能正确解析。
const VAULT = "/Users/hnic/Documents/Obsidian";
const NOTES_DIR = "/Users/hnic/Documents/Obsidian/toutiao";
const SOURCE_ID = "toutiao-main";
const ATTACHMENTS_SUBDIR = "Attachments";

const db = new Database(DB_PATH);
let query = `
  SELECT si.id, si.canonical_url, si.original_url, si.title, si.content_kind,
         si.fingerprint, si.source_metadata_json, ta.relative_path
  FROM source_items si
  JOIN target_artifacts ta ON ta.source_item_id = si.id
  WHERE si.source_instance_id = ? AND si.status = ? AND ta.status = ?
`;
const params = [SOURCE_ID, "verified", "verified"];
if (ONLY_ID) {
  query += " AND si.id = ?";
  params.push(ONLY_ID);
}
query += " ORDER BY si.id";
if (LIMIT > 0) query += ` LIMIT ${LIMIT}`;

const rows = db.prepare(query).all(...params);
console.log(`待处理: ${rows.length} 条${DRY_RUN ? " [DRY-RUN]" : ""}`);

if (rows.length === 0) {
  db.close();
  process.exit(0);
}

// 构造 source adapter（复用登录 profile）
const source = createToutiaoSource({
  sourceInstanceId: SOURCE_ID,
  profileDir: profilePath(STATE_DIR, SOURCE_ID),
  headless: false,
});
await source.prepare({ config: {}, workspaceDir: STATE_DIR });
console.log("浏览器已启动\n");

let ok = 0, failed = 0, skipped = 0, assetsWritten = 0;
const errors = [];

for (let idx = 0; idx < rows.length; idx++) {
  const r = rows[idx];
  const progress = `[${idx + 1}/${rows.length}]`;

  try {
    const ref = {
      sourceInstanceId: SOURCE_ID,
      canonicalUrl: r.canonical_url,
      originalUrl: r.original_url ?? r.canonical_url,
      title: r.title,
      contentKind: r.content_kind,
      discoveredAt: new Date().toISOString(),
      fingerprint: r.fingerprint,
      sourceMetadata:
        typeof r.source_metadata_json === "string"
          ? JSON.parse(r.source_metadata_json)
          : {},
    };

    // 断点续跑：跳过已处理的笔记（含本地嵌入的），避免重复 extract。
    const notePath = join(NOTES_DIR, r.relative_path);
    if (!existsSync(notePath)) {
      skipped++;
      if (!DRY_RUN) console.log(`${progress} id=${r.id} 原文件缺失，跳过`);
      continue;
    }
    let content = readFileSync(notePath, "utf8");
    if (content.includes("![[Attachments/")) {
      skipped++;
      continue; // 已本地化，跳过
    }

    // extract（含图片下载）
    const item = await source.extract(ref, { config: {}, workspaceDir: STATE_DIR });
    const imgAssets = item.assets.filter((a) => a.kind === "image" && a.data && a.sha256);

    if (imgAssets.length === 0) {
      skipped++;
      if (!DRY_RUN) console.log(`${progress} id=${r.id} 无可下载图片，跳过`);
      continue;
    }

    // 生成附件路径 + 替换正文里的远程图片 URL 为本地嵌入
    const stableKey = computeStableKey(SOURCE_ID, r.fingerprint);
    const itemKey = deriveItemKey(stableKey);

    // 关键：extract 重新抓取拿到的图片 URL 和笔记里记录的旧 URL 在三处不同：
    //   1. CDN 子域名（p3/p9/p11 随机分配）
    //   2. query 参数（?x-signature=...&x-expires=... 每次新签名）
    // 但 URL 里的内容路径 /tos-cn-i-xxx/<hash>~tplv-xxx 是图片唯一标识，稳定不变。
    // 用这个内容路径做匹配，替换笔记里所有该图片的 URL 变体。
    let imgIdx = 0;
    for (const asset of imgAssets) {
      if (!asset.originalUrl) continue;
      // 提取内容路径：/tos-cn-i-xxx/<hash>~tplv-xxx
      const contentPath = asset.originalUrl.match(/\/tos-cn-i-[^/]+\/[^?]+/)?.[0];
      if (!contentPath) continue;

      const placeholder = `\x00IMG${imgIdx}\x00`;
      const before = content;

      // 用内容路径匹配 ![](任意子域名+contentPath+任意query) 形式
      const escaped = contentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // ![](url) / ![](url "title") / ![alt](url...)
      content = content.replace(
        new RegExp(`!\\[[^\\]]*\\]\\(https?://[^)]*${escaped}[^)]*\\)`, "g"),
        placeholder,
      );
      // <img src="url..." HTML 标签形式
      content = content.replace(
        new RegExp(`<img[^>]*src="https?://[^"]*${escaped}[^"]*"[^>]*>`, "g"),
        placeholder,
      );

      if (content === before) {
        // 正文里找不到该图片的任何 URL 变体，跳过这张
        continue;
      }

      const ext = deriveExt(asset.mimeType);
      const filename = `${String(imgIdx + 1).padStart(3, "0")}.${ext}`;
      const relPath = [
        ATTACHMENTS_SUBDIR, SOURCE_ID, itemKey, sanitizeFilename(filename, { maxLength: 200 }),
      ].join("/");

      if (!DRY_RUN) {
        // 写附件
        const absAsset = join(VAULT, relPath);
        mkdirSync(dirname(absAsset), { recursive: true });
        writeFileSync(absAsset, Buffer.from(asset.data));
        assetsWritten++;
      }

      // 替换占位符为 ![[嵌入]]
      content = content.split(placeholder).join(`![[${relPath}]]`);
      imgIdx++;
    }

    if (imgIdx === 0) {
      skipped++;
      continue;
    }

    // 写回笔记（覆盖原文件）
    if (!DRY_RUN) {
      writeFileSync(notePath, content, "utf8");
    }
    ok++;
    if (!DRY_RUN || (idx < 3 || idx % 50 === 0)) {
      console.log(`${progress} id=${r.id} ✓ ${imgIdx}张图 | ${r.relative_path.slice(0, 45)}`);
    }
  } catch (e) {
    failed++;
    const msg = e.message.slice(0, 120);
    errors.push({ id: r.id, msg });
    console.log(`${progress} id=${r.id} ✗ ${msg}`);
  }
}

await source.close?.();
db.close();

console.log(`\n=== 完成 ===`);
console.log(`成功: ${ok}, 跳过(无图/缺文件): ${skipped}, 失败: ${failed}`);
console.log(`附件写入: ${assetsWritten}`);
if (errors.length) {
  console.log(`\n失败明细（前 10）:`);
  for (const e of errors.slice(0, 10)) console.log(`  id=${e.id}: ${e.msg}`);
}

function deriveExt(mime) {
  if (!mime) return "bin";
  const base = mime.split(";")[0].trim().toLowerCase();
  const m = {
    "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png",
    "image/gif": "gif", "image/svg+xml": "svg", "image/bmp": "bmp",
  };
  return m[base] ?? "bin";
}
