# @inkmigrate/source-toutiao

今日头条只读来源适配器。通过 Playwright 浏览器 Profile 实现登录、收藏页扫描、详情提取，把内容转换为标准 `SourceItem`。

## 能力（§12.1）

- authMode: browser-profile
- discoveryMode: remote-list
- supportsIncrementalScan: true
- supportsAssets: true
- supportsSourceCleanup: **false**（v1.0；v1.1 取消收藏实现后才允许改为 true）

## 测试

CI 用 `tests/fixtures/toutiao/` 下的 8 个脱敏 HTML fixture（§24.3），不依赖真实账号。

```bash
pnpm --filter @inkmigrate/source-toutiao test
```

## 录制真实 fixture（可选）

人工 fixture 在 `tests/fixtures/toutiao/`。若你想用真实账号录制更真实的 fixture：

```bash
# 1. 先登录（创建 Profile）
pnpm inkmigrate auth login --source toutiao-main --state-dir ~/.inkmigrate

# 2. 录制某个页面
pnpm --filter @inkmigrate/source-toutiao record:fixture -- \
  --url https://www.toutiao.com/article/<id>/ \
  --out article \
  --state-dir ~/.inkmigrate

# 3. 人工复核生成的 HTML，删除任何敏感字段后提交
```

recorder 做基础脱敏，但**你必须人工复核**——脱敏规则不可能覆盖所有账号字段。

## 真实账号 E2E

按 §24.6，真实账号端到端测试是**发布前人工 Gate**，不在 CI 中执行，也不把真实 Cookie/Profile 作为 CI Secret。
