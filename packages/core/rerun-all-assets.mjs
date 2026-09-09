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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createToutiaoSource } from "../source-toutiao/dist/adapters/adapter.js";
import { profilePath } from "../source-toutiao/dist/auth/profile.js";
import {
  sanitizeFilename,
  deriveItemKey,
  computeStableKey,
} from "./dist/index.js";

// 解析参数（缺值/非整数直接报用法，避免 NaN 静默放大到全量）
const args = process.argv.slice(2);
function parseNonNegativeInt(name) {
  const i = args.indexOf(name);
  if (i < 0) return 0;
  const n = parseInt(args[i + 1], 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} 需要一个非负整数（收到：${args[i + 1]}）`);
  }
  return n;
}
const LIMIT = parseNonNegativeInt("--limit");
const DRY_RUN = args.includes("--dry-run");
const ONLY_ID = parseNonNegativeInt("--only");
// --ids 1,2,3 只跑指定 id 列表（逗号分隔）
const IDS_FILTER = (() => {
  const i = args.indexOf("--ids");
  if (i < 0) return null;
  const raw = args[i + 1];
  if (!raw) throw new Error("--ids 需要逗号分隔的 id 列表，如 --ids 1,2,3");
  const ids = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger);
  if (ids.length === 0) throw new Error(`--ids 未解析出有效 id: ${raw}`);
  return ids;
})();

// 路径可经环境变量覆盖；DB/笔记目录从根路径推导，避免绝对前缀重复。
const STATE_DIR = process.env.INKMIGRATE_STATE_DIR ?? "/Users/hnic/.inkmigrate";
const DB_PATH = process.env.INKMIGRATE_DB_PATH ?? join(STATE_DIR, "inkmigrate.sqlite");
// 笔记在 toutiao/ 子目录，附件在 vault 根的 Attachments/。
// wikilink ![[Attachments/...]] 相对 vault 根，Obsidian 跨子目录能正确解析。
const VAULT = process.env.INKMIGRATE_VAULT ?? "/Users/hnic/Documents/Obsidian";
const NOTES_DIR = join(VAULT, "toutiao");
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
if (IDS_FILTER) {
  query += ` AND si.id IN (${IDS_FILTER.map(() => "?").join(",")})`;
  params.push(...IDS_FILTER);
} else if (ONLY_ID) {
  query += " AND si.id = ?";
  params.push(ONLY_ID);
}
query += " ORDER BY si.id";
if (LIMIT > 0) {
  query += " LIMIT ?";
  params.push(LIMIT);
}

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
  navigationTimeoutMs: 60_000, // 默认 30s 对慢页面不够，延长到 60s
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
    // 只有正文不再残留远程图片 URL 时才视为已完成；部分本地化的笔记必须继续处理，
    // 否则带 x-expires 签名的旧 URL 失效后图片将永久不可访问。
    const hasRemoteImg = /!\[[^\]]*\]\(https?:\/\/[^)]+\)|<img[^>]+src=["']https?:/i.test(content);
    if (!hasRemoteImg) {
      skipped++;
      continue; // 已本地化，跳过
    }

    // extract（含图片下载）—— 对顽固超时的页面重试。
    // ExtractContext 上无标准超时字段，单次超时由 source 内部默认值控制。
    let item;
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // 重试间隔给页面/CDN 冷却。
        if (attempt > 0) await sleep(3000 * attempt);
        item = await source.extract(ref, { config: {}, workspaceDir: STATE_DIR });
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_ATTEMPTS - 1) continue;
      }
    }
    if (item === undefined) throw lastErr;
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
    // e 可能不是 Error（throw lastErr 可能是 undefined），先归一化再截断
    const msg = String(e?.message ?? e).slice(0, 120);
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
