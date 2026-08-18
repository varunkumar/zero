use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Wry};

pub const OPEN_FOLDER_ID: &str = "open_folder";

/// Builds the app's native menu bar: currently just a File menu with an
/// Open Folder... item, which is the app's only menu-driven action.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let open_folder = MenuItemBuilder::with_id(OPEN_FOLDER_ID, "Open Folder...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_folder)
        .build()?;
    MenuBuilder::new(app).item(&file_menu).build()
}
