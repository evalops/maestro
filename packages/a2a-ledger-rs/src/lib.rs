//! Authoritative SQLite storage for the local A2A ledger.

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const SCHEMA_VERSION: i64 = 1;
/// Bound on manual symlink following in `resolve_json_path`, so a cyclic
/// alias reports an error instead of looping forever.
const MAX_LEDGER_SYMLINK_HOPS: usize = 32;

/// The database adjacent to the legacy JSON path. Keeping path selection at
/// the old boundary preserves all existing CLI and environment overrides.
pub fn database_path(json_path: &Path) -> PathBuf {
    let mut name = json_path.file_name().unwrap_or_default().to_os_string();
    name.push(".sqlite3");
    json_path.with_file_name(name)
}

/// Switch the database to WAL, tolerating `SQLITE_BUSY`/`SQLITE_LOCKED`.
///
/// Changing the journal mode needs an exclusive lock and SQLite does not run
/// the busy handler for that acquisition, so two writers opening a fresh
/// ledger at the same moment raced: the second `PRAGMA journal_mode=WAL`
/// failed with "database is locked" (seen in CI on
/// `concurrent_connections_preserve_unrelated_updates_and_commit_order`).
/// Retry briefly; if the lock never frees, keep the rollback journal — every
/// write below runs in an IMMEDIATE transaction guarded by `busy_timeout`, so
/// correctness does not depend on WAL, only throughput does.
fn enable_wal(connection: &Connection) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match connection.pragma_update(None, "journal_mode", "WAL") {
            Ok(()) => return Ok(()),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                if Instant::now() >= deadline {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn open(json_path: &Path) -> Result<Connection> {
    if let Some(parent) = json_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .with_context(|| format!("create A2A ledger directory {}", parent.display()))?;
    }
    let json_path = resolve_json_path(json_path)?;
    let db_path = database_path(&json_path);
    let mut connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::default() | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .with_context(|| format!("open A2A task database {}", db_path.display()))?;
    restrict_database_permissions(&db_path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    enable_wal(&connection)?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS ledger_items (
           collection TEXT NOT NULL, item_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
           payload TEXT NOT NULL, PRIMARY KEY(collection, item_key)
         );
         CREATE INDEX IF NOT EXISTS ledger_items_order ON ledger_items(collection, ordinal, item_key);
         COMMIT;",
    )?;
    let version: Option<i64> = connection
        .query_row(
            "SELECT value FROM ledger_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| value.parse())
        .transpose()
        .context("parse A2A ledger schema version")?;
    if let Some(version) = version.filter(|version| *version > SCHEMA_VERSION) {
        bail!("A2A task database schema {version} is newer than supported schema {SCHEMA_VERSION}");
    }
    connection.execute(
        "INSERT OR IGNORE INTO ledger_meta(key,value) VALUES('schema_version',?1)",
        [SCHEMA_VERSION.to_string()],
    )?;
    import_json_once(&mut connection, &json_path)?;
    restrict_database_files(&db_path)?;
    Ok(connection)
}

fn resolve_json_path(path: &Path) -> Result<PathBuf> {
    let mut cursor = path.to_path_buf();
    for _ in 0..=MAX_LEDGER_SYMLINK_HOPS {
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) => match dunce::canonicalize(&cursor) {
                Ok(resolved) => {
                    if fs::metadata(&resolved)?.is_dir() {
                        bail!("A2A task ledger path {} is a directory", path.display());
                    }
                    return Ok(resolved);
                }
                // A symlink naming a JSON boundary path that no longer exists.
                // Nothing writes that file after the SQLite move, so follow the
                // link instead of failing: an alias must still select the same
                // database as its target.
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && metadata.is_symlink() =>
                {
                    let target = fs::read_link(&cursor).with_context(|| {
                        format!("resolve A2A task ledger path {}", cursor.display())
                    })?;
                    cursor = match cursor.parent() {
                        Some(parent) if target.is_relative() => parent.join(target),
                        _ => target,
                    };
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("resolve A2A task ledger path {}", cursor.display())
                    });
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let file_name = cursor
                    .file_name()
                    .with_context(|| format!("resolve A2A task ledger path {}", path.display()))?
                    .to_os_string();
                let parent = cursor
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty());
                let parent = match parent {
                    Some(parent) => dunce::canonicalize(parent).with_context(|| {
                        format!("resolve A2A task ledger parent {}", parent.display())
                    })?,
                    None => {
                        std::env::current_dir().context("resolve current A2A ledger directory")?
                    }
                };
                return Ok(parent.join(file_name));
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("inspect A2A task ledger path {}", cursor.display()));
            }
        }
    }
    bail!(
        "A2A task ledger path {} exceeds the symlink hop limit",
        path.display()
    )
}

fn import_json_once(connection: &mut Connection, json_path: &Path) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM ledger_meta WHERE key='json_imported')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        transaction.commit()?;
        return Ok(());
    }
    let document = match fs::read_to_string(json_path) {
        Ok(raw) => serde_json::from_str(&raw)
            .with_context(|| format!("parse legacy A2A task ledger {}", json_path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::json!({"tasks": []})
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read legacy A2A task ledger {}", json_path.display()));
        }
    };
    write_document(&transaction, &document)?;
    transaction.execute(
        "INSERT INTO ledger_meta(key,value) VALUES('json_imported','1')",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

fn restrict_database_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("restrict A2A task database {}", path.display()))?;
    }
    Ok(())
}

fn restrict_database_files(path: &Path) -> Result<()> {
    restrict_database_permissions(path)?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        match fs::metadata(&sidecar) {
            Ok(_) => restrict_database_permissions(&sidecar)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("inspect A2A task database sidecar {}", sidecar.display())
                });
            }
        }
    }
    Ok(())
}

