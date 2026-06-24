# InkMigrate v1.0 发布前人工 E2E 验收清单

> §24.6：真实账号端到端测试是**发布前人工 Gate**，不在普通 CI 中执行，也不把真实 Cookie/Profile/账号数据作为 CI Secret。

## 前置条件

- 已通过全部自动化测试（unit + fixture + contract + integration）。
  ```bash
  pnpm test                                    # 458 默认测试
  pnpm --filter @inkmigrate/source-toutiao test:browser  # 10 浏览器测试
  ```
- 已在 Windows、macOS、Linux 三平台 CI 全绿。
- 已安装 Playwright Chromium：`pnpm --filter @inkmigrate/source-toutiao exec playwright install chromium`
- 已注册全局命令：`ln -sf $(pwd)/apps/cli/dist/index.js ~/.local/bin/inkmigrate`
- 本清单执行者拥有可正常登录的今日头条测试账号。
- 已准备一个 Obsidian Vault 目录（可为空 Vault）。

## 冻结验收数据集

在测试开始前固定以下数据集，保存 ID/URL；不可访问条目不得事后从分母删除。

| 类型 | 数量 | 要求 |
|---|---|---|
| 普通文章 | 20 | 测试开始前已确认可正常访问 |
| 短文本（微头条） | 3 | — |
| 图集 | 2 | — |
| 视频 | 2 | — |
| 失效内容 | 1 | 已删除或不可访问 |
| 预期降级内容 | 1 | 页面不完整或需要登录 |

## 验收步骤

### 1. 初始化

```bash
mkdir ~/inkmigrate-e2e && cd ~/inkmigrate-e2e
inkmigrate init
```

- [ ] `inkmigrate.yaml` 生成成功。
- [ ] 配置文件包含 `version: 1`、`workspace`、`sources`、`targets` 等顶层键。

### 2. 环境检查

```bash
inkmigrate doctor --state-dir .inkmigrate
```

- [ ] doctor 报告无致命错误。
- [ ] 数据库可正常创建。

### 3. 登录

```bash
inkmigrate auth login --source toutiao-main --state-dir .inkmigrate
```

- [ ] 浏览器自动打开（可见窗口，非无头模式）。
- [ ] 导航到今日头条收藏页或登录页。
- [ ] 可正常扫码/验证码登录。
- [ ] 登录后终端输出 `✅ 登录成功！Profile 已保存。`。
- [ ] Profile 目录 `.inkmigrate/profiles/toutiao-main/` 存在且非空。
- [ ] 登录检测使用至少两类信号（`hasUserEntryElement` + `favoritesPageAccessible` 等），不是仅靠 Cookie 判断。

### 4. 登录状态复用

```bash
# 再次运行 scan，应不需要重新登录
inkmigrate scan --source toutiao-main --state-dir .inkmigrate
```

- [ ] 浏览器打开后直接进入收藏页，不要求重新登录。
- [ ] 说明 Profile 持久化生效。

### 5. 扫描

```bash
inkmigrate scan --source toutiao-main --state-dir .inkmigrate
```

- [ ] 浏览器打开收藏列表，自动滚动加载更多。
- [ ] 扫描完成后生成 `.inkmigrate/scan-report.json`。
- [ ] `scan-report.json` 包含 `uniqueItems`、`terminationReason`、`scrollIterations`、`items[]`。
- [ ] 唯一条目数 ≥ 29（20+3+2+2+1+1）。
- [ ] 终止原因合理（`no_new_items_after_5_cycles` 或 `no_load_more`）。
- [ ] `items[]` 中每条包含 `externalId`、`canonicalUrl`、`title`、`contentKind`。

### 6. 迁移

```bash
inkmigrate migrate \
  --source toutiao-main \
  --target obsidian-main \
  --state-dir .inkmigrate \
  --vault-path ~/Obsidian/MyVault
```

