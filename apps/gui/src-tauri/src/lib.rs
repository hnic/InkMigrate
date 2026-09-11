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
/// 转发 job.cancel RPC 给 sidecar。sidecar 收到后设置进程级 cancel flag，
/// 长任务循环在下一次迭代边界优雅退出。这是转发型命令，不直接操作子进程。
#[tauri::command]
async fn cancel_job(
    state: State<'_, Arc<SidecarManager>>,
) -> Result<serde_json::Value, String> {
    state
        .send_rpc("job.cancel".into(), serde_json::json!({}))
        .await
}

#[tauri::command]
async fn pick_directory(title: Option<String>, default_path: Option<String>) -> Result<Option<String>, String> {
    let prompt = title.unwrap_or_else(|| "选择目录".to_string());
    tokio::task::spawn_blocking(move || {
        run_pick_directory(&prompt, default_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_file(title: Option<String>, default_path: Option<String>) -> Result<Option<String>, String> {
    let prompt = title.unwrap_or_else(|| "选择文件".to_string());
    tokio::task::spawn_blocking(move || {
        run_pick_file(&prompt, default_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_in_folder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let expanded = expand_tilde(&path);
        let p = std::path::Path::new(&expanded);
        if !p.exists() {
            return Err(format!("路径不存在: {}", path));
        }
        #[cfg(target_os = "macos")]
        {
            let mut cmd = std::process::Command::new("open");
            if p.is_dir() {
                cmd.arg(&expanded);
            } else {
                cmd.arg("-R").arg(&expanded);
            }
            cmd.status().map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            let mut cmd = std::process::Command::new("explorer");
            if p.is_dir() {
                cmd.arg(&expanded);
            } else {
                cmd.arg(format!("/select,\"{}\"", expanded));
            }
            cmd.status().map_err(|e| e.to_string())?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            std::process::Command::new("xdg-open").arg(&expanded).status().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let trimmed = url.trim();
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            return Err("仅支持打开 http:// 或 https:// 协议的网络链接".to_string());
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(trimmed)
                .status()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("rundll32")
                .args(&["url.dll,FileProtocolHandler", trimmed])
                .status()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            std::process::Command::new("xdg-open")
                .arg(trimmed)
                .status()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_path_exists(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let expanded = expand_tilde(&path);
        Ok(std::path::Path::new(&expanded).exists())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return format!("{}/{}", home, rest);
        }
    }
    path.to_string()
}

#[cfg(target_os = "macos")]
fn run_pick_directory(prompt: &str, default_path: Option<&str>) -> Result<Option<String>, String> {
    let expanded_default = default_path.map(expand_tilde);
    let script = match expanded_default.as_deref() {
        Some(path) if !path.trim().is_empty() && std::path::Path::new(path).exists() => {
            format!(
                "POSIX path of (choose folder with prompt \"{}\" default location POSIX file \"{}\")",
                prompt.replace('"', "\\\""),
                path.replace('"', "\\\"")
            )
        }
        _ => format!(
            "POSIX path of (choose folder with prompt \"{}\")",
            prompt.replace('"', "\\\"")
        ),
    };
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("执行选择目录失败: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        if err.contains("-128") || err.contains("User canceled") {
            Ok(None)
        } else {
            Err(err.trim().to_string())
        }
    }
}

#[cfg(target_os = "macos")]
fn run_pick_file(prompt: &str, default_path: Option<&str>) -> Result<Option<String>, String> {
    let expanded_default = default_path.map(expand_tilde);
    let script = match expanded_default.as_deref() {
        Some(path) if !path.trim().is_empty() && std::path::Path::new(path).exists() => {
            format!(
                "POSIX path of (choose file with prompt \"{}\" default location POSIX file \"{}\")",
                prompt.replace('"', "\\\""),
                path.replace('"', "\\\"")
            )
        }
        _ => format!(
            "POSIX path of (choose file with prompt \"{}\")",
            prompt.replace('"', "\\\"")
        ),
    };
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("执行选择文件失败: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        if err.contains("-128") || err.contains("User canceled") {
            Ok(None)
        } else {
            Err(err.trim().to_string())
        }
    }
}

#[cfg(target_os = "windows")]
fn run_pick_directory(prompt: &str, default_path: Option<&str>) -> Result<Option<String>, String> {
    let expanded = default_path.map(expand_tilde).unwrap_or_default();
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; \
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; \
        $dialog.Description = '{}'; \
        if ('{}' -ne '') {{ $dialog.SelectedPath = '{}'; }} \
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ \
            Write-Output $dialog.SelectedPath \
        }}",
        prompt.replace('\'', "''"),
        expanded.replace('\'', "''"),
        expanded.replace('\'', "''")
    );
    let output = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("执行选择目录失败: {}", e))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "windows")]
fn run_pick_file(prompt: &str, default_path: Option<&str>) -> Result<Option<String>, String> {
    let expanded = default_path.map(expand_tilde).unwrap_or_default();
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; \
        $dialog = New-Object System.Windows.Forms.OpenFileDialog; \
        $dialog.Title = '{}'; \
        if ('{}' -ne '') {{ $dialog.InitialDirectory = '{}'; }} \
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ \
            Write-Output $dialog.FileName \
        }}",
        prompt.replace('\'', "''"),
        expanded.replace('\'', "''"),
        expanded.replace('\'', "''")
    );
    let output = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("执行选择文件失败: {}", e))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn run_pick_directory(_prompt: &str, _default_path: Option<&str>) -> Result<Option<String>, String> {
    let output = std::process::Command::new("zenity")
        .args(&["--file-selection", "--directory"])
        .output()
        .map_err(|e| format!("需要 zenity: {}", e))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    } else {
        Ok(None)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn run_pick_file(_prompt: &str, _default_path: Option<&str>) -> Result<Option<String>, String> {
    let output = std::process::Command::new("zenity")
        .args(&["--file-selection"])
        .output()
        .map_err(|e| format!("需要 zenity: {}", e))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    } else {
        Ok(None)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Arc::new(SidecarManager::new());

    let sidecar_for_exit = sidecar.clone();
    tauri::Builder::default()
        .manage(sidecar.clone())
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
        .invoke_handler(tauri::generate_handler![
            send_rpc,
            cancel_job,
            pick_directory,
            pick_file,
            open_in_folder,
            open_url,
            check_path_exists
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            // 应用退出时关闭 sidecar 进程。用 RunEvent::Exit 而非窗口 Destroyed
            // （Destroyed 对任意窗口销毁都触发）；block_on 同步等待 kill 完成——
            // spawn 出去的异步任务会随运行一起被丢弃，可能来不及执行而泄漏子进程。
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(async {
                    // 先有界等待启动收尾：若 setup 里的启动任务仍在 spawn 半途，
                    // 直接 shutdown() 会取到 None 而泄漏随后才注册的子进程
                    sidecar_for_exit.wait_startup_settled().await;
                    sidecar_for_exit.shutdown().await;
                });
            }
        });
}
