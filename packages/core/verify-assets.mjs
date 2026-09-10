import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
// 直接引用各包 dist 产物：运行前确保已构建最新代码，否则验证的是过期编译结果
// （pnpm --filter source-toutiao --filter target-obsidian build）。
import { createToutiaoSource } from "../source-toutiao/dist/adapters/adapter.js";
import { createObsidianTarget } from "../target-obsidian/dist/adapter.js";
import { profilePath } from "../source-toutiao/dist/auth/profile.js";

// 路径与样本可经环境变量覆盖，脚本本身不绑定某一台机器（默认值从当前用户主目录推导）。
const stateDir = process.env.INKMIGRATE_STATE_DIR ?? path.join(os.homedir(), ".inkmigrate");
const vaultPath = process.env.INKMIGRATE_VAULT ?? path.join(os.homedir(), "Documents", "Obsidian");
const dbPath = process.env.INKMIGRATE_DB_PATH ?? `${stateDir}/inkmigrate.sqlite`;
const sampleIds = (process.env.VERIFY_SAMPLE_IDS ?? "1154,2993,3578")
  .split(",")
  .map((s) => Number(s.trim()))
  // 过滤正整数：Number("") === 0 会让尾随逗号把 id=0 混进 IN 查询
  .filter((n) => Number.isInteger(n) && n > 0);
if (sampleIds.length === 0) {
  throw new Error(`VERIFY_SAMPLE_IDS 未解析出有效 id: ${process.env.VERIFY_SAMPLE_IDS}`);
}
const SOURCE_ID = "toutiao-main";

const db = new Database(dbPath);
const rows = db.prepare(
  `SELECT id, canonical_url, original_url, title, content_kind, fingerprint, discovered_at, source_metadata_json
   FROM source_items WHERE id IN (${sampleIds.map(() => "?").join(",")})`,
).all(...sampleIds);
console.log("待验证样本:", rows.length, "条");
// 样本覆盖检查：选错 DB / 状态目录陈旧 / id 已删除时，IN 查询会静默少返回行，
// 少干活仍然退出码 0，"通过"就不再证明样本被验证过——直接失败。
const foundIds = new Set(rows.map((r) => r.id));
const missing = sampleIds.filter((id) => !foundIds.has(id));
if (missing.length > 0) {
  throw new Error(`以下样本 id 不存在于 source_items: ${missing.join(",")}`);
}

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

// 解析失败计入失败总数：本脚本的目的就是暴露数据/管线问题，
// 静默降级为 {} 会把 DB 里的元数据损坏伪装成"无元数据"。
function safeParseJson(s, id) {
  if (typeof s !== "string") return {};
  try {
    return JSON.parse(s);
  } catch (e) {
    failures++;
    console.log(`id=${id} source_metadata_json 解析失败: ${e?.message ?? e}`);
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
        // 用 DB 里持久化的真实发现时间，保证验证跑的 ref 与原始迁移一致
        discoveredAt: r.discovered_at ?? new Date().toISOString(),
        fingerprint: r.fingerprint,
        sourceMetadata: safeParseJson(r.source_metadata_json, r.id),
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
      // 断言而非仅打印：有资产的条目若正文缺本地嵌入或仍含远程 URL，
      // 说明本地化失败，计入失败（否则脚本白跑也退出码 0）。
      if (item.assets.length > 0 && (!hasEmbed || hasRemote)) {
        failures++;
        console.log("  断言失败: 本地嵌入=" + hasEmbed + ", 遗留远程URL=" + hasRemote);
      }

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