- [ ] 迁移完成，终端输出 `status: completed`。
- [ ] 完整性方程成立（`scan_count == verified + degraded + failed + conflict + skipped`）。
- [ ] `reconciliation: 通过`。
- [ ] Vault 内 `Imports/InkMigrate/toutiao-main/` 下生成笔记。
- [ ] 普通文章正文提取成功率 ≥ 95%（分母 = 冻结清单中 `article` 类型、测试开始时可访问、无删除/付费/权限/登录阻断的条目；20 篇意味着至少 19 篇 `quality: full`）。
- [ ] 失效内容生成占位笔记（`quality: degraded` + `content-unavailable`）。
- [ ] 预期降级内容标记为 `degraded`。
- [ ] 报告 `reports/<job-id>/summary.md` + `summary.json` + CSV 明细齐全。
- [ ] `failed_count = permanent_failed + unsupported + blocked`。
- [ ] 笔记 frontmatter 包含 `migration_job_id`、`source_content_hash`、`imported_at`、`inkmigrate_version`。
- [ ] 笔记正文包含来源信息 callout（来源、作者、发布时间、打开原文链接）。
- [ ] 笔记正文包含迁移说明 callout。

### 7. 断点续传

```bash
# 启动迁移后立即 Ctrl+C 中断
inkmigrate migrate --source toutiao-main --target obsidian-main \
  --state-dir .inkmigrate --vault-path ~/Obsidian/MyVault
# 按 Ctrl+C
```

- [ ] Job 进入 `interrupted` 状态。
- [ ] 终端输出中断提示。

```bash
inkmigrate resume --job <job-id> --state-dir .inkmigrate
```

- [ ] 恢复后完整性方程仍成立。
- [ ] 未处理的条目继续迁移。

### 8. 用户修改保护

```bash
# 手动修改 Vault 内一篇笔记的内容
echo "用户手动编辑" >> ~/Obsidian/MyVault/Imports/InkMigrate/toutiao-main/文章/<某笔记>.md

# 重新迁移（overwritePolicy 默认 preserve）
inkmigrate migrate --source toutiao-main --target obsidian-main \
  --state-dir .inkmigrate --vault-path ~/Obsidian/MyVault
```

- [ ] 被修改的笔记不被覆盖。
- [ ] 该条目标记为 `conflict`。
- [ ] 原始用户内容保留。

### 9. 状态查询

```bash
inkmigrate status --job <job-id> --state-dir .inkmigrate
```

- [ ] 正确显示 Job 状态（`completed` / `interrupted`）。
- [ ] 显示 scan_count、各状态计数。

### 10. 报告查看

```bash
inkmigrate report --job <job-id> --state-dir .inkmigrate
```

- [ ] 正确显示迁移报告摘要。

### 11. 报告隐私

- [ ] 报告中无 Cookie、Token、Authorization、登录验证码、完整 Profile 或未脱敏请求头。
- [ ] `scan-report.json` 中无敏感账号信息（user_id、username、mobile 等应脱敏或不包含）。

### 12. 清理 Profile

```bash
inkmigrate auth clear --source toutiao-main --state-dir .inkmigrate
```

- [ ] Profile 目录 `.inkmigrate/profiles/toutiao-main/` 已删除。
- [ ] 只删除该来源实例的 Profile，不影响其他数据。

## 额外检查（自动化测试覆盖项）

以下在自动化测试中已覆盖，E2E 时抽查确认行为一致：

- [ ] Fixture 模式可正常运行（`--fixture-dir` 不启动浏览器）。
- [ ] 浏览器测试全部通过（`pnpm --filter @inkmigrate/source-toutiao test:browser`）。
- [ ] 适配器双模式正确（无配置=桩，有配置=真实浏览器）。
- [ ] job-runner 正确调用 `prepare()` → `scan` → `close()` 生命周期。

## 平台记录

| 平台 | 执行者 | 日期 | 结果 |
|---|---|---|---|
| macOS | | | |
| Windows | | | |
| Linux | | | |

发布记录必须注明实际执行平台和结果。

## 已知限制（v1.0）

- **不包含**：源端清理（取消收藏）的浏览器自动化（v1.1 能力，CLI `cleanup` 命令为占位）。
- **不包含**：Evernote 适配器（v2.0）。
- **图片下载**：使用 Node.js fetch，适用于 CDN 公开图片；需要登录态才能访问的图片可能下载失败（降级为 metadata-only asset，不影响 quality）。
- **配置文件**：CLI 命令通过 `--state-dir` 等参数运行，不解析 `inkmigrate.yaml` 中的 `sources`/`targets` 配置。
