mod sidecar;

use sidecar::SidecarManager;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

/// Tauri command: 发送 JSON-RPC 请求到 sidecar。
#[tauri::command]
async fn send_rpc(
    method: String,
    params: serde_json::Value,
    state: State<'_, Arc<Mutex<SidecarManager>>>,
) -> Result<serde_json::Value, String> {
    let mut mgr = state.lock().await;
    mgr.send_rpc(method, params).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Arc::new(Mutex::new(SidecarManager::new()));

    let sidecar_for_exit = sidecar.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar.clone())
        .on_window_event(move |_window, event| {
            // 应用退出时关闭 sidecar 进程
            if let tauri::WindowEvent::Destroyed = event {
                let sc = sidecar_for_exit.clone();
                tauri::async_runtime::spawn(async move {
                    let mut mgr = sc.lock().await;
                    mgr.shutdown().await;
                });
            }
        })
        .setup(move |app| {
            // 启动 sidecar 进程
            let sidecar_clone = sidecar.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut mgr = sidecar_clone.lock().await;
                if let Err(e) = mgr.start(app_handle).await {
                    eprintln!("启动 sidecar 失败: {}", e);
                } else {
                    eprintln!("sidecar 启动成功");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_rpc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
