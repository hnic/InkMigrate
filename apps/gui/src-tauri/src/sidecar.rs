use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, oneshot};
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

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[allow(dead_code)]
    pub data: Option<serde_json::Value>,
}

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
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            is_shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动 Node sidecar 进程。
    ///
    /// 开发模式（INKMIGRATE_ENGINE_PATH 环境变量存在）：用系统 node 运行指定的 engine。
    /// 生产模式（打包后）：用 resource_dir 下的打包 Node + engine + chromium。
    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        let (node_bin, engine_path, browsers_path, native_binding) = resolve_sidecar_paths(&app);

        let mut cmd = Command::new(&node_bin);
        cmd.arg("--max-old-space-size=8192")
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

        // 4. 写 stdin（短锁：只保护 write_all，保证一行不被并发写交错）
        {
            let mut stdin_guard = self.stdin.lock().await;
            let stdin = stdin_guard.as_mut().ok_or("sidecar 未启动")?;
            stdin
                .write_all(format!("{}\n", json).as_bytes())
                .await
                .map_err(|e| format!("写入 stdin 失败: {}", e))?;
        }
        // stdin 锁已释放，等待响应不阻塞其他 RPC

        // 5. 锁外等待响应（长任务如全量扫描/迁移可能需要数小时）
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(rpc_timeout_secs()),
            rx,
        )
        .await
        .map_err(|_| "RPC 超时".to_string())?
        .map_err(|_| "RPC 响应通道关闭".to_string())?;

        if let Some(err) = response.error {
            return Err(format!("[{}] {}", err.code, err.message));
        }

        response.result.ok_or_else(|| "响应缺少 result".to_string())
    }

    /// 关闭 sidecar 进程。
    pub async fn shutdown(&self) {
        self.is_shutting_down.store(true, Ordering::Relaxed);
        if let Some(mut child) = self.child.lock().await.take() {
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
            let _ = app.emit(event_name, msg.params.clone().unwrap_or(serde_json::Value::Null));
        }
    }

    eprintln!("sidecar stdout 已关闭");

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
fn resolve_sidecar_paths(app: &AppHandle) -> (String, String, Option<String>, Option<String>) {
    // 开发模式逃生阀：环境变量指向 workspace 内的 engine
    if let Ok(engine_path) = std::env::var("INKMIGRATE_ENGINE_PATH") {
        return ("node".to_string(), engine_path, None, None);
    }

    // 生产模式：resource_dir/resources/sidecar/ 下的绝对路径
    let sidecar_dir = match app.path().resource_dir() {
        Ok(dir) => dir.join("resources").join("sidecar"),
        Err(_) => {
            eprintln!("[sidecar] 警告: resource_dir 解析失败，回退到相对路径");
            return ("node".to_string(), "../../engine/dist/index.js".to_string(), None, None);
        }
    };

    let node_bin = if cfg!(target_os = "windows") {
        sidecar_dir.join("node/node.exe")
    } else {
        sidecar_dir.join("node/bin/node")
    };

    let engine_path = sidecar_dir.join("engine-bundle.cjs");
    let browsers_path = sidecar_dir.join("browsers");
    let native_binding = sidecar_dir.join("native/better_sqlite3.node");

    (
        node_bin.to_string_lossy().into_owned(),
        engine_path.to_string_lossy().into_owned(),
        Some(browsers_path.to_string_lossy().into_owned()),
        Some(native_binding.to_string_lossy().into_owned()),
    )
}
