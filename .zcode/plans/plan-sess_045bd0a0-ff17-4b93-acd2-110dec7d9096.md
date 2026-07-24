# InkMigrate 桌面应用生产打包方案

## 目标
把 Tauri GUI + Node sidecar + Playwright chromium 打成可分发的安装包（macOS arm64/x86_64 + Windows），用户无需安装 Node.js。

## 方案：全量 resources（零 JS 改动）

把以下资源原样塞进 Tauri `bundle.resources`，Rust 侧用 `resource_dir()` 定位绝对路径启动：

| 资源 | 体积 | 说明 |
|---|---|---|
| Node 二进制 | ~100MB | 平台专属，按 target-triple 选 |
| engine runtime（dist + node_modules） | ~150MB | `pnpm deploy` 解析软链接后的物理目录 |
| Playwright chromium | ~344MB | `PLAYWRIGHT_BROWSERS_PATH` 重定向 |
| **合计** | **~600MB** | 包体大但零 native loader 风险 |

**为什么选这个方案**：better-sqlite3 用 `require('bindings')` 靠 `__dirname` 遍历找 `.node`。SEA/pkg 会破坏这个机制，全量 resources 保留原始目录结构，`.node` 能被正常发现，**不需要改任何 JS 代码**。

## 实施步骤（8 步）

### 步骤 1：打包脚本 `scripts/build-sidecar.mjs`
核心脚本，在 `tauri build` 之前运行，产出 `apps/gui/src-tauri/resources/sidecar/`：
1. `pnpm deploy --filter=@inkmigrate/engine --prod apps/gui/src-tauri/resources/sidecar/engine` —— 把 engine + 依赖（解析 pnpm 软链接后）拷成物理目录树
2. 确认 `better_sqlite3.node` 在 `engine/node_modules/` 树里（pnpm deploy 会带上）
3. 验证 `engine/dist/index.js` 入口存在
4. 打印体积报告

### 步骤 2：Node 二进制获取 `scripts/fetch-node-runtime.mjs`
按当前 target-triple（`process.arch` + `process.platform`）下载对应 Node 二进制：
- macOS arm64 / x86_64 / Windows x86_64
- 从 nodejs.org 官方下载，解压到 `resources/sidecar/node/`
- 脚本检测当前平台，只下当前需要的（交叉构建时在目标机跑）

### 步骤 3：chromium 获取
复用已缓存的 `~/Library/Caches/ms-playwright/chromium-1228/`：
- 拷到 `resources/sidecar/browsers/chromium-1228/`
- Windows 上用 `npx playwright install chromium` 下载
- 保持目录结构（Playwright 按 revision 校验）

### 步骤 4：改 `sidecar.rs`——资源路径定位（核心）
**文件**：`apps/gui/src-tauri/src/sidecar.rs`

```rust
pub async fn start(&self, app: AppHandle) -> Result<(), String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("无法获取 resource_dir: {}", e))?;
    
    // 开发模式：环境变量覆盖（指向 workspace）
    // 生产模式：从 resource_dir 解析
    let (node_bin, engine_path, browsers_path) = 
        if let Ok(p) = std::env::var("INKMIGRATE_ENGINE_PATH") {
            // 开发模式
            ("node".to_string(), p, None)
        } else {
            // 生产模式：resources/sidecar/ 下的绝对路径
            let base = resource_dir.join("sidecar");
            (
                base.join("node/bin/node").to_string_lossy().into_owned(),  // macOS
                base.join("engine/dist/index.js").to_string_lossy().into_owned(),
                Some(base.join("browsers").to_string_lossy().into_owned()),
            )
        };
    
    let mut cmd = Command::new(&node_bin);
    cmd.arg("--max-old-space-size=8192").arg(&engine_path);
    // 注入 PLAYWRIGHT_BROWSERS_PATH 让 engine 找到打包的 chromium
    if let Some(bp) = browsers_path {
        cmd.env("PLAYWRIGHT_BROWSERS_PATH", bp);
    }
    // ... stdin/stdout/stderr 不变
}
```

