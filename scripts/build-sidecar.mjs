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
 *     engine-bundle.mjs   esbuild 打包的 engine 单文件
 *     native/             better_sqlite3.node 等 native 模块
 *     node_modules/       playwright + playwright-core（external 包）
 *     browsers/           Playwright chromium
 *
 * 用法：node scripts/build-sidecar.mjs [--skip-node] [--skip-chromium]
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform, arch } from "node:os";

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
rmSync(SIDECAR_DIR, { recursive: true, force: true });
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
  if (src) {
    const dest = join(NM_DIR, pkg);
    cpSync(src, dest, { recursive: true });
    log(`  ✓ ${pkg} → node_modules/${pkg} (${du(dest)})`);
  }
}

// jsdom 被 esbuild bundle 进去了，但它用 require.resolve("./xhr-sync-worker.js")
// 动态加载 worker 文件——esbuild 无法静态分析，需单独拷到 bundle 同目录。
const xhrWorker = findFile(join(ROOT, "node_modules/.pnpm"), "xhr-sync-worker.js");
if (xhrWorker) {
  cpSync(xhrWorker, join(SIDECAR_DIR, "xhr-sync-worker.js"));
  log(`  ✓ xhr-sync-worker.js → sidecar/`);
}

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
    return out.trim().split("\n")[0] || null;
  } catch { return null; }
}

function findDir(pnpmDir, pkgName) {
  // 在 .pnpm 里找 playwright-core@xxx 或 playwright@xxx 目录
  try {
    const entries = readdirSync(pnpmDir);
    const match = entries.find(e => e.startsWith(`${pkgName}@`) && !e.includes("patch_"));
    if (match) {
      // 真实包在 .pnpm/<pkg>@<ver>/node_modules/<pkg>/
      const pkgDir = join(pnpmDir, match, "node_modules", pkgName);
      if (existsSync(pkgDir)) return pkgDir;
    }
  } catch {}
  return null;
}

/**
 * 从 pnpm 的 .pnpm 虚拟存储拷贝一个包及其所有传递依赖到扁平 node_modules。
 * 用于处理 jsdom 这类有大量子依赖的包。
 */
function copyPnpmDeps(nmDest, pnpmDir, pkgName) {
  // 找 .pnpm 里这个包的目录
  const entries = readdirSync(pnpmDir);
  const match = entries.find(e => e.startsWith(`${pkgName}@`) && !e.includes("patch_"));
  if (!match) return;
  // 该包在 .pnpm/<match>/node_modules/ 下列出了所有依赖
  const depsDir = join(pnpmDir, match, "node_modules");
  if (!existsSync(depsDir)) return;
  // 拷贝所有依赖（包括 scoped 包）
  for (const scope of readdirSync(depsDir)) {
    const scopePath = join(depsDir, scope);
    if (lstatSync(scopePath).isDirectory()) {
      if (scope.startsWith("@")) {
        // scoped 包：@scope/pkg
        const scopeDest = join(nmDest, scope);
        mkdirSync(scopeDest, { recursive: true });
        for (const pkg of readdirSync(scopePath)) {
          const pkgSrc = join(scopePath, pkg);
          const pkgDest = join(scopeDest, pkg);
          if (!existsSync(pkgDest)) {
            cpSync(pkgSrc, pkgDest, { recursive: true });
          }
        }
      } else if (!existsSync(join(nmDest, scope))) {
        // 普通包
        cpSync(scopePath, join(nmDest, scope), { recursive: true });
      }
    }
  }
  // 也拷 jsdom 自己
  const pkgSrc = join(depsDir, pkgName);
  if (existsSync(pkgSrc) && !existsSync(join(nmDest, pkgName))) {
    cpSync(pkgSrc, join(nmDest, pkgName), { recursive: true });
  }
}

function fetchNodeBinary(targetDir, plat, archName) {
  const nodeVersion = process.version.replace("v", "");
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
  log(`  下载 ${url}`);
  mkdirSync(targetDir, { recursive: true });
  const archivePath = join(targetDir, archiveName);

  if (plat === "darwin") {
    run(`curl -fSL "${url}" -o "${archivePath}"`);
    run(`tar xzf "${archivePath}" -C "${targetDir}"`);
    rmSync(archivePath, { force: true });
    const extracted = join(targetDir, `node-v${nodeVersion}-${platformStr}`);
    // 只保留 node 二进制（npm/corepack 不需要）
    mkdirSync(join(targetDir, "bin"), { recursive: true });
    cpSync(join(extracted, "bin/node"), join(targetDir, "bin/node"));
    rmSync(extracted, { recursive: true });
    run(`chmod +x "${join(targetDir, "bin/node")}"`);
  } else if (plat === "win32") {
    run(`curl -fSL "${url}" -o "${archivePath}"`);
    run(`cd "${targetDir}" && unzip -o "${archiveName}"`);
    rmSync(archivePath, { force: true });
    const extracted = join(targetDir, `node-v${nodeVersion}-${platformStr}`);
    cpSync(join(extracted, "node.exe"), join(targetDir, "node.exe"));
    rmSync(extracted, { recursive: true });
  }
  log(`  ✓ Node ${nodeVersion} (${platformStr}) 就绪`);
}

function fetchChromium(targetDir, plat) {
  const cacheDir = plat === "darwin"
    ? join(homedir(), "Library/Caches/ms-playwright")
    : join(homedir(), ".cache/ms-playwright");

  // 从 workspace 里 playwright-core 的 browsers.json 读出期望的 chromium revision。
  // playwright 驱动运行时只认它自己 browsers.json 声明的 revision（如 chromium-1228），
  // 缓存里若有多份旧版（1208/1217），"取第一个" 会拷错版本导致运行时报
  // "Executable doesn't exist"。这里精确匹配当前 playwright-core 要求的 revision。
  const pwCore = findDir(join(ROOT, "node_modules/.pnpm"), "playwright-core");
  if (!pwCore) throw new Error("playwright-core 未找到，无法确定 chromium revision");
  const browsersJson = JSON.parse(readFileSync(join(pwCore, "browsers.json"), "utf8"));
  const expectedRev = browsersJson.browsers
    .find(b => b.name === "chromium" && !b.name.includes("headless_shell"))?.revision;
  if (!expectedRev) throw new Error(`playwright-core browsers.json 未声明 chromium revision`);
  const expectedDirName = `chromium-${expectedRev}`;
  const expectedDir = join(cacheDir, expectedDirName);
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
}
