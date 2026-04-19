// Pyrodeck Tauri app — sidecar mode.
//
// Architecture:
//   1. On startup, spawn `pyrodeck-server` sidecar with PYRODECK_SIDECAR=1.
//   2. The server binds loopback on an ephemeral port and prints "sidecar-port:{n}".
//   3. Navigate the main window to http://127.0.0.1:{n}.
//
// To build:
//   1. `pnpm package:server` → dist-server/pyrodeck-server[.exe]
//   2. Copy to src-tauri/binaries/pyrodeck-server-{target-triple}[.exe]
//      e.g. x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu, aarch64-apple-darwin
//   3. `cargo tauri build`

use tauri::Manager;
use tauri_plugin_shell::ShellExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let sidecar_cmd = app.shell().sidecar("pyrodeck-server")?;
            let (mut rx, _child) = sidecar_cmd
                .env("PYRODECK_SIDECAR", "1")
                .spawn()?;

            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(data) = event {
                        let line = String::from_utf8_lossy(&data);
                        if let Some(port_str) = line.trim().strip_prefix("sidecar-port:") {
                            if let Ok(port) = port_str.trim().parse::<u16>() {
                                if let Some(window) = handle.get_webview_window("main") {
                                    let url = format!("http://127.0.0.1:{}", port);
                                    let _ = window.navigate(url.parse().unwrap());
                                }
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pyrodeck");
}
