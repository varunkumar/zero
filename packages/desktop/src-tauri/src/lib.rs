mod sidecar;
mod workspace;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// Holds the running sidecar in app-managed state so both the window's
/// `CloseRequested` handler and the app-level `ExitRequested` handler (which
/// is what actually fires on macOS Cmd+Q / Dock-quit - `CloseRequested`
/// doesn't) can reach it. `None` before the daemon starts, or once it's
/// already been killed via either path.
struct SidecarState(Mutex<Option<sidecar::SidecarHandle>>);

/// Kills the managed sidecar, if one is currently running. Safe to call from
/// either teardown path, and safe to call more than once - `take()` leaves
/// `None` behind so a second call is a no-op.
fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut handle) = guard.take() {
                handle.kill();
            }
        }
    }
}

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
                .title(format!("Zero {}", env!("CARGO_PKG_VERSION")))
                .inner_size(1280.0, 800.0)
                .build()
                .expect("failed to open main window");
            let _ = workspace::save_remembered(&workspace);

            if let Some(state) = app.try_state::<SidecarState>() {
                *state.0.lock().unwrap() = Some(handle);
            }

            // Also kill the sidecar on a plain window close (dragging the
            // red button) - ExitRequested alone doesn't cover that path.
            let app_handle = app.clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        kill_sidecar(&app_handle);
                    }
                });
            }
        }
        Err(stderr_tail) => {
            // The sidecar spawned but never became ready - kill it before
            // giving up, or it outlives the app that just gave up on it.
            handle.kill();
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState(Mutex::new(None)))
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
        .build(tauri::generate_context!())
        .expect("error while building Zero");

    // `RunEvent::ExitRequested` is what actually fires on macOS Cmd+Q /
    // Dock-quit - `WindowEvent::CloseRequested` (handled above, in
    // `start_daemon_and_open_window`) only covers closing the window itself.
    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            kill_sidecar(app_handle);
        }
    });
}