/// Read the canonical JSON boundary shape from SQLite.
pub fn load(json_path: &Path) -> Result<Value> {
    let connection = open(json_path)?;
    read_document(&connection)
}

/// Run a serializable read-modify-write operation. `BEGIN IMMEDIATE` gives
/// process-like writers deterministic commit order; the last committed update
/// to one item wins without discarding unrelated items.
pub fn update<T>(json_path: &Path, operation: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
    let mut connection = open(json_path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut document = read_document(&transaction)?;
    let result = operation(&mut document)?;
    write_document(&transaction, &document)?;
    transaction.commit()?;
    Ok(result)
}

fn read_document(connection: &Connection) -> Result<Value> {
    let root = connection
        .query_row("SELECT value FROM ledger_meta WHERE key='root'", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .map(|raw| serde_json::from_str::<Map<String, Value>>(&raw))
        .transpose()?
        .unwrap_or_default();
    let mut root = root;
    for collection in ["tasks", "orbDelegations"] {
        let mut statement = connection.prepare(
            "SELECT payload FROM ledger_items WHERE collection=?1 ORDER BY ordinal,item_key",
        )?;
        let values = statement
            .query_map([collection], |row| row.get::<_, String>(0))?
            .map(|raw| Ok(serde_json::from_str(&raw?)?))
            .collect::<Result<Vec<Value>>>()?;
        if collection == "tasks" || !values.is_empty() {
            root.insert(collection.to_string(), Value::Array(values));
        }
    }
    Ok(Value::Object(root))
}

fn item_key(collection: &str, value: &Value, ordinal: usize) -> String {
    let fields: &[&str] = if collection == "tasks" {
        &["id", "taskId"]
    } else {
        &["maestroDelegationId"]
    };
    fields
        .iter()
        .find_map(|field| value.get(field).and_then(Value::as_str))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("__ordinal_{ordinal}"))
}

fn write_document(connection: &Connection, document: &Value) -> Result<()> {
    let object = document
        .as_object()
        .context("A2A task ledger must be a JSON object")?;
    let mut root = object.clone();
    for collection in ["tasks", "orbDelegations"] {
        let items = root
            .remove(collection)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        connection.execute(
            "UPDATE ledger_items SET ordinal = -ordinal - 1 WHERE collection=?1",
            [collection],
        )?;
        for (ordinal, item) in items.iter().enumerate() {
            let key = item_key(collection, item, ordinal);
            connection.execute(
                "INSERT INTO ledger_items(collection,item_key,ordinal,payload) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(collection,item_key) DO UPDATE SET ordinal=excluded.ordinal,payload=excluded.payload
                 WHERE ordinal != excluded.ordinal OR payload != excluded.payload",
                params![collection, key, ordinal as i64, serde_json::to_string(item)?],
            )?;
        }
        connection.execute(
            "DELETE FROM ledger_items WHERE collection=?1 AND ordinal < 0",
            [collection],
        )?;
    }
    connection.execute("INSERT INTO ledger_meta(key,value) VALUES('root',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&root)?])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn imports_once_and_restart_does_not_reimport_changed_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.json");
        fs::write(
            &path,
            r#"{"tasks":[{"id":"old","extra":{"x":1}}],"future":true}"#,
        )
        .unwrap();
        assert_eq!(load(&path).unwrap()["tasks"][0]["extra"]["x"], 1);
        fs::write(&path, r#"{"tasks":[{"id":"replacement"}]}"#).unwrap();
        assert_eq!(load(&path).unwrap()["tasks"][0]["id"], "old");
    }

    #[test]
    fn concurrent_connections_preserve_unrelated_updates_and_commit_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.json");
        let barrier = Arc::new(Barrier::new(3));
        let handles = ["a", "b"].map(|id| {
            let path = path.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                update(&path, |doc| {
                    doc["tasks"]
                        .as_array_mut()
                        .unwrap()
                        .push(serde_json::json!({"id":id,"updatedAt":id}));
                    Ok(())
                })
                .unwrap();
            })
        });
        barrier.wait();
        for handle in handles {
            handle.join().unwrap();
        }
        let ledger = load(&path).unwrap();
        assert_eq!(ledger["tasks"].as_array().unwrap().len(), 2);
        update(&path, |doc| {
            doc["tasks"][0]["updatedAt"] = Value::String("last".into());
            Ok(())
        })
        .unwrap();
        assert_eq!(load(&path).unwrap()["tasks"][0]["updatedAt"], "last");
    }

    #[cfg(unix)]
    #[test]
    fn database_is_private_without_changing_custom_parent_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.path().join("tasks.json");

        let connection = open(&path).unwrap();

        assert_eq!(
            fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(database_path(&path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = database_path(&path).as_os_str().to_os_string();
            sidecar.push(suffix);
            assert_eq!(
                fs::metadata(sidecar).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(connection);
    }

    #[cfg(unix)]
    #[test]
    fn aliases_share_one_database_and_database_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.json");
        fs::write(&path, r#"{"tasks":[{"id":"imported"}]}"#).unwrap();
        let alias = dir.path().join("alias.json");
        symlink(&path, &alias).unwrap();

        assert_eq!(load(&alias).unwrap()["tasks"][0]["id"], "imported");
        assert!(database_path(&path).is_file());
        assert!(!database_path(&alias).exists());

        let second = dir.path().join("second.json");
        let protected = dir.path().join("protected");
        fs::write(&protected, b"unchanged").unwrap();
        symlink(&protected, database_path(&second)).unwrap();
        assert!(load(&second).is_err());
        assert_eq!(fs::read(&protected).unwrap(), b"unchanged");
    }
}
