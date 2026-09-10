use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, oneshot, watch};
use std::collections::HashMap;

/// JSON-RPC 2.0 Request
#[derive(Debug, Serialize, Clone)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 Response
#[derive(Debug, Deserialize)]
pub struct RpcResponse {
    pub id: Option<u64>,
    pub result: Option<serde_json::Value>,
    pub error: Option<RpcError>,
    pub method: Option<String>, // 如果有 method，说明是 notification
    pub params: Option<serde_json::Value>,
}

/// 单次 RPC 等待响应的默认超时（秒）。长任务（全量扫描/迁移/清理）可能持续数小时，
/// 24h 上限足以覆盖最大单任务时长，同时防止 sidecar 永久挂起时前端 busy 不复位。
/// 可通过环境变量 `INKMIGRATE_RPC_TIMEOUT_SECS` 覆盖（调试/特殊场景）。
const DEFAULT_RPC_TIMEOUT_SECS: u64 = 24 * 3600;

/// 解析 RPC 超时：优先环境变量，回退默认值。
fn rpc_timeout_secs() -> u64 {
    std::env::var("INKMIGRATE_RPC_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_RPC_TIMEOUT_SECS)
}

/// 写 stdin 的超时（秒）。单行 JSON 只需毫秒级；超时说明 sidecar 已停止
/// 读取输入（挂起/管道写满），不应无限期持有 stdin 锁阻塞其他 RPC。
const STDIN_WRITE_TIMEOUT_SECS: u64 = 10;

/// 应用退出时等待 sidecar 启动收尾的上限（秒）。正常启动只需毫秒级。
const EXIT_STARTUP_WAIT_SECS: u64 = 5;

/// 优雅退出宽限（秒）：关闭 stdin 后等待 engine 自行收尾排干的时限，
/// 超时才强制 kill（避免迁移中的 SQLite 事务被 SIGKILL 截断）。
const GRACEFUL_EXIT_SECS: u64 = 5;

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[allow(dead_code)]
    pub data: Option<serde_json::Value>,
}

/// sidecar 启动状态。webview 加载可能早于 sidecar 就绪，`send_rpc` 据此
/// 在就绪前等待，避免前端首条 RPC 以「sidecar 未启动」竞态失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidecarState {
    Starting,
    Ready,
    Failed,
}

/// `send_rpc` 等待 sidecar 启动的上限（秒）。正常启动只需毫秒级；
/// 上限只用于启动卡死时兜底，防止请求永久挂起。
const STARTUP_WAIT_TIMEOUT_SECS: u64 = 30;

/// Sidecar 管理器：管理 Node 子进程的生命周期和 JSON-RPC 通信。
///
/// 并发设计：所有可变状态都内部化了（next_id 用原子、stdin/child 用内部 Mutex），
/// 因此 `send_rpc` 是 `&self`，多个 RPC 可以并发等待响应而互不阻塞。
/// 等待长任务（如全量清理）的响应期间，瞬时查询（如 auth.status）不会被阻塞。
pub struct SidecarManager {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<RpcResponse>>>>,
    is_shutting_down: Arc<AtomicBool>,
    /// 启动状态广播：Starting → Ready/Failed 只迁移一次。
    state_tx: watch::Sender<SidecarState>,
    state_rx: watch::Receiver<SidecarState>,
}

