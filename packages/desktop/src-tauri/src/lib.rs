mod sidecar;
mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// Holds every running sidecar, keyed by the window label it was opened
/// for, in app-managed state so both a window's `CloseRequested` handler
/// and the app-level `ExitRequested` handler (which is what actually
/// fires on macOS Cmd+Q / Dock-quit - `CloseRequested` doesn't) can reach
/// it. Empty before any daemon starts; entries are removed as their
/// window closes.
struct SidecarState(Mutex<HashMap<String, sidecar::SidecarHandle>>);

static WORKSPACE_COUNTER: AtomicU32 = AtomicU32::new(1);

/// Generates a fresh, process-lifetime-unique window label for a
/// workspace opened after the first one (which is always `"main"`).
fn next_workspace_label() -> String {
    let n = WORKSPACE_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("workspace-{n}")
}

/// Kills and removes the sidecar for one window, if it's still running.
/// Safe to call more than once for the same label - a second call finds
/// nothing to remove and is a no-op.
fn kill_sidecar(app: &tauri::AppHandle, label: &str) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut handle) = guard.remove(label) {
                handle.kill();
            }
        }
    }
}

/// Kills every running sidecar. Used on app-wide quit (Cmd+Q / Dock
/// quit), where every open window's sidecar needs to go, not just one.
fn kill_all_sidecars(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            for (_, mut handle) in guard.drain() {
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

fn start_daemon_and_open_window(app: &tauri::AppHandle, workspace: PathBuf, label: &str) {
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
            WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.parse().unwrap()))
                .title(format!("Zero {}", env!("CARGO_PKG_VERSION")))
                .inner_size(1280.0, 800.0)
                .build()
                .expect("failed to open window");
            let _ = workspace::save_remembered(&workspace);

            if let Some(state) = app.try_state::<SidecarState>() {
                state.0.lock().unwrap().insert(label.to_string(), handle);
            }

            // Also kill this window's sidecar on a plain window close
            // (dragging the red button) - ExitRequested alone doesn't
            // cover that path.
            let app_handle = app.clone();
            let label_owned = label.to_string();
            if let Some(window) = app.get_webview_window(label) {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        kill_sidecar(&app_handle, &label_owned);
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
        .manage(SidecarState(Mutex::new(HashMap::new())))
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
                Some(root) => start_daemon_and_open_window(&handle, root, "main"),
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
            kill_all_sidecars(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_distinct_incrementing_labels() {
        let a = next_workspace_label();
        let b = next_workspace_label();
        assert_ne!(a, b);
        assert!(a.starts_with("workspace-"));
        assert!(b.starts_with("workspace-"));
    }
}
