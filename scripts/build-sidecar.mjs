/**
 * 构建 sidecar 资源目录（Node runtime + engine bundle + native + chromium）。
 *
 * 方案：esbuild 把 engine + 所有 JS 依赖 bundle 成单文件（7.5MB），native 模块
 *（better_sqlite3.node）和 playwright（chromium 驱动）单独带。运行时用环境变量
 * BETTER_SQLITE3_BINDING 和 PLAYWRIGHT_BROWSERS_PATH 定位。
 *
 * 产出 apps/gui/src-tauri/resources/sidecar/：
 *   sidecar/
 *     node/bin/node       平台对应 Node 二进制
 *     engine-bundle.cjs   esbuild 打包的 engine 单文件
 *     native/             better_sqlite3.node 等 native 模块
 *     node_modules/       playwright + playwright-core（external 包）
 *     browsers/           Playwright chromium
 *
 * 用法：node scripts/build-sidecar.mjs [--skip-node] [--skip-chromium]
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { createHash } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "..");
const SIDECAR_DIR = join(ROOT, "apps/gui/src-tauri/resources/sidecar");
const NODE_DIR = join(SIDECAR_DIR, "node");
const NATIVE_DIR = join(SIDECAR_DIR, "native");
const BROWSERS_DIR = join(SIDECAR_DIR, "browsers");
const ENGINE_BUNDLE = join(SIDECAR_DIR, "engine-bundle.cjs");

const args = process.argv.slice(2);
const SKIP_NODE = args.includes("--skip-node");
const SKIP_CHROMIUM = args.includes("--skip-chromium");

const PLATFORM = platform();
const ARCH = arch();

function log(msg) { console.log(`[build-sidecar] ${msg}`); }
function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}
function du(path) {
  try { return execSync(`du -sh "${path}" 2>/dev/null`, { encoding: "utf8" }).split("\t")[0].trim(); }
  catch { return "?"; }
}

// ── 步骤 1: 确保 engine + packages 最新 build ──
log("步骤 1/5: 检查 engine dist");
if (!existsSync(join(ROOT, "apps/engine/dist/index.js"))) {
  throw new Error("apps/engine/dist/index.js 不存在，请先运行 pnpm -r run build");
}
log("  ✓ engine dist 存在");

// ── 步骤 2: esbuild bundle engine ──
log("步骤 2/5: esbuild bundle engine");
// 只清理本次会重建的产物；node/ 与 browsers/ 由 --skip-node/--skip-chromium 决定
// 是否重建，整体 rmSync 会把已下载的运行时一并删掉再被 skip 跳过，产出残缺 sidecar
for (const stale of [ENGINE_BUNDLE, NATIVE_DIR, NM_DIR, join(SIDECAR_DIR, "xhr-sync-worker.js")]) {
  rmSync(stale, { recursive: true, force: true });
}
mkdirSync(SIDECAR_DIR, { recursive: true });

// external 的包运行时需要 node_modules 解析，在步骤 3 单独拷贝。
// playwright/playwright-core：chromium 驱动，体积大且有动态加载的子文件。
const EXTERNALS = ["playwright", "playwright-core"];
run(
  `npx esbuild apps/engine/dist/index.js` +
  ` --bundle --platform=node --format=cjs` +
  ` --outfile="${ENGINE_BUNDLE}"` +
  ` ${EXTERNALS.map((p) => `--external:${p}`).join(" ")}` +
  ` --log-level=warning`,
);
if (!existsSync(ENGINE_BUNDLE)) throw new Error("engine bundle 生成失败");
log(`  ✓ engine bundle (${du(ENGINE_BUNDLE)})`);

// ── 步骤 3: 拷贝 native 模块 + playwright（external 依赖） ──
log("步骤 3/5: 拷贝 native 模块 + playwright");

// 找 better_sqlite3.node
const sqliteNode = findFile(join(ROOT, "node_modules/.pnpm"), "better_sqlite3.node");
if (!sqliteNode) throw new Error("better_sqlite3.node 未找到");
mkdirSync(NATIVE_DIR, { recursive: true });
cpSync(sqliteNode, join(NATIVE_DIR, "better_sqlite3.node"), { recursive: true });
log(`  ✓ better_sqlite3.node → native/`);

// 拷贝 external 包（运行时需要 node_modules 解析）
const NM_DIR = join(SIDECAR_DIR, "node_modules");
mkdirSync(NM_DIR, { recursive: true });
for (const pkg of EXTERNALS) {
  const src = findDir(join(ROOT, "node_modules/.pnpm"), pkg);
  // bundle 以 --external 引用这些包，缺失则 sidecar 运行时必然无法解析——
  // 静默跳过只会把失败推迟到用户桌面，这里直接失败
  if (!src) throw new Error(`external 依赖 ${pkg} 未找到，engine bundle 运行时将无法解析`);
  const dest = join(NM_DIR, pkg);
  cpSync(src, dest, { recursive: true });
  log(`  ✓ ${pkg} → node_modules/${pkg} (${du(dest)})`);
}

// jsdom 被 esbuild bundle 进去了，但它用 require.resolve("./xhr-sync-worker.js")
// 动态加载 worker 文件——esbuild 无法静态分析，需单独拷到 bundle 同目录。
const xhrWorker = findFile(join(ROOT, "node_modules/.pnpm"), "xhr-sync-worker.js");
if (!xhrWorker) throw new Error("xhr-sync-worker.js 未找到（bundle 内 jsdom 运行时必需）");
cpSync(xhrWorker, join(SIDECAR_DIR, "xhr-sync-worker.js"));
log(`  ✓ xhr-sync-worker.js → sidecar/`);

// ── 步骤 4: 获取 Node 二进制 ──
if (!SKIP_NODE) {
  log("步骤 4/5: 获取 Node 二进制");
  rmSync(NODE_DIR, { recursive: true, force: true });
  fetchNodeBinary(NODE_DIR, PLATFORM, ARCH);
} else {
  log("步骤 4/5: 跳过 Node 二进制 (--skip-node)");
}

// ── 步骤 5: 获取 chromium ──
if (!SKIP_CHROMIUM) {
  log("步骤 5/5: 获取 Playwright chromium");
  rmSync(BROWSERS_DIR, { recursive: true, force: true });
  fetchChromium(BROWSERS_DIR, PLATFORM);
} else {
  log("步骤 5/5: 跳过 chromium (--skip-chromium)");
}

// ── 汇总 ──
log("\n=== sidecar 资源就绪 ===");
log(`  engine-bundle:  ${du(ENGINE_BUNDLE)}`);
log(`  native:         ${du(NATIVE_DIR)}`);
if (existsSync(NM_DIR)) log(`  node_modules:   ${du(NM_DIR)}  (playwright)`);
if (existsSync(NODE_DIR)) log(`  node:           ${du(NODE_DIR)}  (${PLATFORM}/${ARCH})`);
if (existsSync(BROWSERS_DIR)) log(`  browsers:       ${du(BROWSERS_DIR)}`);
log(`  总计:           ${du(SIDECAR_DIR)}`);

// ── 辅助函数 ──

function findFile(dir, name) {
  try {
    const out = execSync(`find "${dir}" -name "${name}" 2>/dev/null`, { encoding: "utf8" });
    const hits = out.trim().split("\n").filter(Boolean);
    if (hits.length === 0) return null;
    // .pnpm 可能并存多版本/多 ABI 副本（多个消费者），文件序取第一个会静默
    // 打包错误版本——多命中时必须显式失败，由人工按 lockfile 精确选择
    if (hits.length > 1) {
      throw new Error(`${name} 命中多个路径，无法确定打包哪一份:\n${hits.join("\n")}`);
    }
    return hits[0];
  } catch (e) {
    if (e instanceof Error && String(e.message).includes("命中多个路径")) throw e;
    return null;
  }
}

function findDir(pnpmDir, pkgName) {
  // 优先跟随 workspace 顶层软链（realpath）：天然选中 lockfile 解析的版本，
  // 含 patchedDependencies 补丁实例（目录名带 patch_hash，按前缀扫描会漏选）
  const topLevel = join(ROOT, "node_modules", pkgName);
  if (existsSync(topLevel)) {
    try { return realpathSync(topLevel); } catch { /* 落到 .pnpm 扫描 */ }
  }
  try {
    const entries = readdirSync(pnpmDir);
    const match = entries.find(e => e.startsWith(`${pkgName}@`));
    if (match) {
      // 真实包在 .pnpm/<pkg>@<ver>/node_modules/<pkg>/
      const pkgDir = join(pnpmDir, match, "node_modules", pkgName);
      if (existsSync(pkgDir)) return pkgDir;
    }
  } catch {}
  return null;
}