impl SidecarManager {
    pub fn new() -> Self {
        let (state_tx, state_rx) = watch::channel(SidecarState::Starting);
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            is_shutting_down: Arc::new(AtomicBool::new(false)),
            state_tx,
            state_rx,
        }
    }

    /// 启动 Node sidecar 进程。
    ///
    /// 开发模式（INKMIGRATE_ENGINE_PATH 环境变量存在）：用系统 node 运行指定的 engine。
    /// 生产模式（打包后）：用 resource_dir 下的打包 Node + engine + chromium。
    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        let result = self.start_inner(app).await;
        // 无论成败都广播状态：让等待中的 send_rpc 立即放行或快速失败
        let _ = self.state_tx.send(match result {
            Ok(()) => SidecarState::Ready,
            Err(_) => SidecarState::Failed,
        });
        result
    }

    async fn start_inner(&self, app: AppHandle) -> Result<(), String> {
        let (node_bin, engine_path, browsers_path, native_binding) = resolve_sidecar_paths(&app)?;

        let mut cmd = Command::new(&node_bin);
        // kill_on_drop：Child 被丢弃时兜底杀掉子进程，防止 panic 路径或
        // 退出竞态（Exit 与启动任务并发）泄漏 node/chromium 孤儿进程
        cmd.kill_on_drop(true)
            .arg("--max-old-space-size=8192")
            .arg(&engine_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // 注入 PLAYWRIGHT_BROWSERS_PATH，让 engine 用打包的 chromium 而非系统缓存。
        if let Some(bp) = &browsers_path {
            cmd.env("PLAYWRIGHT_BROWSERS_PATH", bp);
        }
        // 注入 BETTER_SQLITE3_BINDING，让 better-sqlite3 用打包的 native 模块
        // （bundle 后 __dirname 不可靠，用 nativeBinding 显式路径加载）。
        if let Some(nb) = &native_binding {
            cmd.env("BETTER_SQLITE3_BINDING", nb);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 sidecar 失败: {} (node={} path={})", e, node_bin, engine_path))?;

        let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
        let stderr = child.stderr.take().ok_or("无法获取 stderr")?;

        // 启动 stderr 读取任务——转发到终端 + Tauri Event
        let app_for_stderr = app.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[sidecar] {}", line);
                let _ = app_for_stderr.emit("sidecar://log", serde_json::json!({
                    "level": "info",
                    "message": line,
                }));
            }
        });

        // 启动 stdout 读取任务
        let pending = self.pending.clone();
        let app_clone = app.clone();
        let shutdown_flag = self.is_shutting_down.clone();
        tokio::spawn(async move {
            read_stdout(stdout, pending, app_clone, shutdown_flag).await;
        });

        *self.child.lock().await = Some(child);
        *self.stdin.lock().await = Some(stdin);
        Ok(())
    }

    /// 发送 RPC 请求并等待响应。
    ///
    /// 并发安全：`&self` 允许多个调用者同时进入。分配 id（原子）与写 stdin
    /// 各自用短锁保护；等待响应在所有锁之外进行。因此长任务（数小时的
    /// cleanup/migrate）在等响应期间，不会阻塞其他瞬时查询（如 auth.status）。
    pub async fn send_rpc(
        &self,
        method: String,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // 0. 前端加载可能早于 sidecar 就绪（setup 里是异步 spawn 启动的）：
        //    先等启动完成再继续，避免首条 RPC 竞态失败；启动失败则快速返回。
        {
            let mut state = self.state_rx.clone();
            state.borrow_and_update(); // 标记当前值为已读，changed() 只等后续迁移
            while *state.borrow() == SidecarState::Starting {
                if tokio::time::timeout(
                    std::time::Duration::from_secs(STARTUP_WAIT_TIMEOUT_SECS),
                    state.changed(),
                )
                .await
                .is_err()
                {
                    return Err("等待 sidecar 启动超时".to_string());
                }
            }
            if *state.borrow() == SidecarState::Failed {
                return Err("sidecar 未启动".to_string());
            }
        }

        // 1. 原子分配 id（无锁）
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        // 2. 序列化请求（CPU 工作，不持任何锁）
        let request = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method,
            params: Some(params),
        };
        let json = serde_json::to_string(&request)
            .map_err(|e| format!("序列化请求失败: {}", e))?;

        // 3. 注册 pending 回调（短锁）
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        // 4. 写 stdin（短锁：只保护 write_all，保证一行不被并发写交错）。
        //    写入加超时：sidecar 停止读取输入导致管道缓冲写满时 write_all 会
        //    永久阻塞，且此时持有 stdin 锁，会连带卡死所有并发 RPC。
        let write_result: Result<(), String> = async {
            let mut stdin_guard = self.stdin.lock().await;
            let stdin = match stdin_guard.as_mut() {
                Some(stdin) => stdin,
                None => return Err("sidecar 未启动".to_string()),
            };
            let line = format!("{}\n", json);
            tokio::time::timeout(
                std::time::Duration::from_secs(STDIN_WRITE_TIMEOUT_SECS),
                stdin.write_all(line.as_bytes()),
            )
            .await
            .map_err(|_| "写入 stdin 超时（sidecar 可能已停止读取输入）".to_string())?
            .map_err(|e| format!("写入 stdin 失败: {}", e))
        }
        .await;
        // 写失败必须清理 pending 注册：id 永不复用，残留的 sender 会让 map
        // 随错误次数单调增长（内存泄漏）
        if let Err(e) = write_result {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        // stdin 锁已释放，等待响应不阻塞其他 RPC

        // 5. 锁外等待响应（长任务如全量扫描/迁移可能需要数小时）。
        //    超时同样要清理 pending 注册，原因同上
        let response = match tokio::time::timeout(
            std::time::Duration::from_secs(rpc_timeout_secs()),
            rx,
        )
        .await
        {
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err("RPC 超时".to_string());
            }
            Ok(v) => v.map_err(|_| "RPC 响应通道关闭".to_string())?,
        };

        if let Some(err) = response.error {
            return Err(format!("[{}] {}", err.code, err.message));
        }

        response.result.ok_or_else(|| "响应缺少 result".to_string())
    }

    /// 等待启动收尾（Starting → Ready/Failed），用于退出路径：确保启动任务
    /// 已注册子进程（或已放弃）后再 kill，避免 start() 半途时 shutdown()
    /// 取到 None 而泄漏刚注册的子进程。有界兜底，防启动卡死时退出流程挂死。
    pub async fn wait_startup_settled(&self) {
        let mut state = self.state_rx.clone();
        state.borrow_and_update(); // 标记当前值为已读，changed() 只等后续迁移
        while *state.borrow() == SidecarState::Starting {
            if tokio::time::timeout(
                std::time::Duration::from_secs(EXIT_STARTUP_WAIT_SECS),
                state.changed(),
            )
            .await
            .is_err()
            {
                return;
            }
        }
    }

    /// 关闭 sidecar 进程：优先优雅退出——engine 在 stdin 关闭后会收尾并排干
    /// stdout；有界宽限后再强制 kill，避免长任务中途被 SIGKILL 截断事务。
    pub async fn shutdown(&self) {
        self.is_shutting_down.store(true, Ordering::Relaxed);
        // 关闭 stdin → engine 读到 EOF 后自行收尾退出
        self.stdin.lock().await.take();
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(GRACEFUL_EXIT_SECS),
                child.wait(),
            )
            .await;
            let _ = child.kill().await;
        }
    }
}

