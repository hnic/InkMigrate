import Database from "better-sqlite3";
import { createToutiaoSource } from "../source-toutiao/dist/adapters/adapter.js";
import { createObsidianTarget } from "../target-obsidian/dist/adapter.js";
import { profilePath } from "../source-toutiao/dist/auth/profile.js";

// 路径与样本可经环境变量覆盖，脚本本身不绑定某一台机器。
const stateDir = process.env.INKMIGRATE_STATE_DIR ?? "/Users/hnic/.inkmigrate";
const vaultPath = process.env.INKMIGRATE_VAULT ?? "/Users/hnic/Documents/Obsidian";
const dbPath = process.env.INKMIGRATE_DB_PATH ?? `${stateDir}/inkmigrate.sqlite`;
const sampleIds = (process.env.VERIFY_SAMPLE_IDS ?? "1154,2993,3578")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Number.isInteger);
if (sampleIds.length === 0) {
  throw new Error(`VERIFY_SAMPLE_IDS 未解析出有效 id: ${process.env.VERIFY_SAMPLE_IDS}`);
}
const SOURCE_ID = "toutiao-main";

const db = new Database(dbPath);
const rows = db.prepare(
  `SELECT id, canonical_url, original_url, title, content_kind, fingerprint, source_metadata_json
   FROM source_items WHERE id IN (${sampleIds.map(() => "?").join(",")})`,
).all(...sampleIds);
console.log("待验证样本:", rows.length, "条");

const source = createToutiaoSource({
  sourceInstanceId: SOURCE_ID,
  profileDir: profilePath(stateDir, SOURCE_ID),
  headless: false,
});
const target = createObsidianTarget();
const targetCtx = {
  config: {},
  workspaceDir: stateDir,
  vaultPath,
  targetConfig: {
    vaultPath,
    importSubdir: "",
    attachmentsSubdir: "Attachments",
    linkStyle: "wikilink",
    overwritePolicy: "preserve",
    collectionMapping: { toTags: false, toFolders: false },
    maxFilenameLength: 100,
  },
};

function safeParseJson(s) {
  if (typeof s !== "string") return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

let failures = 0;
try {
  await source.prepare({ config: {}, workspaceDir: stateDir });
  console.log("浏览器已启动");

  for (const r of rows) {
    console.log("\n=== 处理 id=" + r.id + " ===");
    try {
      const ref = {
        sourceInstanceId: SOURCE_ID,
        canonicalUrl: r.canonical_url,
        originalUrl: r.original_url ?? r.canonical_url,
        title: r.title,
        contentKind: r.content_kind,
        discoveredAt: new Date().toISOString(),
        fingerprint: r.fingerprint,
        sourceMetadata: safeParseJson(r.source_metadata_json),
      };
      const item = await source.extract(ref, { config: {}, workspaceDir: stateDir });
      const withData = item.assets.filter((a) => a.data).length;
      console.log("extract: quality=" + item.quality + " assets=" + item.assets.length + " 带data=" + withData);
      if (item.assets.length > 0) {
        console.log("  首张图 originalUrl:", item.assets[0].originalUrl?.slice(0, 60));
      }

      const plan = await target.plan(item, targetCtx);
      console.log("plan: assets清单=" + (plan.assets?.length ?? 0));
      const hasEmbed = plan.renderedContent.includes("![[Attachments");
      const hasRemote = plan.renderedContent.includes("toutiaoimg") || plan.renderedContent.includes("p3-sign") || plan.renderedContent.includes("p11-sign");
      console.log("  正文含 ![[Attachments 本地嵌入: " + hasEmbed);
      console.log("  正文仍含远程图片URL: " + hasRemote);

      if (process.env.VERIFY_ALLOW_WRITE !== "1") {
        console.log("  跳过写入（dry-run）。设置 VERIFY_ALLOW_WRITE=1 以启用真实写入。");
        continue;
      }
      const writeResult = await target.write(plan, targetCtx);
      console.log("write: " + writeResult.relativePath.slice(0, 60));
      if (plan.assets) {
        for (const a of plan.assets) {
          console.log("  附件: " + a.relativePath);
        }
      }
      const verify = await target.verify(writeResult, targetCtx);
      console.log("verify: ok=" + verify.ok);
      if (!verify.ok) failures++;
    } catch (e) {
      failures++;
      console.log("失败: " + String(e?.stack ?? e).slice(0, 400));
    }
  }
} finally {
  await source.close?.();
  db.close();
}
console.log("\n=== 验证完成 ===");
if (failures > 0) process.exitCode = 1;
