mod sidecar;

use sidecar::SidecarManager;
use tauri::Emitter;
use std::sync::Arc;
use tauri::State;

/// Tauri command: 发送 JSON-RPC 请求到 sidecar。
///
/// 并发设计：state 是 `Arc<SidecarManager>`，内部状态（next_id/stdin/child）
/// 已各自用原子/短锁内部化，因此此处不加外层锁。多个 RPC 可并发等待响应，
/// 长任务（cleanup/migrate）不会阻塞瞬时查询（auth.status）。
#[tauri::command]
async fn send_rpc(
    method: String,
    params: serde_json::Value,
    state: State<'_, Arc<SidecarManager>>,
) -> Result<serde_json::Value, String> {
    state.send_rpc(method, params).await
}

/// Tauri command: 终止当前正在运行的长任务（scan/migrate/cleanup）。
///
/// 转发 cancel.cancel RPC 给 sidecar。sidecar 收到后设置进程级 cancel flag，
/// 长任务循环在下一次迭代边界优雅退出。这是转发型命令，不直接操作子进程。
#[tauri::command]
async fn cancel_job(
    state: State<'_, Arc<SidecarManager>>,
) -> Result<serde_json::Value, String> {
    state
        .send_rpc("cancel.cancel".into(), serde_json::json!({}))
        .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Arc::new(SidecarManager::new());

    let sidecar_for_exit = sidecar.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar.clone())
        .on_window_event(move |_window, event| {
            // 应用退出时关闭 sidecar 进程
            if let tauri::WindowEvent::Destroyed = event {
                let sc = sidecar_for_exit.clone();
                tauri::async_runtime::spawn(async move {
                    sc.shutdown().await;
                });
            }
        })
        .setup(move |app| {
            // 启动 sidecar 进程
            let sidecar_clone = sidecar.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar_clone.start(app_handle.clone()).await {
                    eprintln!("启动 sidecar 失败: {}", e);
                    let _ = app_handle.emit("sidecar://crashed", serde_json::json!({
                        "message": format!("sidecar 启动失败: {}", e)
                    }));
                } else {
                    eprintln!("sidecar 启动成功");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_rpc, cancel_job])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
