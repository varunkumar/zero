use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct StoredWorkspace {
    path: String,
}

fn store_path_in(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("workspace.json")
}

fn store_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| store_path_in(&d.join("zero-desktop")))
}

pub fn load_remembered() -> Option<PathBuf> {
    load_remembered_from(&store_path()?)
}

fn load_remembered_from(path: &Path) -> Option<PathBuf> {
    let contents = std::fs::read_to_string(path).ok()?;
    let stored: StoredWorkspace = serde_json::from_str(&contents).ok()?;
    let candidate = PathBuf::from(stored.path);
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

pub fn save_remembered(path: &Path) -> std::io::Result<()> {
    let store = store_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no app data dir available")
    })?;
    save_remembered_to(&store, path)
}

fn save_remembered_to(store_path: &Path, path: &Path) -> std::io::Result<()> {
    if let Some(parent) = store_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let stored = StoredWorkspace {
        path: path.to_string_lossy().into_owned(),
    };
    std::fs::write(store_path, serde_json::to_string(&stored)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_saved_path() {
        let dir = tempfile_dir();
        let store = dir.join("workspace.json");
        let workspace = dir.join("my-project");
        std::fs::create_dir_all(&workspace).unwrap();

        save_remembered_to(&store, &workspace).unwrap();
        let loaded = load_remembered_from(&store);

        assert_eq!(loaded, Some(workspace));
    }

    #[test]
    fn returns_none_when_remembered_path_no_longer_exists() {
        let dir = tempfile_dir();
        let store = dir.join("workspace.json");
        let missing = dir.join("gone");

        save_remembered_to(&store, &missing).unwrap();
        let loaded = load_remembered_from(&store);

        assert_eq!(loaded, None);
    }

    #[test]
    fn returns_none_when_no_store_file_exists() {
        let dir = tempfile_dir();
        let store = dir.join("workspace.json");

        assert_eq!(load_remembered_from(&store), None);
    }

    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zero-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
