mod menu;
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

/// Shows the native folder picker and, if the user picks a folder, spawns
/// a sidecar and opens a new window for it under a fresh `workspace-{n}`
/// label. A cancelled dialog is a no-op - unlike first launch, there's no
/// empty-app state to fall back to since other windows may already be
/// open.
///
/// This handler runs on the live main thread (it's an `on_menu_event`
/// callback), so every dialog call here uses the non-blocking,
/// callback-based API (`pick_folder`/`show`, not
/// `blocking_pick_folder`/`blocking_show`) - the tauri-plugin-dialog docs
/// call out that the blocking variants deadlock when called on the main
/// thread, because they wait on a channel for a callback that itself
/// needs the main thread's event loop to keep running to fire. The
/// blocking variants are only safe in contexts like `setup()`, which run
/// before the event loop starts (see `start_daemon_and_open_window`).
/// Spawning the sidecar and waiting for it to become ready can also take
/// a few seconds, so that work happens on a background thread; only the
/// final window-creation step is dispatched back to the main thread via
/// `run_on_main_thread`, since window/webview creation isn't safe off it.
fn open_new_workspace_window(app: &tauri::AppHandle) {
    let app = app.clone();
    app.dialog()
        .file()
        .set_title("Open a folder for Zero")
        .pick_folder(move |picked| {
            let Some(root) = picked.map(|p| p.into_path().expect("folder path")) else {
                return;
            };

            let app = app.clone();
            std::thread::spawn(move || {
                let sidecar_bin = resource_path(&app, "zero-daemon-sidecar");
                let node_runtime_dir = resource_path(&app, "node-runtime");
                let web_dist_dir = resource_path(&app, "web-dist");

                let mut handle = match sidecar::spawn(&sidecar_bin, &node_runtime_dir, &web_dist_dir, &root) {
                    Ok(h) => h,
                    Err(e) => {
                        let app_for_main = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            app_for_main
                                .dialog()
                                .message(format!("Failed to start Zero: {e}"))
                                .title("Zero")
                                .show(|_| {});
                        });
                        return;
                    }
                };

                match handle.wait_for_ready() {
                    Ok(info) => {
                        let app_for_main = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            let label = next_workspace_label();
                            open_window_for_ready_workspace(&app_for_main, root, &label, handle, info);
                        });
                    }
                    Err(stderr_tail) => {
                        // The sidecar spawned but never became ready -
                        // kill it before giving up, or it outlives the
                        // app that just gave up on it.
                        handle.kill();
                        let app_for_main = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            app_for_main
                                .dialog()
                                .message(format!("Zero failed to start:\n\n{stderr_tail}"))
                                .title("Zero")
                                .show(|_| {});
                        });
                    }
                }
            });
        });
}

/// Builds the window for an already-ready sidecar and files it into
/// `SidecarState`. Must run on the main thread - window/webview creation
/// is not safe off it.
fn open_window_for_ready_workspace(
    app: &tauri::AppHandle,
    workspace: PathBuf,
    label: &str,
    handle: sidecar::SidecarHandle,
    info: sidecar::ReadyInfo,
) {
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

    // Also kill this window's sidecar on a plain window close (dragging
    // the red button) - ExitRequested alone doesn't cover that path.
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

/// Synchronous spawn-and-open used only for the very first window at app
/// launch, before the event loop is running and no other window exists
/// to freeze - so blocking here is harmless, unlike `open_new_workspace_window`.
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
        Ok(info) => open_window_for_ready_workspace(app, workspace, label, handle, info),
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
        .menu(|app| menu::build(app))
        .on_menu_event(|app, event| {
            if event.id().0 == menu::OPEN_FOLDER_ID {
                open_new_workspace_window(app);
            }
        })
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
