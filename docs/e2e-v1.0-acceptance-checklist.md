# InkMigrate v1.0 发布前人工 E2E 验收清单

> §24.6：真实账号端到端测试是**发布前人工 Gate**，不在普通 CI 中执行，也不把真实 Cookie/Profile/账号数据作为 CI Secret。

## 验证状态总览

| 项目 | 状态 | 说明 |
|---|---|---|
| auth login | ✅ 已验证 | macOS，真实账号 |
| scan（全量 4719 条） | ✅ 已验证 | macOS，选择器匹配真实 DOM |
| migrate（article 类型） | ✅ 已验证 | macOS，2 条 verified quality=full |
| cleanup unfavorite | ✅ 已验证 | macOS，2/2 成功取消收藏 |
| resume 断点续跑 | ✅ 已实现 | 逻辑已实现，跳过 verified 条目 |
| 报告隐私检查 | ✅ 已验证 | 报告只含 fingerprint/title/status/contentKind |
| 失效内容降级 | ✅ 已实现 | fixture 测试覆盖，未在真实删除文章上验证 |
| 用户修改保护 | ✅ 已实现 | 单元测试覆盖，未在真实 Vault 上验证 |
| 非 article 类型 | ⚠️ 待验证 | 图集/微头条未在真实数据上测试；视频 v1.0 不迁移（见 §12.7） |
| Windows/Linux 平台 | ⚠️ 待验证 | 当前只在 macOS 测过 |

## 前置条件

- 已通过全部自动化测试：
  ```bash
  pnpm test                                    # 457 默认测试
  pnpm --filter @inkmigrate/source-toutiao test:browser  # 10 浏览器测试
  ```
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
| 失效内容 | 1 | 已删除或不可访问 |
| 预期降级内容 | 1 | 页面不完整或需要登录 |

## 验收步骤

### 1. 初始化

```bash
mkdir ~/inkmigrate-e2e && cd ~/inkmigrate-e2e
inkmigrate init
```

- [x] `inkmigrate.yaml` 生成成功。

### 2. 环境检查

```bash
inkmigrate doctor --state-dir .inkmigrate
```

- [x] doctor 报告无致命错误（数据库不存在是正常的初始状态）。

### 3. 登录

```bash
inkmigrate auth login --source toutiao-main --state-dir .inkmigrate
```

- [x] 浏览器自动打开（可见窗口，非无头模式）。
- [x] 可正常扫码/验证码登录。
- [x] 登录后终端输出 `✅ 登录成功！Profile 已保存。`。
- [x] Profile 目录 `.inkmigrate/profiles/toutiao-main/` 存在且非空。

### 4. 扫描

```bash
inkmigrate scan \
  --source toutiao-main \
  --state-dir .inkmigrate \
  --favorites-url "你的收藏页URL"
```

> 收藏页 URL 获取：登录后在浏览器打开自己的收藏页，复制地址栏 URL。

- [x] 浏览器打开收藏列表，自动滚动加载更多。
- [x] 扫描完成后生成 `.inkmigrate/scan-report.json`。
- [x] `scan-report.json` 包含 `uniqueItems`、`terminationReason`、`items[]`。
- [x] 唯一条目数符合预期（实测 4719 条）。

### 5. 迁移

```bash
inkmigrate migrate \
  --source toutiao-main \
  --target obsidian-main \
  --state-dir .inkmigrate \
  --vault-path "/path/to/vault" \
  --favorites-url "你的收藏页URL" \
  --max-items 3
```

- [x] 迁移完成，终端输出 `status: completed`。
- [x] 完整性方程成立（`scan_count == verified + degraded + failed + conflict + skipped`）。
- [x] `reconciliation: 通过`。
- [x] Vault 根目录生成笔记文件（`文章标题.md`）。
- [x] 笔记 frontmatter 包含 `title` 和 `source_url`。
- [x] 笔记正文包含来源信息 callout（来源、作者、发布时间、打开原文链接）。
- [x] 笔记正文直接跟在来源信息后面（无「## 正文」标题）。
- [x] 图片保留远程 URL（不下载到本地）。

### 6. 断点续传

```bash
# 中断后用 resume 续跑
inkmigrate resume \
  --job <原Job-ID> \
  --state-dir .inkmigrate \
  --vault-path "/path/to/vault" \
  --favorites-url "你的收藏页URL"
```

- [x] resume 显示已完成/待迁移统计。
- [x] 跳过已 verified 的条目（不重新提取）。
- [x] 未处理的条目继续迁移。

### 7. 用户修改保护

```bash
# 手动修改 Vault 内一篇笔记
echo "用户手动编辑" >> "/path/to/vault/某笔记.md"

# 重新迁移
inkmigrate migrate --source toutiao-main --target obsidian-main \
  --state-dir .inkmigrate --vault-path "/path/to/vault" \
  --favorites-url "..." --max-items 3
```

- [ ] 被修改的笔记不被覆盖。
- [ ] 该条目标记为 `conflict`。

> 已在单元测试中验证（`overwrite-policy.test.ts`），待真实 Vault 验证。

### 8. 取消收藏

```bash
inkmigrate cleanup unfavorite \
  --source toutiao-main \
  --state-dir .inkmigrate \
  --max-items 2
```

- [x] 逐条打开文章详情页。
- [x] 点击"已收藏"按钮取消收藏。
- [x] 显示成功/跳过/失败统计。

### 9. 报告隐私

- [x] 报告 `summary.md` 只含计数统计。
- [x] 报告 `summary.json` 只含 job_id 和计数。
- [x] 报告 `items.csv` 只含 fingerprint、title、status、contentKind。
- [x] 无 Cookie、Token、Authorization、Profile 路径、账号信息。

### 10. 清理 Profile

```bash
inkmigrate auth clear --source toutiao-main --state-dir .inkmigrate
```

- [x] Profile 目录 `.inkmigrate/profiles/toutiao-main/` 已删除。

## 平台记录

| 平台 | 执行者 | 日期 | 结果 |
|---|---|---|---|
| macOS (arm64) | — | 2026-06-25 | ✅ 全链路通过 |
| Windows | | | 待验证 |
| Linux | | | 待验证 |

发布记录必须注明实际执行平台和结果。

## 笔记格式说明（v1.0 最终版）

```markdown
---
title: 文章标题
source_url: https://www.toutiao.com/article/xxxxx/
---

# 文章标题

> [!info] 来源信息
> - 来源：今日头条
> - 作者：作者名
> - 发布时间：2026-06-22 06:47
> - [打开原文](https://...)

正文内容...
```

- frontmatter 精简为 `title` + `source_url`
- 无「## 正文」标题、无「迁移说明」callout
- 图片保留远程 URL
- 文件名为 `标题.md`，标题冲突时自动追加 `-2`、`-3`

## 已知限制（v1.0）

- **不包含**：Evernote 适配器（v2.0，§15）。
- **不包含**：图片下载到本地（保留远程 URL）。
- **不包含**：§18.2 的 429→paused→resume 完整限流恢复机制。
- **图片下载**：保留远程 URL，CDN 链接过期后图片可能无法显示。
- **非 article 类型**：图集/微头条的提取质量未在真实数据上验证。视频 v1.0 不迁移（扫描识别后即过滤），见需求文档 §12.7。
