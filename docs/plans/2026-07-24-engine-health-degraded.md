# Engine health_degraded 通知机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** engine 在 `uncaughtException` 后主动发 `health_degraded` notification，GUI 收到后冻结新长任务（读操作放行）并提示用户重启应用。

**Architecture:** 新增 `HealthDegradedNotification` 类型于 `@inkmigrate/protocol`（单一真相源）。engine 在 `uncaughtException` 处理器中发首条通知（进程级标志节流，单次）。sidecar.rs 把 method 映射为 `sidecar://health` 事件。GUI `useSidecar` 监听该事件、设置降级 state，`rpcCall` 对长任务做前置拦截。UI 在 `App.tsx` 主区顶部展示降级 banner。

**Tech Stack:** TypeScript (engine + GUI)、Rust (Tauri sidecar)、vitest (仅 engine 有测试基础设施)、React (GUI)

**Spec:** `docs/2026-07-24-engine-health-degraded-design.md`

---

## 测试基础设施现状（影响计划真实性）

- **engine**：有 vitest + `apps/engine/tests/`。本计划对 engine 改动采用 TDD。
- **GUI (`apps/gui/src`)**：**无任何测试文件**，`package.json` 无 test script。GUI 改动以 `tsc -b` 类型检查 + 手动验证为准，不编造测试。
- **Rust (`apps/gui/src-tauri`)**：**无现有 `#[test]`**。sidecar.rs 改动以 `cargo check` + 手动验证为准，不编造测试。

---

## File Structure

| 文件 | 责任 | 操作 |
|------|------|------|
| `packages/protocol/src/index.ts` | 定义 `HealthDegradedNotification`（单一真相源） | Modify |
| `apps/engine/src/health-events.ts` | **新建**：抽出 `handleUncaughtException` 可测函数（节流 + 发通知） | Create |
| `apps/engine/src/index.ts` | 调用抽出的函数；修正过时注释 | Modify |
| `apps/engine/tests/health-events.test.ts` | **新建**：TDD 覆盖节流/单次/try-catch 兜底 | Create |
| `apps/gui/src-tauri/src/sidecar.rs` | notification match 新增 `health_degraded` 映射 | Modify |
| `apps/gui/src/hooks/useSidecar.ts` | 监听 `sidecar://health`；rpcCall 冻结长任务 | Modify |
| `apps/gui/src/App.tsx` | 解构 `healthDegraded`；渲染降级 banner | Modify |

**设计决策（文件拆分）**：把 `uncaughtException` 逻辑从 `index.ts` 抽到 `health-events.ts`，是因为现状下 handler 直接挂在 `process` 上、依赖模块级 `sendNotification` 导入，无法单测。抽成纯函数 + 依赖注入（`sendNotification` 作为参数传入）后可 TDD。`index.ts` 仅负责"把函数挂到 process.on"。

---

## Task 1: 定义 `HealthDegradedNotification` 协议类型

**Files:**
- Modify: `packages/protocol/src/index.ts`（"通知类型"分区，`LogNotification` 之后，`:183` 附近）

- [ ] **Step 1: 在 protocol 包通知分区新增类型定义**

在 `packages/protocol/src/index.ts` 的 `LogNotification` 接口之后（`// ─── 方法映射` 注释之前）插入：

```typescript
export interface HealthDegradedNotification {
  /** 降级原因类别。当前固定 "uncaughtException"；为将来扩展其他降级源预留。 */
  reason: 'uncaughtException';
  /** err.message */
  message: string;
  /** err.stack，完整不脱敏（本地诊断用，不落盘不分享） */
  stack?: string;
}
```

- [ ] **Step 2: 类型检查 protocol 包**

Run: `cd packages/protocol && pnpm typecheck`
Expected: PASS，无错误（protocol 包已定义 `typecheck: tsc -b`）。

- [ ] **Step 3: 提交**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): 新增 HealthDegradedNotification 通知类型"
```

---

## Task 2: engine 侧 — TDD 实现 `handleUncaughtException`

**Files:**
- Create: `apps/engine/src/health-events.ts`
- Create: `apps/engine/tests/health-events.test.ts`

- [ ] **Step 1: 写失败测试（节流：首条发通知，第二条不发）**

创建 `apps/engine/tests/health-events.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createUncaughtExceptionHandler } from '../src/health-events.js';

