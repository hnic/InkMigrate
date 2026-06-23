# InkMigrate v1.0 发布前人工 E2E 验收清单

> §24.6：真实账号端到端测试是**发布前人工 Gate**，不在普通 CI 中执行，也不把真实 Cookie/Profile/账号数据作为 CI Secret。

## 前置条件

- 已通过全部自动化测试（unit + fixture + contract + integration）。
- 已在 Windows、macOS、Linux 三平台 CI 全绿。
- 本清单执行者拥有可正常登录的今日头条测试账号。

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
inkmigrate init
inkmigrate config validate
```

- [ ] `inkmigrate.yaml` 生成成功。
- [ ] 配置校验通过。

### 2. 登录

```bash
inkmigrate auth login --source toutiao-main --state-dir ~/.inkmigrate
```

- [ ] 浏览器打开，可正常扫码登录。
- [ ] 登录后 Profile 保存成功。
- [ ] 后续命令可复用 Profile，不需要重新登录。

### 3. 扫描

```bash
inkmigrate scan --source toutiao-main --state-dir ~/.inkmigrate
```

- [ ] 扫描完成，生成 `scan-report.json`。
- [ ] 唯一条目数 ≥ 29（20+3+2+2+1+1）。
- [ ] 终止原因合理（`no_new_items_after_5_cycles` 或 `no_load_more`）。

### 4. 迁移

```bash
inkmigrate migrate --source toutiao-main --target obsidian-main --state-dir ~/.inkmigrate
```

- [ ] 迁移完成，Job `status = completed`。
- [ ] 完整性方程成立（`scan_count == verified + degraded + failed + conflict + skipped`）。
- [ ] Vault 内 `Imports/InkMigrate/toutiao-main/` 下生成笔记。
- [ ] 普通文章正文提取成功率 ≥ 95%（分母 = 冻结清单中 `article` 类型、测试开始时可访问、无删除/付费/权限/登录阻断的条目；20 篇意味着至少 19 篇 `quality: full`）。
- [ ] 失效内容生成占位笔记（`quality: degraded` + `content-unavailable`）。
- [ ] 预期降级内容标记为 `degraded`。
- [ ] 报告 `reports/<job-id>/summary.md` + `summary.json` + CSV 明细齐全。
- [ ] `failed_count = permanent_failed + unsupported + blocked`。

### 5. 断点续传

- [ ] 迁移中途 `Ctrl+C`，Job 进入 `interrupted`。
- [ ] `inkmigrate resume --job <id>` 恢复后，完整性方程仍成立。

### 6. 用户修改保护

- [ ] 手动修改 Vault 内一篇笔记。
- [ ] 重新迁移（`overwritePolicy: preserve`），该笔记不被覆盖，标记 `conflict`。

### 7. 报告隐私

- [ ] 报告中无 Cookie、Token、Authorization、登录验证码、完整 Profile 或未脱敏请求头。

## 平台记录

| 平台 | 执行者 | 日期 | 结果 |
|---|---|---|---|
| macOS | | | |
| Windows | | | |
| Linux | | | |

发布记录必须注明实际执行平台和结果。