/// 读取 sidecar stdout，每行一个 JSON-RPC 消息。
/// Response（有 id）→ 匹配 pending 回调；Notification（有 method 无 id）→ 转发到前端。
async fn read_stdout(
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<RpcResponse>>>>,
    app: AppHandle,
    is_shutting_down: Arc<AtomicBool>,
) {
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        let msg: RpcResponse = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                // 截断用于日志：必须回退到 UTF-8 字符边界，否则切片会 panic
                // （中文等占 3 字节，固定切 200 可能落在字符中间）
                let mut end = line.len().min(200);
                while !line.is_char_boundary(end) { end -= 1; }
                eprintln!("解析 sidecar 输出失败: {} (line={})", e, &line[..end]);
                continue;
            }
        };

        // 有 id 的是 Response
        if let Some(id) = msg.id {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(msg);
            }
        }
        // 有 method 的是 Notification → 转发到前端
        else if let Some(method_str) = &msg.method {
            let event_name = match method_str.as_str() {
                "progress" => "sidecar://progress",
                "log" => "sidecar://log",
                "health_degraded" => "sidecar://health",
                other => {
                    eprintln!("未知 notification: {}", other);
                    continue;
                }
            };
            // msg 此后不再使用，params 可直接移动（method 仅借用，字段不相交）
            let _ = app.emit(event_name, msg.params.unwrap_or(serde_json::Value::Null));
        }
    }

    eprintln!("sidecar stdout 已关闭");

    // 进程退出：唤醒所有在飞的 send_rpc，否则它们要等满整个 RPC 超时
    // （最长 24h）才失败，期间前端命令一直挂起
    let reason = if is_shutting_down.load(Ordering::Relaxed) {
        "应用正在关闭"
    } else {
        "sidecar 进程已退出"
    };
    for (_, tx) in pending.lock().await.drain() {
        let _ = tx.send(RpcResponse {
            id: None,
            result: None,
            error: Some(RpcError {
                code: -32000,
                message: reason.to_string(),
                data: None,
            }),
            method: None,
            params: None,
        });
    }

    // 只有非正常关闭时才通知前端（shutdown 时不报崩溃）
    if !is_shutting_down.load(Ordering::Relaxed) {
        let _ = app.emit("sidecar://crashed", serde_json::json!({
            "message": "sidecar 进程已退出，请重启应用"
        }));
    }
}

/// 解析 sidecar 的路径：node 二进制、engine 入口、chromium 目录、native binding。
///
/// 返回 (node_bin, engine_path, Option<browsers_path>, Option<native_binding>)。
/// - 开发模式：INKMIGRATE_ENGINE_PATH 存在时，用系统 node + 该路径，不注入环境变量。
/// - 生产模式：从 resource_dir()/sidecar/ 解析绝对路径，注入环境变量。
fn resolve_sidecar_paths(
    app: &AppHandle,
) -> Result<(String, String, Option<String>, Option<String>), String> {
    // 开发模式逃生阀：环境变量指向 workspace 内的 engine
    if let Ok(engine_path) = std::env::var("INKMIGRATE_ENGINE_PATH") {
        return Ok(("node".to_string(), engine_path, None, None));
    }

    // 生产模式：resource_dir/resources/sidecar/ 下的绝对路径。
    // resource_dir 解析失败属于不可恢复的安装损坏，直接快速失败，
    // 不再回退到 cwd 相对路径（那条路径在打包环境下必然找不到，
    // 只会把失败推迟到 spawn 并给出误导性的报错）
    let sidecar_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir 解析失败: {}（应用资源缺失或安装损坏，请重新安装）", e))
        .map(|dir| dir.join("resources").join("sidecar"))?;

    let node_bin = if cfg!(target_os = "windows") {
        sidecar_dir.join("node/node.exe")
    } else {
        sidecar_dir.join("node/bin/node")
    };

    let engine_path = sidecar_dir.join("engine-bundle.cjs");
    let browsers_path = sidecar_dir.join("browsers");
    let native_binding = sidecar_dir.join("native/better_sqlite3.node");

    Ok((
        node_bin.to_string_lossy().into_owned(),
        engine_path.to_string_lossy().into_owned(),
        Some(browsers_path.to_string_lossy().into_owned()),
        Some(native_binding.to_string_lossy().into_owned()),
    ))
}