describe('handleUncaughtException (health_degraded)', () => {
  it('首条异常发送 health_degraded notification', () => {
    const sendNotification = vi.fn();
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    handler(new Error('boom'));

    expect(logToStderr).toHaveBeenCalledWith('error', expect.stringContaining('boom'));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith('health_degraded', {
      reason: 'uncaughtException',
      message: 'boom',
      stack: expect.any(String),
    });
  });

  it('后续异常不再发 notification（单次节流），但仍写 stderr', () => {
    const sendNotification = vi.fn();
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    handler(new Error('first'));
    handler(new Error('second'));
    handler(new Error('third'));

    expect(sendNotification).toHaveBeenCalledTimes(1); // 只发首条
    expect(logToStderr).toHaveBeenCalledTimes(3); // 每条都记 stderr
  });

  it('无 stack 时 payload 不含 stack 字段', () => {
    const sendNotification = vi.fn();
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    const err = new Error('no stack');
    err.stack = undefined;
    handler(err);

    expect(sendNotification).toHaveBeenCalledWith('health_degraded', {
      reason: 'uncaughtException',
      message: 'no stack',
    });
  });

  it('sendNotification 自身抛异常时不冒泡（兜底 try/catch）', () => {
    const sendNotification = vi.fn(() => { throw new Error('stdout broken'); });
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    expect(() => handler(new Error('boom'))).not.toThrow();
    expect(logToStderr).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/engine && pnpm test -- health-events`
Expected: FAIL — `createUncaughtExceptionHandler` 未定义（模块不存在）。

- [ ] **Step 3: 实现最小代码使测试通过**

创建 `apps/engine/src/health-events.ts`：

```typescript
import type { HealthDegradedNotification } from '@inkmigrate/protocol';

/**
 * uncaughtException 的降级通知处理器（可测纯函数）。
 *
 * 设计见 docs/2026-07-24-engine-health-degraded-design.md：
 * - 单次通知节流（进程级标志）：首条异常发 health_degraded，后续只写 stderr。
 * - sendNotification 包 try/catch：防止"处理异常的代码本身抛异常"二次崩溃。
 *
 * 通过 createUncaughtExceptionHandler 注入 sendNotification/logToStderr，
 * 使其与 transport 模块解耦，可在单测中 mock。
 */
export interface HandlerDeps {
  sendNotification: (method: string, params?: Record<string, unknown>) => void;
  logToStderr: (level: string, message: string) => void;
}

export function createUncaughtExceptionHandler(deps: HandlerDeps) {
  let healthDegradedSent = false;

  return function handleUncaughtException(err: Error): void {
    deps.logToStderr('error', `未捕获异常（已恢复，sidecar 继续运行）：${err.message}\n${err.stack ?? ''}`);

    if (healthDegradedSent) return; // 单次节流
    healthDegradedSent = true;

    const payload: HealthDegradedNotification = {
      reason: 'uncaughtException',
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
    try {
      deps.sendNotification('health_degraded', payload);
    } catch {
      // 兜底：sendNotification 自身失败（stdout 已断等）不应让 handler 二次崩溃。
      // writeLine 内部已有 try/catch，此处为防御性双保险。
      deps.logToStderr('warn', 'health_degraded notification 发送失败，已忽略');
    }
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/engine && pnpm test -- health-events`
Expected: PASS，4 个测试全绿。

- [ ] **Step 5: 类型检查**

Run: `cd apps/engine && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/engine/src/health-events.ts apps/engine/tests/health-events.test.ts
git commit -m "feat(engine): 抽出可测的 uncaughtException 降级通知处理器

单次通知节流 + sendNotification try/catch 兜底，TDD 覆盖。"
```

---

## Task 3: engine 侧 — 接线到 `index.ts` 并修正过时注释

**Files:**
- Modify: `apps/engine/src/index.ts:21-30`

- [ ] **Step 1: 替换 index.ts 的 uncaughtException 处理器**

将 `apps/engine/src/index.ts` 顶部 import 区（`import { startStdinLoop, logToStderr } from './transport.js';` 那一行）改为：

```typescript
import { startStdinLoop, logToStderr, sendNotification } from './transport.js';
import { createUncaughtExceptionHandler } from './health-events.js';
```

然后将 `main()` 内的 `process.on('uncaughtException', ...)` 块（原 `index.ts:24-30`）整体替换为：

```typescript
  // 健康降级：uncaughtException 后进程状态可能损坏（锁未释放、事务未完结），
  // 但直接 exit(1) 会杀死 sidecar 且 crashed 事件只对"进程退出"有效——
  // 这里选择继续运行 + 主动发 health_degraded 通知，让 GUI 冻结新长任务并提示重启。
  // 节流/兜底逻辑见 health-events.ts。
  const handleUncaughtException = createUncaughtExceptionHandler({ sendNotification, logToStderr });
  process.on('uncaughtException', handleUncaughtException);
```

注意：`unhandledRejection` 处理器（原 `index.ts:21-23`）**保持不变**——见设计文档"非目标"。

- [ ] **Step 2: 确认删除了原过时注释**

确认原 `index.ts:25-28` 关于"Tauri sidecar 无重启机制"的注释已被上面新注释取代，不再残留。

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `cd apps/engine && pnpm typecheck && pnpm test`
Expected: PASS（含原有 schemas.test.ts 回归）。

- [ ] **Step 4: 提交**

```bash
git add apps/engine/src/index.ts
git commit -m "feat(engine): index.ts 接线 health_degraded 并修正过时注释"
```

---

## Task 4: sidecar.rs — notification 映射新增 `health_degraded`

**Files:**
- Modify: `apps/gui/src-tauri/src/sidecar.rs:232-242`（`read_stdout` 的 notification match 分支）

- [ ] **Step 1: 在 match 分支新增映射**

在 `apps/gui/src-tauri/src/sidecar.rs` 的 `read_stdout` 函数内，找到 notification match（当前含 `"progress"` / `"log"` 两个分支，约 `:233-239`），在 `"log"` 分支后新增：

```rust
                "health_degraded" => "sidecar://health",
```

完整的 match 块改后形如：

```rust
        let event_name = match method_str.as_str() {
            "progress" => "sidecar://progress",
            "log" => "sidecar://log",
            "health_degraded" => "sidecar://health",
            other => {
                eprintln!("未知 notification: {}", other);
                continue;
            }
        };
```

- [ ] **Step 2: cargo check 验证编译**

Run: `cd apps/gui/src-tauri && cargo check`
Expected: PASS，无错误（纯字符串字面量改动，无新依赖）。

- [ ] **Step 3: 提交**

```bash
git add apps/gui/src-tauri/src/sidecar.rs
git commit -m "feat(gui-tauri): sidecar 映射 health_degraded → sidecar://health 事件"
```

---

## Task 5: GUI useSidecar — 监听降级事件 + 冻结长任务

**Files:**
- Modify: `apps/gui/src/hooks/useSidecar.ts`

- [ ] **Step 1: 新增降级 state + 监听 + rpcCall 拦截**

在 `apps/gui/src/hooks/useSidecar.ts`：

(a) 顶部 import 补充类型：

```typescript
import type { ProgressEvent, LogEntry } from '../lib/types.js';
import type { HealthDegradedNotification } from '@inkmigrate/protocol';
```

(b) 在 `useState` 区（`useSidecar` 函数体内，`activePhase` state 之后）新增：

```typescript
  /** 引擎健康降级状态。uncaughtException 后由 engine 推送，仅重启应用可解除。 */
  const [healthDegraded, setHealthDegraded] = useState<HealthDegradedNotification | null>(null);
```

(c) 在 `useEffect` 内（`sidecar://crashed` 的 listen 之后、`return () =>` 之前）新增监听：

```typescript
    listen<HealthDegradedNotification>('sidecar://health', (e) => {
      setHealthDegraded(e.payload);
      setLogs((prev) => [
        ...prev.slice(-199),
        {
          level: 'error',
          message: `⚠️ 引擎状态降级：${e.payload.message}`,
          timestamp: Date.now(),
        },
      ]);
      // 降级意味着当前长任务结果不可信，重置 busy/activePhase（同 crashed 语义）
      setBusy(false);
      setActivePhase(null);
    }).then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); })
      .catch((e) => console.error('health listen 失败', e));
```

(d) 在 `rpcCall` 的 `useCallback` 内，`isLongTask` 判定之后、`setBusy(true)` 之前，插入冻结拦截：

```typescript
    const isLongTask = method in METHOD_PHASE;
    if (isLongTask && healthDegraded !== null) {
      throw new Error('引擎状态已降级，请重启应用后再操作');
    }
    if (isLongTask) {
```

(e) `useCallback` 依赖数组：由于 `rpcCall` 现在引用 `healthDegraded`，把依赖数组从 `[]` 改为 `[healthDegraded]`。

(f) 返回值新增 `healthDegraded`：

```typescript
  return { rpcCall, progress, logs, busy, activePhase, healthDegraded, addLog, cancel };
```

- [ ] **Step 2: 类型检查 GUI**

Run: `cd apps/gui && pnpm typecheck`（若无，用 `pnpm build`）
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add apps/gui/src/hooks/useSidecar.ts
git commit -m "feat(gui): useSidecar 监听 health 降级事件并冻结新长任务"
```

---

## Task 6: GUI App.tsx — 渲染降级 banner

**Files:**
- Modify: `apps/gui/src/App.tsx:19`（解构）与 `:60-61`（main 区顶部）

- [ ] **Step 1: 解构 healthDegraded**

将 `apps/gui/src/App.tsx:19`：

```typescript
  const { rpcCall, progress, logs, busy, activePhase, addLog, cancel } = useSidecar();
```

改为：

```typescript
  const { rpcCall, progress, logs, busy, activePhase, healthDegraded, addLog, cancel } = useSidecar();
```

- [ ] **Step 2: 在 main 区顶部、ProgressBar 之前插入降级 banner**

将 `App.tsx` 内（约 `:59-61`）：

```tsx
          {/* 进度条（有活跃任务时显示） */}
          <ProgressBar progress={progress} />
```

改为：

```tsx
          {/* 引擎降级提示（uncaughtException 后显示，需重启应用解除） */}
          {healthDegraded !== null && (
            <div style={{
              padding: '10px 14px',
              background: 'var(--danger)',
              color: '#fff',
              borderRadius: '6px',
              fontSize: '13px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}>
              <strong>⚠️ 引擎状态已降级</strong>
              <span>新任务已暂停。建议保存当前状态并<span style={{ fontWeight: 700 }}>重启应用</span>后再继续。</span>
              <details style={{ marginTop: '2px' }}>
                <summary style={{ cursor: 'pointer', opacity: 0.9 }}>详细信息</summary>
                <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: '11px', opacity: 0.85 }}>
                  {healthDegraded.stack ?? healthDegraded.message}
                </pre>
              </details>
            </div>
          )}

          {/* 进度条（有活跃任务时显示） */}
          <ProgressBar progress={progress} />
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `cd apps/gui && pnpm build`
Expected: PASS（`tsc -b && vite build`）。

- [ ] **Step 4: 提交**

```bash
git add apps/gui/src/App.tsx
git commit -m "feat(gui): App 顶部展示引擎降级 banner（含 stack 详情）"
```

---

## Task 7: 端到端手动验证

GUI/Rust 无自动化测试，本任务为手动验证清单，确认整条链路工作。

- [ ] **Step 1: 构建全部**

Run: `pnpm -r build`（根目录，确保 protocol/engine/gui 都重新构建）
Expected: 全部 PASS。

- [ ] **Step 2: 启动 dev 模式，注入 uncaughtException 验证**

在 `apps/engine/src/index.ts` 的 `main()` 末尾**临时**加一行触发：

```typescript
  setTimeout(() => { throw new Error('E2E health probe'); }, 2000);
```

然后以 dev 模式启动 GUI（`INKMIGRATE_ENGINE_PATH` 指向 engine，按项目 README 的 dev 启动方式）。

Expected（2 秒后）：
- GUI 主区顶部出现红色降级 banner，含"重启应用"提示；
- 日志面板出现"⚠️ 引擎状态降级：E2E health probe"；
- 点击任一长任务按钮（如"开始扫描"/"开始迁移"）被拦截，弹出错误"引擎状态已降级，请重启应用后再操作"；
- 读操作（进入报告页等查询）仍可正常发起，不被拦截。

- [ ] **Step 3: 移除临时探针**

删除 Step 2 加的 `setTimeout` 行。

- [ ] **Step 4: 节流验证（可选，已在 engine 单测覆盖）**

确认 engine 单测 `health-events.test.ts` 的"后续异常不再发 notification"用例通过即可，无需手动重复。

- [ ] **Step 5: 最终提交（移除探针）**

```bash
git add apps/engine/src/index.ts
git commit -m "chore(engine): 移除 E2E health 探针（手动验证完毕）"
```

- [ ] **Step 6: 回归确认**

Run: `cd apps/engine && pnpm test`（确认 schemas.test.ts 无回归）
Expected: PASS。

---

## Self-Review 记录

**1. Spec 覆盖：**
- 协议类型定义 → Task 1 ✓
- engine uncaughtException 通知 + 节流 + try/catch 兜底 → Task 2, 3 ✓
- 修正过时注释 → Task 3 Step 2 ✓
- sidecar.rs method 映射 → Task 4 ✓
- useSidecar 监听 + rpcCall 冻结长任务（读操作放行）→ Task 5 ✓
- UI banner 展示 → Task 6 ✓
- 决策点 1（stack 完整不脱敏）→ payload 直传 stack，UI 用 `<pre>` 展示 ✓
- 决策点 2（只冻结 METHOD_PHASE 长任务）→ Task 5 (d) `isLongTask && healthDegraded` ✓
- 决策点 3（仅重启解除）→ banner 文案"重启应用"，无自愈逻辑 ✓
- 决策点 4（单次节流）→ Task 2 测试 + 实现 ✓

**2. 占位符扫描：** 无 TBD/TODO。所有代码步骤含完整代码。

**3. 类型一致性：** `HealthDegradedNotification`（非 `HealthDegradedPayload`）在所有任务中一致。`createUncaughtExceptionHandler` / `handleUncaughtException` 命名一致。`healthDegraded` state 名在 useSidecar 与 App.tsx 一致。
