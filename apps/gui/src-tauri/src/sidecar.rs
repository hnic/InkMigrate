use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
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

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[allow(dead_code)]
    pub data: Option<serde_json::Value>,
}

/// Sidecar 管理器：管理 Node 子进程的生命周期和 JSON-RPC 通信。
pub struct SidecarManager {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    next_id: u64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<RpcResponse>>>>,
    is_shutting_down: Arc<AtomicBool>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: None,
            stdin: None,
            next_id: 1,
            pending: Arc::new(Mutex::new(HashMap::new())),
            is_shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动 Node sidecar 进程。
    pub async fn start(&mut self, app: AppHandle) -> Result<(), String> {
        // 开发模式：直接用 node 运行 engine 的 dist/index.js
        // 生产模式：用打包后的 sidecar 二进制
        let engine_path = std::env::var("INKMIGRATE_ENGINE_PATH")
            .unwrap_or_else(|_| {
                // 默认指向 workspace 内的 engine dist
                "../../engine/dist/index.js".to_string()
            });

        let mut child = Command::new("node")
            .arg(&engine_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 sidecar 失败: {} (path={})", e, engine_path))?;

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

        self.child = Some(child);
        self.stdin = Some(stdin);
        Ok(())
    }

    /// 发送 RPC 请求并等待响应。
    /// 只在写 stdin 时持锁，等待响应时不持锁（允许并发查询）。
    pub async fn send_rpc(
        &mut self,
        method: String,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // 1. 短暂持锁：分配 id + 注册 pending + 写 stdin
        let rx = {
            let stdin = self.stdin.as_mut().ok_or("sidecar 未启动")?;
            let id = self.next_id;
            self.next_id += 1;

            let request = RpcRequest {
                jsonrpc: "2.0".to_string(),
                id,
                method: method.clone(),
                params: Some(params),
            };

            let (tx, rx) = oneshot::channel();
            self.pending.lock().await.insert(id, tx);

            let json = serde_json::to_string(&request)
                .map_err(|e| format!("序列化请求失败: {}", e))?;
            stdin
                .write_all(format!("{}\n", json).as_bytes())
                .await
                .map_err(|e| format!("写入 stdin 失败: {}", e))?;

            rx
        };
        // 锁已释放，等待响应不阻塞其他 RPC

        // 2. 锁外等待响应
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(600), // 长任务超时 10 分钟
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
    pub async fn shutdown(&mut self) {
        self.is_shutting_down.store(true, Ordering::Relaxed);
        if let Some(mut child) = self.child.take() {
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
                eprintln!("解析 sidecar 输出失败: {} (line={})", e, &line[..line.len().min(200)]);
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
