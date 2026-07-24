# Engine health_degraded 通知机制

**日期**：2026-07-24
**类型**：健壮性增强
**范围**：`apps/engine`、`apps/gui/src-tauri`、`apps/gui/src`

## 背景

`apps/engine/src/index.ts` 的 `uncaughtException` 处理器当前选择"记录到 stderr 后继续运行"，以规避 sidecar 进程死亡。代码注释（`index.ts:25-28`）声称"Tauri sidecar 无重启机制"，但这一前提**已过时**：

- `apps/gui/src-tauri/src/sidecar.rs:248-252` 实际已实现崩溃感知——当 sidecar **进程退出**导致 stdout 关闭时，GUI 会收到 `sidecar://crashed` 事件。
- 但 engine 选择**继续运行**（不 exit），进程不退出，stdout 不关闭，`crashed` 事件**永远不会触发**。
- 结果：进程"活着但状态可疑"（锁未释放、SQLite 事务未完结、内存结构损坏），GUI 完全无感知，用户可能在损坏状态下继续运行长达数小时的全量迁移。

## 目标

- engine 在 `uncaughtException` 后**主动通知** GUI 进入降级状态。
- GUI 收到后**冻结新长任务发起**，防止在可疑状态上继续重负载操作。
- 修正 `index.ts` 中过时的注释，避免后续再次误导。

## 非目标

- **不实现 sidecar 自动重启**。`SidecarManagement` 目前只有 `start`（应用启动时一次）和 `shutdown`，没有 restart 路径；中途重启会丢失所有 in-memory 状态（未提交的迁移进度等），生命周期处理复杂度高、风险大。降级后的唯一恢复途径是重启整个应用。
- **不改动 `unhandledRejection` 的现有行为**。Node 对两者的态度不同：`uncaughtException` 后状态不可信是明确的官方立场，而 `unhandledRejection` 通常是可恢复的异步错误，不必然意味着状态损坏。混为一谈会引入误报噪音。
- 不处理本次 review 的 #2（测试 EPERM 兼容）和 #3（流水线 removedElementsCount）——已确认暂不做。

## 协议设计

新增 JSON-RPC notification method：`health_degraded`。

**Payload**（命名为 `HealthDegradedNotification`，遵循项目通知类型以 `Notification` 结尾的惯例）：
```typescript
interface HealthDegradedNotification {
  /** 降级原因类别。当前固定 "uncaughtException"；为将来扩展其他降级源预留。 */
  reason: 'uncaughtException';
  /** err.message */
  message: string;
  /** err.stack，完整不脱敏（见"决策点 1"） */
  stack?: string;
}
```

**类型定义位置**：`packages/protocol/src/index.ts`，与 `ProgressNotification`（`:163`）/ `LogNotification`（`:180`）平级，置于"通知类型（GUI 监听 sidecar 事件用）"分区下。engine 与 GUI 均从 `@inkmigrate/protocol` 导入——遵循该包已建立的"单一真相源"原则，避免两侧各自声明导致类型漂移。

GUI 侧映射为 Tauri 事件 `sidecar://health`，与现有 `sidecar://log` / `sidecar://progress` / `sidecar://crashed` 命名一致。

## 数据流

```
engine: uncaughtException 触发
  │
  ├─ logToStderr('error', ...)          // 始终写 stderr（与现状一致）
  │
  ├─ 检查 healthDegradedSent 标志（进程级，初始 false）
  │     │
  │     ├─ false → sendNotification('health_degraded', { reason, message, stack })
  │     │           置标志 = true
  │     │
  │     └─ true  → 仅 stderr，不再发 notification（单次通知）
  │
  ↓ notification 经 stdout
  │
sidecar.rs: read_stdout 收到 method='health_degraded'
  │
  ├─ match 分支新增 "health_degraded" => "sidecar://health"
  ├─ app.emit('sidecar://health', payload)
  │
  ↓
GUI: useSidecar.ts 新增 listen('sidecar://health', ...)
  │
  ├─ 打醒目 error 日志（带 message + stack）
  ├─ setHealthDegraded(payload)
  │
  ↓
UI 层：rpcCall 发起长任务前检查 healthDegraded 标志 → 冻结
```

## 组件改动

### 1. `apps/engine/src/index.ts`

- 新增进程级标志 `let healthDegradedSent = false`。
- `uncaughtException` 处理器内：先 `logToStderr`（保持现状），然后若 `!healthDegradedSent`，调用 `sendNotification('health_degraded', { reason: 'uncaughtException', message: err.message, ...(err.stack ? { stack: err.stack } : {}) })` 并置标志；对 `sendNotification` 调用包一层 try/catch（见"风险"）。
- **修正过时注释**（`index.ts:25-28`）：删除"Tauri sidecar 无重启机制"的错误论述，改为说明"sidecar 有 `crashed` 感知但仅对进程退出有效；uncaughtException 后进程继续运行，故需主动发 `health_degraded` 通知 GUI 冻结新长任务"。
- `sendNotification` 已从 `./transport.js` 导出，直接 import。`HealthDegradedNotification` 类型从 `@inkmigrate/protocol` 导入（仅用于类型标注，运行时 payload 为内联对象字面量）。