关键改动：
- `Command::new("node")` → `Command::new(node_bin)`（用打包的 Node，不依赖系统 PATH）
- `engine_path` 相对路径 → `resource_dir` 绝对路径
- 注入 `PLAYWRIGHT_BROWSERS_PATH` 环境变量
- 用 `app.path().resource_dir()`（Tauri 2 API）替代相对 CWD

### 步骤 5：改 `tauri.conf.json`——声明 resources
**文件**：`apps/gui/src-tauri/tauri.conf.json`

```json
"bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.icns", "icons/icon.ico", "icons/icon.png"],
    "resources": ["resources/sidecar/**/*"]
}
```
- 补齐图标（512x512+，macOS 需 `.icns`）
- `resources` 把整个 sidecar 目录树打入 .app/Contents/Resources

### 步骤 6：图标生成
当前 `icon.png` 是 32x32/105字节，macOS 打包会报错。
- 用 `tauri icon` 从一张 1024x1024 源图生成全套（`.icns`/`.ico`/各尺寸 png）
- 需要一张 1024x1024 的源图（你可以提供，或我先用占位图）

### 步骤 7：打包流程整合
**文件**：`apps/gui/package.json` + 根 `package.json`

加 `"prebuild"` 钩子或独立 `bundle` script：
```json
// 根 package.json
"scripts": {
    "bundle:macos-arm64": "node scripts/build-sidecar.mjs && node scripts/fetch-node-runtime.mjs && cd apps/gui && pnpm tauri build --target aarch64-apple-darwin"
}
```

`tauri.conf.json` 的 `beforeBuildCommand` 改为先跑全量 build：
```json
"beforeBuildCommand": "pnpm -r run build && cd apps/gui && pnpm build"
```

### 步骤 8：三平台构建说明
由于 better-sqlite3 的 `.node` 和 Node 二进制是架构专属，**必须在目标平台上构建**：
- **macOS arm64**：在你的 M 系列 Mac 上 `pnpm bundle:macos-arm64`
- **macOS x86_64**：在 Intel Mac 上跑，或用 Rosetta（better-sqlite3 可能编译失败，需实测）
- **Windows**：在 Windows 机器上跑（`node scripts/build-sidecar.mjs` 会下 Windows 版 Node + chromium）

每平台产出独立的安装包，不能交叉。

## 关键设计决策

1. **零 JS 改动**：全量 resources 保留 node_modules 目录结构，`bindings`/`__dirname` 正常工作，better-sqlite3 不需要改 `nativeBinding`
2. **Node 不打进二进制**：保留独立 Node 可执行文件，避免 SEA/pkg 的兼容性地雷
3. **chromium 靠环境变量重定向**：`PLAYWRIGHT_BROWSERS_PATH` 是 Playwright 官方机制，不改 browser-session.ts
4. **stateDir/vaultPath 不受影响**：都是用户填的绝对路径（expandHome 处理 `~`），与打包无关
5. **平台专属构建**：native 模块不交叉编译，每平台独立产出

## 涉及文件清单
| 文件 | 改动 |
|---|---|
| `apps/gui/src-tauri/src/sidecar.rs` | resource_dir 路径定位 + PLAYWRIGHT_BROWSERS_PATH 注入 |
| `apps/gui/src-tauri/tauri.conf.json` | resources + 图标 + beforeBuildCommand |
| `scripts/build-sidecar.mjs` | 新增：pnpm deploy engine runtime |
| `scripts/fetch-node-runtime.mjs` | 新增：下载平台对应 Node 二进制 |
| `apps/gui/package.json` / `package.json` | bundle script |
| `apps/gui/src-tauri/icons/` | 1024x1024 源图 → 全套图标 |

## 不在本次范围
- 代码签名/公证（Apple Developer 证书、chromium 签名）—— 独立任务，需开发者账号
- 自动更新（tauri updater）—— 独立任务
- CI/CD 自动打包（GitHub Actions matrix）—— 独立任务
- src-tauri/~ 误生成目录清理 —— 打包前手动删

## 验证
- `pnpm bundle:macos-arm64` 产出 `apps/gui/src-tauri/target/release/bundle/dmg/*.dmg`
- 安装到另一台**没装 Node 的** M 系列 Mac 上
- 打开应用 → 能弹出 chromium 窗口登录头条 → 迁移一篇文章 → 图片下载到本地