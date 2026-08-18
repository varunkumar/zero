mod sidecar;
mod workspace;

use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

fn resource_path(app: &tauri::AppHandle, relative: &str) -> PathBuf {
    // `tauri dev` never populates BaseDirectory::Resource - only `tauri build`
    // copies `bundle.resources` into a resolvable resource dir. In debug
    // builds, fall back to the daemon build script's known output layout
    // (packages/daemon/dist/, see packages/daemon/scripts/build-sidecar.sh)
    // so `tauri dev` works against a locally-built sidecar without requiring
    // a full `tauri build` first. This branch compiles out entirely in
    // release builds (`tauri build`'s default profile), so production
    // behavior is unchanged - resources always resolve via BaseDirectory::Resource there.
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../daemon/dist")
            .join(relative);
        if dev_path.exists() {
            return dev_path;
        }
    }
    app.path()
        .resolve(relative, tauri::path::BaseDirectory::Resource)
        .expect("bundled resource missing")
}

fn start_daemon_and_open_window(app: &tauri::AppHandle, workspace: PathBuf) {
    let sidecar_bin = resource_path(app, "zero-daemon-sidecar");
    let node_runtime_dir = resource_path(app, "node-runtime");
    let web_dist_dir = resource_path(app, "web-dist");

    let mut handle = match sidecar::spawn(&sidecar_bin, &node_runtime_dir, &web_dist_dir, &workspace) {
        Ok(h) => h,
        Err(e) => {
            app.dialog()
                .message(format!("Failed to start Zero: {e}"))
                .title("Zero")
                .blocking_show();
            std::process::exit(1);
        }
    };

    match handle.wait_for_ready() {
        Ok(info) => {
            let url = format!("http://127.0.0.1:{}/?token={}", info.port, info.token);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Zero")
                .inner_size(1280.0, 800.0)
                .build()
                .expect("failed to open main window");
            let _ = workspace::save_remembered(&workspace);

            // Kill the sidecar when the window closes. `on_window_event`
            // requires a `Fn` closure (it may be invoked more than once),
            // so the handle needs interior mutability to be killed from it.
            let handle = std::sync::Mutex::new(handle);
            let app_handle = app.clone();
            if let Some(window) = app_handle.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        handle.lock().unwrap().kill();
                    }
                });
            }
        }
        Err(stderr_tail) => {
            app.dialog()
                .message(format!("Zero failed to start:\n\n{stderr_tail}"))
                .title("Zero")
                .blocking_show();
            std::process::exit(1);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let remembered = workspace::load_remembered()
                .filter(|p| p.exists());

            let workspace = match remembered {
                Some(p) => Some(p),
                None => handle
                    .dialog()
                    .file()
                    .set_title("Open a folder for Zero")
                    .blocking_pick_folder()
                    .map(|p| p.into_path().expect("folder path")),
            };

            match workspace {
                Some(root) => start_daemon_and_open_window(&handle, root),
                None => std::process::exit(0), // user cancelled the dialog
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Zero");
}
