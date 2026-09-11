/**
 * macOS 打包辅助脚本：将编译出的 InkMigrate.app 打包为 UDZO 高压缩 DMG 与 ZIP 便携包。
 *
 * 背景：
 * Tauri 默认的 bundle_dmg.sh 使用 create-dmg 并依赖 AppleScript 控制 Finder 窗口。
 * 在无头终端、CI、自动化脚本或无辅助功能权限的终端环境下极易因 AppleScript 权限失败（-1728）。
 * 本脚本直接调用 macOS 原生标准工具：
 * - hdiutil: 快速生成自包含、高压缩 UDZO 镜像（~10秒）
 * - ditto: 生成解压保留所有 Mac 元数据与权限的原生 zip 归档
 * - 计算 SHA256 校验和清单
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { arch, platform } from "node:os";
import { createHash } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE_DIR = join(ROOT, "apps/gui/src-tauri/target/release/bundle");
const APP_PATH = join(BUNDLE_DIR, "macos/InkMigrate.app");
const DMG_DIR = join(BUNDLE_DIR, "dmg");
const MACOS_DIR = join(BUNDLE_DIR, "macos");
const TAURI_CONF = join(ROOT, "apps/gui/src-tauri/tauri.conf.json");

if (platform() !== "darwin") {
  console.log("[package-dmg] 当前系统不是 macOS，跳过 DMG/ZIP 打包。");
  process.exit(0);
}

if (!existsSync(APP_PATH)) {
  console.error(`[package-dmg] 错误: 未找到应用产物: ${APP_PATH}`);
  console.error(`请先执行: pnpm --filter @inkmigrate/gui run tauri build --bundles app`);
  process.exit(1);
}

const tauriConf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
const version = tauriConf.version || "1.0.0";
const targetArch = arch() === "arm64" ? "aarch64" : "x64";

mkdirSync(DMG_DIR, { recursive: true });

const dmgFileName = `InkMigrate_${version}_${targetArch}.dmg`;
const dmgPath = join(DMG_DIR, dmgFileName);
const zipFileName = `InkMigrate_${version}_${targetArch}.zip`;
const zipPath = join(MACOS_DIR, zipFileName);
const checksumFileName = `InkMigrate_${version}_checksums.txt`;
const checksumPath = join(BUNDLE_DIR, checksumFileName);

console.log(`[package-dmg] 开始打包 InkMigrate v${version} (${targetArch})...`);

// 1. 生成 DMG
console.log(`[package-dmg] 正在生成 DMG 镜像...`);
execSync(`hdiutil create -volname "InkMigrate" -srcfolder "${APP_PATH}" -ov -format UDZO "${dmgPath}"`, {
  stdio: "inherit"
});

// 2. 生成 ZIP
console.log(`[package-dmg] 正在生成 ZIP 便携包...`);
execSync(`ditto -c -k --keepParent "${APP_PATH}" "${zipPath}"`, {
  stdio: "inherit"
});

// 3. 计算并输出 SHA256 校验清单
const dmgHash = sha256File(dmgPath);
const zipHash = sha256File(zipPath);
const checksumContent = `${dmgHash}  ${dmgFileName}\n${zipHash}  ${zipFileName}\n`;
writeFileSync(checksumPath, checksumContent, "utf8");

console.log("\n================ 打包成功 ================");
console.log(`DMG: ${dmgPath}`);
console.log(`ZIP: ${zipPath}`);
console.log(`校验和文件: ${checksumPath}`);
console.log("------------------------------------------");
console.log(checksumContent.trim());
console.log("==========================================\n");

function sha256File(filePath) {
  const hash = createHash("sha256");
  const data = readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}
