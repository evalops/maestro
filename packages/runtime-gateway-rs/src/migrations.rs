//! Atomic persistence primitives used by native state migrations.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) async fn atomic_write_validated_json<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: serde::Serialize,
{
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|error| format!("serialized migration output is invalid: {error}"))?;
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || atomic_replace(&path, &bytes))
        .await
        .map_err(|error| format!("migration writer task failed: {error}"))?
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = temporary_path(path);
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(&temporary).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("temporary migration output failed validation: {error}"))?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("state.json");
    path.with_file_name(format!(
        ".{name}.migration-{}-{counter}.tmp",
        std::process::id()
    ))
}
