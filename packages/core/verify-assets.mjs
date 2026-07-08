import Database from "better-sqlite3";
import { createToutiaoSource } from "../source-toutiao/dist/adapters/adapter.js";
import { createObsidianTarget } from "../target-obsidian/dist/adapter.js";
import { profilePath } from "../source-toutiao/dist/auth/profile.js";

const db = new Database("/Users/hnic/.inkmigrate/inkmigrate.sqlite");
const stateDir = "/Users/hnic/.inkmigrate";
const vaultPath = "/Users/hnic/Documents/Obsidian";

const rows = db.prepare(
  "SELECT id, canonical_url, original_url, title, content_kind, fingerprint, source_metadata_json FROM source_items WHERE id IN (1154,2993,3578)",
).all();
console.log("待验证样本:", rows.length, "条");

const source = createToutiaoSource({
  sourceInstanceId: "toutiao-main",
  profileDir: profilePath(stateDir, "toutiao-main"),
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

await source.prepare({ config: {}, workspaceDir: stateDir });
console.log("浏览器已启动");

for (const r of rows) {
  console.log("\n=== 处理 id=" + r.id + " ===");
  const ref = {
    sourceInstanceId: "toutiao-main",
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
  try {
    const item = await source.extract(ref, { config: {}, workspaceDir: stateDir });
    const withData = item.assets.filter((a) => a.data).length;
    console.log("extract: quality=" + item.quality + " assets=" + item.assets.length + " 带data=" + withData);
    if (item.assets.length > 0) {
      console.log("  首张图 originalUrl:", item.assets[0].originalUrl?.slice(0, 60));
    }

    const plan = await target.plan(item, targetCtx);
    const oplan = plan;
    console.log("plan: assets清单=" + (oplan.assets?.length ?? 0));
    const hasEmbed = plan.renderedContent.includes("![[Attachments");
    const hasRemote = plan.renderedContent.includes("toutiaoimg") || plan.renderedContent.includes("p3-sign") || plan.renderedContent.includes("p11-sign");
    console.log("  正文含 ![[Attachments 本地嵌入: " + hasEmbed);
    console.log("  正文仍含远程图片URL: " + hasRemote);

    const writeResult = await target.write(plan, targetCtx);
    console.log("write: " + writeResult.relativePath.slice(0, 60));
    if (oplan.assets) {
      for (const a of oplan.assets) {
        console.log("  附件: " + a.relativePath);
      }
    }
    const verify = await target.verify(writeResult, targetCtx);
    console.log("verify: ok=" + verify.ok);
  } catch (e) {
    console.log("失败: " + e.message.slice(0, 250));
  }
}
await source.close?.();
db.close();
console.log("\n=== 验证完成 ===");