/**
 * 供应链安全校验：下载 nodejs.org 官方 SHASUMS256.txt，提取目标文件的期望 SHA256，
 * 与本地文件实际哈希比对。不匹配则抛错中止构建（防止被篡改的 Node 二进制打包进应用）。
 */
function verifySha256(filePath, fileName, shasumsUrl) {
  log(`  校验 SHA256 (${fileName})...`);
  // 下载 SHASUMS256.txt 到内存（不走磁盘，避免残留）
  const shasums = execSync(`curl -fsSL "${shasumsUrl}"`, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  // 行格式：<64位hex>  <filename>
  const re = new RegExp(`^([0-9a-f]{64})\\s+\\*?${escapeRegex(fileName)}$`, "m");
  const m = re.exec(shasums);
  if (!m) {
    throw new Error(`SHASUMS256.txt 未找到 ${fileName} 的条目（${shasumsUrl}），拒绝继续：可能版本不存在或清单被篡改`);
  }
  const expected = m[1].toLowerCase();
  const actual = sha256File(filePath).toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `SHA256 校验失败：${fileName}\n  期望: ${expected}\n  实际: ${actual}\n下载文件可能被篡改，拒绝打包。`,
    );
  }
  log(`  ✓ SHA256 校验通过`);
}

function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fetchNodeBinary(targetDir, plat, archName) {
  // 固定 sidecar 内置 Node 版本（与 .nvmrc 同源），避免随构建机版本漂移导致
  // 产物不可复现；SIDECAR_NODE_VERSION 可临时覆盖
  const nodeVersion = process.env.SIDECAR_NODE_VERSION
    ?? readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
  let platformStr, archiveName;
  if (plat === "darwin") {
    platformStr = archName === "arm64" ? "darwin-arm64" : "darwin-x64";
    archiveName = `node-v${nodeVersion}-${platformStr}.tar.gz`;
  } else if (plat === "win32") {
    platformStr = "win-x64";
    archiveName = `node-v${nodeVersion}-${platformStr}.zip`;
  } else {
    throw new Error(`不支持的平台: ${plat}`);
  }

  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
  const shasumsUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
  log(`  下载 ${url}`);
  mkdirSync(targetDir, { recursive: true });
  const archivePath = join(targetDir, archiveName);
  run(`curl -fSL "${url}" -o "${archivePath}"`);

  // 供应链安全：用 nodejs.org 官方 SHASUMS256.txt 校验下载的 archive，
  // 防止 CDN 投毒/MITM 在打包进桌面应用前嵌入被篡改的 Node 二进制。
  verifySha256(archivePath, archiveName, shasumsUrl);

  if (plat === "darwin") {
    run(`tar xzf "${archivePath}" -C "${targetDir}"`);
    rmSync(archivePath, { force: true });
    const extracted = join(targetDir, `node-v${nodeVersion}-${platformStr}`);
    // 只保留 node 二进制（npm/corepack 不需要）
    mkdirSync(join(targetDir, "bin"), { recursive: true });
    cpSync(join(extracted, "bin/node"), join(targetDir, "bin/node"));
    rmSync(extracted, { recursive: true });
    run(`chmod +x "${join(targetDir, "bin/node")}"`);
  } else if (plat === "win32") {
    // Windows 10+ 自带 bsdtar（tar 可直接解压 zip）；不要依赖不存在的 unzip，
    // 也不要用 `cd && ...` 拼接（会丢弃 run() 的 cwd 选项）
    run(`tar -xf "${archivePath}" -C "${targetDir}"`);
    rmSync(archivePath, { force: true });
    const extracted = join(targetDir, `node-v${nodeVersion}-${platformStr}`);
    cpSync(join(extracted, "node.exe"), join(targetDir, "node.exe"));
    rmSync(extracted, { recursive: true });
  }
  log(`  ✓ Node ${nodeVersion} (${platformStr}) 就绪`);
}