### 2. `apps/gui/src-tauri/src/sidecar.rs`

- `read_stdout` 的 notification match 分支（`sidecar.rs:232-242`）新增：
  ```rust
  "health_degraded" => "sidecar://health",
  ```
- 其余逻辑（emit、未知 method 告警）不变。

### 3. `apps/gui/src/hooks/useSidecar.ts`

- 新增 state：`const [healthDegraded, setHealthDegraded] = useState<HealthDegradedNotification | null>(null)`。
- 新增 `listen<HealthDegradedNotification>('sidecar://health', ...)`：
  - 收到后 `setHealthDegraded(payload)`；
  - `setLogs` 追加一条 `level: 'error'`、`message: ⚠️ 引擎状态降级：${payload.message}` 的日志；
  - 重置 `busy`/`activePhase`（与 `crashed` 处理一致——降级意味着当前长任务结果不可信）。
- `rpcCall` 内：若 `isLongTask && healthDegraded !== null`，提前 `throw new Error('引擎状态已降级，请重启应用后再操作')`（读操作不受影响，仍可发起）。
- `HealthDegradedNotification` 类型从 `@inkmigrate/protocol` 导入（单一真相源，不在 `lib/types.ts` 重复声明）。
- `useSidecar` 返回值新增 `healthDegraded`，供 UI 层决定如何展示提示。

### 4. UI 层展示

本设计**包含**一个最小 UI 要求（不实现则设计不完整）：

- 当 `healthDegraded !== null` 时，应用某处向用户显示明确提示："引擎状态已降级，建议保存当前状态并重启应用"。
- 用户尝试发起长任务时，`rpcCall` 抛出的错误会冒泡到调用页面的现有错误处理；UI 应确保该错误以可见方式呈现（而非静默吞掉）。

具体呈现形式（全局 banner / 顶部状态栏徽标 / 触发任务时的 inline 提示）由实现阶段按现有 UI 模式选择，本设计不强制——但**必须**有以上两点的等价实现，不能只设 state 不展示。

## 决策记录

### 决策点 1：stack trace 完整发送，不脱敏

`stack` 可能含本地文件绝对路径。但这是**本地桌面应用**，用户看到的是自己的路径，无外泄风险；`health_degraded` 只在本地 UI 显示，不落盘、不分享（区别于 `saveDiagnostics` 的诊断包场景，后者才需要 `redactor` 脱敏）。脱敏会让 stack 失去定位价值。

### 决策点 2：只冻结长任务，读操作不受影响

`useSidecar.ts:59-65` 的 `METHOD_PHASE` 精确定义了长任务：`scan.start` / `migrate.start` / `migrate.resume` / `cleanup.unfavorite` / `auth.login`。冻结只针对这些。读操作（`status.query` / `migrate.resumable` / `auth.status`）保持可用——它们正是降级场景下用户最需要的功能（查看当前状态、确认可恢复进度）。

### 决策点 3：状态不可自愈，仅重启应用可解除

`uncaughtException` 后状态不可信是 Node 官方立场，进程内不应"自动恢复"。`healthDegradedSent` 标志永久为 true，`healthDegraded` state 仅在应用重启（= 重新 spawn sidecar）后自然重置。UI 提示必须明确告知用户"需重启应用"，不暗示已恢复。

### 决策点 4：单次通知节流

`uncaughtException` 可能级联触发（损坏状态被反复访问）。发送首条 `health_degraded` 后置标志，后续同类异常仅写 stderr 不再重复发 notification。避免在 transport 背压保护下刷屏，同时 stderr 保留完整诊断链。

## 测试策略

- **engine**：单测覆盖 `index.ts` 的 `uncaughtException` 处理器——模拟 emit `uncaughtException`，断言只发一条 `health_degraded` notification，再次 emit 不重复发。需把处理器逻辑抽出为可测函数（当前直接挂在 `process` 上，测试需能注入 mock `sendNotification`）。
- **sidecar.rs**：Rust 测试验证 `read_stdout` 对 `health_degraded` method 的映射（若现有 Rust 测试基础设施支持；否则至少人工验证 emit）。
- **useSidecar**：组件测试验证收到 `sidecar://health` 后 state 正确设置、长任务 rpcCall 被冻结、读操作不受影响。
- **回归**：确认现有 `sidecar://crashed` / `sidecar://log` / `sidecar://progress` 行为不受影响。

## 风险

- **风险**：`uncaughtException` handler 内调用 `sendNotification` 本身可能抛异常（如 stdout 已断）。
  **缓解**：`writeLine`（`transport.ts:81-113`）内部已有 try/catch 兜底 EPIPE，不会冒泡。仍建议在 handler 内对 `sendNotification` 调用包一层 try/catch，防止"处理异常的代码本身抛异常"导致二次问题。
- **风险**：UI 层若不展示 `healthDegraded` 标志，用户可能感知不到降级。
  **缓解**：`rpcCall` 对长任务的 throw 是硬阻断，即使用户没看提示也无法继续跑长任务；读操作可用保证用户能查状态。
