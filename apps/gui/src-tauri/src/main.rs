// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // release 构建（Windows 下 windows_subsystem="windows"）没有控制台，
    // stderr 丢失，启动失败多以 panic 形式出现（见 lib.rs 的 .expect）；
    // 落盘 panic 信息便于事后排查静默启动失败
    #[cfg(not(debug_assertions))]
    std::panic::set_hook(Box::new(|info| {
        use std::io::Write;
        let log_path = std::env::temp_dir().join("inkmigrate-gui-panic.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            let _ = writeln!(f, "[{:?}] {}", std::time::SystemTime::now(), info);
        }
    }));
    inkmigrate_gui_lib::run()
}