function fetchChromium(targetDir, plat) {
  // Playwright 各平台浏览器缓存位置不同（win32 用 %LOCALAPPDATA%，非 ~/.cache）
  let cacheDir;
  if (plat === "darwin") {
    cacheDir = join(homedir(), "Library/Caches/ms-playwright");
  } else if (plat === "win32") {
    cacheDir = join(homedir(), "AppData/Local/ms-playwright");
  } else {
    cacheDir = join(homedir(), ".cache/ms-playwright");
  }

  // 从 workspace 里 playwright-core 的 browsers.json 读出期望的 chromium revision。
  // playwright 驱动运行时只认它自己 browsers.json 声明的 revision（如 chromium-1228），
  // 缓存里若有多份旧版（1208/1217），"取第一个" 会拷错版本导致运行时报
  // "Executable doesn't exist"。这里精确匹配当前 playwright-core 要求的 revision。
  const pwCore = findDir(join(ROOT, "node_modules/.pnpm"), "playwright-core");
  if (!pwCore) throw new Error("playwright-core 未找到，无法确定 chromium revision");
  const browsersJson = JSON.parse(readFileSync(join(pwCore, "browsers.json"), "utf8"));
  const expectedRev = browsersJson.browsers.find(b => b.name === "chromium")?.revision;
  if (!expectedRev) throw new Error(`playwright-core browsers.json 未声明 chromium revision`);
  const expectedDirName = `chromium-${expectedRev}`;
  const expectedDir = join(cacheDir, expectedDirName);
  // Playwright v1.49+ 默认 headless 启动解析 chromium_headless_shell-<rev> 而非
  // chromium-<rev>，只带 chromium 目录会精确复现上方注释警告的
  // "Executable doesn't exist"——两者需一起入 sidecar
  const headlessShellDirName = `chromium_headless_shell-${expectedRev}`;
  const headlessShellDir = join(cacheDir, headlessShellDirName);
  log(`  期望 chromium revision: ${expectedRev}（来自 ${pwCore}）`);

  // 缓存里恰好有匹配 revision 的目录 → 直接复用
  if (existsSync(expectedDir)) {
    log(`  复用缓存 ${expectedDir}`);
  } else {
    log(`  缓存未找到 ${expectedDirName}，用 npx playwright install chromium 下载正确的 ${expectedRev}...`);
    run(`npx playwright install chromium`);
    if (!existsSync(expectedDir)) {
      throw new Error(`playwright install 后仍未找到 ${expectedDirName}`);
    }
  }
  mkdirSync(targetDir, { recursive: true });
  cpSync(expectedDir, join(targetDir, expectedDirName), { recursive: true });
  log(`  ✓ chromium ${expectedDirName} 就绪 (${du(join(targetDir, expectedDirName))})`);
  if (existsSync(headlessShellDir)) {
    cpSync(headlessShellDir, join(targetDir, headlessShellDirName), { recursive: true });
    log(`  ✓ ${headlessShellDirName} 就绪 (${du(join(targetDir, headlessShellDirName))})`);
  } else {
    log(`  ⚠ 缓存无 ${headlessShellDirName}（旧版 playwright 无此目录），headless 启动可能不可用`);
  }
}
