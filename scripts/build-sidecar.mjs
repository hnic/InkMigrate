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
 *     xhr-sync-worker.js  jsdom 运行时 require.resolve 的 worker（bundle 外置）
 *     native/             better_sqlite3.node 等 native 模块
 *     node_modules/       playwright + playwright-core（external 包）
 *     browsers/           Playwright chromium
 *   以及 resources/package.json（core 的 CORE_VERSION 运行时读取目标，
 *   tauri.conf.json 的 bundle.resources 一并打包）
 *
 * 用法：node scripts/build-sidecar.mjs [--skip-node] [--skip-chromium] [--skip-smoke]
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { realpathSync, mkdtempSync } from "node:fs";
import { homedir, platform, arch, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import esbuild from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const SIDECAR_DIR = join(ROOT, "apps/gui/src-tauri/resources/sidecar");
const NODE_DIR = join(SIDECAR_DIR, "node");
const NATIVE_DIR = join(SIDECAR_DIR, "native");
const BROWSERS_DIR = join(SIDECAR_DIR, "browsers");
const NM_DIR = join(SIDECAR_DIR, "node_modules");
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
log("步骤 1/6: 检查 engine dist");
if (!existsSync(join(ROOT, "apps/engine/dist/index.js"))) {
  throw new Error("apps/engine/dist/index.js 不存在，请先运行 pnpm -r run build");
}
log("  ✓ engine dist 存在");

// ── 步骤 2: esbuild bundle engine ──
log("步骤 2/6: esbuild bundle engine");
// 只清理本次会重建的产物；node/ 与 browsers/ 由 --skip-node/--skip-chromium 决定
// 是否重建，整体 rmSync 会把已下载的运行时一并删掉再被 skip 跳过，产出残缺 sidecar
for (const stale of [ENGINE_BUNDLE, NATIVE_DIR, NM_DIR, join(SIDECAR_DIR, "xhr-sync-worker.js")]) {
  rmSync(stale, { recursive: true, force: true });
}
mkdirSync(SIDECAR_DIR, { recursive: true });

// external 的包运行时需要 node_modules 解析，在步骤 3 单独拷贝。
// playwright/playwright-core：chromium 驱动，体积大且有动态加载的子文件。
const EXTERNALS = ["playwright", "playwright-core"];

// jsdom@27 在模块加载期用 fs.readFileSync(path.resolve(__dirname, ...)) 读
// default-stylesheet.css。esbuild 看不见这种运行时读取，打包后 __dirname 指向
// sidecar/，桌面端启动即 ENOENT。构建期把 CSS 内容内联为字符串常量——读的是
// 同一份已安装 jsdom 的同一文件，语义等价，且免去运行时目录布局耦合。
// jsdom@25 用静态 require("../../browser/default-stylesheet")，esbuild 已打入，无需处理。
let inlinedStyleSheets = 0;
function inlineJsdomDefaultStyleSheet() {
  return {
    name: "inline-jsdom-default-stylesheet",
    setup(build) {
      build.onLoad({ filter: /style-rules\.js$/ }, (args) => {
        let src = readFileSync(args.path, "utf8");
        if (!src.includes("default-stylesheet.css")) return undefined;
        const cssPath = resolve(dirname(args.path), "../../browser/default-stylesheet.css");
        const css = readFileSync(cssPath, "utf8");
        const re = /fs\.readFileSync\(\s*path\.resolve\(__dirname,\s*"[^"]*default-stylesheet\.css"\)\s*,\s*\{\s*encoding:\s*"utf-8"\s*\}\s*\)/;
        if (!re.test(src)) {
          throw new Error(
            `${args.path}: 引用了 default-stylesheet.css 但读取表达式与预期不符（jsdom 升级改写?），请同步更新内联插件`,
          );
        }
        src = src.replace(re, JSON.stringify(css));
        inlinedStyleSheets++;
        return { contents: src, loader: "js" };
      });
    },
  };
}

const buildResult = await esbuild.build({
  entryPoints: [join(ROOT, "apps/engine/dist/index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: ENGINE_BUNDLE,
  external: EXTERNALS,
  // CJS 输出里 esbuild 把 import.meta 替换为空对象，core 的
  // createRequire(import.meta.url)('../package.json') 启动即抛 ERR_INVALID_ARG_VALUE。
  // 替换为 CJS 的 __filename 后该 require 相对 bundle 位置解析到
  // resources/package.json——由下方拷贝 + tauri.conf.json 的 bundle.resources 落位
  define: { "import.meta.url": "__filename" },
  plugins: [inlineJsdomDefaultStyleSheet()],
  logLevel: "warning",
});
if (buildResult.errors.length > 0 || !existsSync(ENGINE_BUNDLE)) throw new Error("engine bundle 生成失败");
if (inlinedStyleSheets === 0) {
  throw new Error("default-stylesheet.css 未被内联：依赖图里没有匹配的 jsdom style-rules.js，请检查内联插件");
}
log(`  ✓ engine bundle (${du(ENGINE_BUNDLE)}, 内联 default-stylesheet ×${inlinedStyleSheets})`);

// core 在模块加载期读取 ../package.json 校验并导出 CORE_VERSION；bundle 化后
// 该相对路径落在 resources/（sidecar 上一级），必须拷贝过去并让 Tauri 打包，
// 否则桌面端启动即崩（fast-fail 抛 MODULE_NOT_FOUND）
const CORE_PKG_DEST = join(SIDECAR_DIR, "..", "package.json");
cpSync(join(ROOT, "packages/core/package.json"), CORE_PKG_DEST);
log(`  ✓ packages/core/package.json → resources/package.json`);

// ── 步骤 3: 拷贝 native 模块 + playwright（external 依赖） ──
log("步骤 3/6: 拷贝 native 模块 + playwright");

// 找 better_sqlite3.node
const sqliteNode = findFile(join(ROOT, "node_modules/.pnpm"), "better_sqlite3.node");
if (!sqliteNode) throw new Error("better_sqlite3.node 未找到");
mkdirSync(NATIVE_DIR, { recursive: true });
cpSync(sqliteNode, join(NATIVE_DIR, "better_sqlite3.node"), { recursive: true });
log(`  ✓ better_sqlite3.node → native/`);

// 拷贝 external 包（运行时需要 node_modules 解析）
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
  log("步骤 4/6: 获取 Node 二进制");
  rmSync(NODE_DIR, { recursive: true, force: true });
  fetchNodeBinary(NODE_DIR, PLATFORM, ARCH);
} else {
  log("步骤 4/6: 跳过 Node 二进制 (--skip-node)");
}

// ── 步骤 5: 获取 chromium ──
if (!SKIP_CHROMIUM) {
  log("步骤 5/6: 获取 Playwright chromium");
  rmSync(BROWSERS_DIR, { recursive: true, force: true });
  fetchChromium(BROWSERS_DIR, PLATFORM);
} else {
  log("步骤 5/6: 跳过 chromium (--skip-chromium)");
}

// ── 步骤 6: sidecar 启动冒烟 ──
// engine bundle 曾出现“构建成功、桌面端启动即崩”（import.meta 空对象、jsdom
// 运行时资产路径逃逸）。用打包的 node + 生产 env 契约真正启动一次并发一条
// RPC，把这类只在运行时暴露的回归拦截在构建期。
const nodeBinRel = PLATFORM === "win32" ? join("node", "node.exe") : join("node", "bin", "node");
if (args.includes("--skip-smoke") || !existsSync(join(SIDECAR_DIR, nodeBinRel))) {
  log("步骤 6/6: 跳过 sidecar 冒烟（--skip-smoke 或 node 二进制不存在）");
} else {
  log("步骤 6/6: sidecar 启动冒烟（auth.status RPC）");
  await smokeTestSidecar();
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

/**
 * 启动冒烟：复刻 sidecar.rs 的生产启动契约（打包 node + env 注入），发一条
 * auth.status RPC 并等待 id=1 的 JSON-RPC 响应。任何模块加载期崩溃（import.meta、
 * 运行时资产路径）都会在此以非零码暴露，而不是等到用户桌面。
 */
function smokeTestSidecar() {
  return new Promise((resolvePromise, reject) => {
    const nodeBin = join(SIDECAR_DIR, nodeBinRel);
    const stateDir = mkdtempSync(join(tmpdir(), "inkmigrate-smoke-"));
    const child = spawn(nodeBin, ["--max-old-space-size=8192", ENGINE_BUNDLE], {
      env: {
        ...process.env,
        BETTER_SQLITE3_BINDING: join(NATIVE_DIR, "better_sqlite3.node"),
        PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rmSync(stateDir, { recursive: true, force: true });
      err ? reject(err) : resolvePromise();
    };
    const timer = setTimeout(
      () => finish(new Error(`sidecar 冒烟超时（20s）无 RPC 响应。stdout: ${out.trim() || "(空)"}`)),
      20_000,
    );
    child.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const res = JSON.parse(trimmed);
          if (res.id === 1) {
            if (res.error) {
              return finish(new Error(`sidecar 冒烟 RPC 返回错误: ${JSON.stringify(res.error)}`));
            }
            if (res.result !== undefined) {
              log(`  ✓ RPC 响应到达: ${trimmed.slice(0, 120)}`);
              return finish(null);
            }
          }
        } catch { /* 半行输出，继续等 */ }
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[smoke/stderr] ${d}`));
    child.on("error", finish);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "auth.status", params: { source: "toutiao", stateDir } }) + "\n",
    );
    // stdin EOF 后 engine 会自然退出；kill 兜底处理仍在运行的定时器
    child.stdin.end();
  });
}

function findFile(dir, name) {
  try {
    const out = execSync(`find "${dir}" -name "${name}" 2>/dev/null`, { encoding: "utf8" });
    const hits = out.trim().split("\n").filter(Boolean);
    if (hits.length === 0) return null;
    if (hits.length === 1) return hits[0];
    // .pnpm 会并存多版本副本（如 jsdom@25/@27 各带一份 xhr-sync-worker.js，
    // 两个源适配器的生产依赖同时打进 engine）。字节级相同（SHA-256 一致）的
    // 多副本打包任意一份都正确；只有内容不同才存在“选错版本”的歧义
    // （如不同 ABI 的 better_sqlite3.node），必须显式失败由人工按 lockfile 精确选择
    const hashes = hits.map((h) => sha256File(h));
    if (new Set(hashes).size !== 1) {
      throw new Error(`${name} 命中多个内容不同的路径，无法确定打包哪一份:\n${hits.join("\n")}`);
    }
    return hits[0];
  } catch (e) {
    if (e instanceof Error && String(e.message).includes("无法确定打包哪一份")) throw e;
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
