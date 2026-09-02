use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use blake3::Hasher;
use clipboard_rs::common::RustImage;
use clipboard_rs::{
    Clipboard, ClipboardContent, ClipboardContext, ClipboardHandler, ClipboardWatcher,
    ClipboardWatcherContext, RustImageData,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

const CLIPBOARD_UPDATED: &str = "clipboard://updated";
const MAX_CARDS: i64 = 200;
const IGNORE_WINDOW: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipCard {
    pub id: String,
    pub kind: String,
    pub preview: String,
    pub detail: String,
    pub copied_at: String,
    pub use_count: u32,
    pub pinned: bool,
}

#[derive(Debug)]
enum CapturedRepresentation {
    Text { format: String, value: String },
    Bytes { format: String, value: Vec<u8> },
    Files(Vec<String>),
}

#[derive(Debug)]
struct ClipboardCapture {
    card: ClipCard,
    hash: String,
    representations: Vec<CapturedRepresentation>,
}

#[derive(Debug)]
struct StoredRepresentation {
    format: String,
    text_value: Option<String>,
    bytes: Option<Vec<u8>>,
    resource_path: Option<String>,
}

#[derive(Debug)]
struct RestorePayload {
    hash: String,
    representations: Vec<StoredRepresentation>,
}

struct SqliteStore {
    connection: Connection,
    resource_dir: PathBuf,
}

pub struct AppState {
    store: Mutex<SqliteStore>,
    session_store: Mutex<SqliteStore>,
    persistence_enabled: Mutex<bool>,
    session_resource_dir: Option<PathBuf>,
    ignored_hashes: Mutex<HashMap<String, Instant>>,
}

impl AppState {
    fn open(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
        let resource_dir = data_dir.join("resources");
        fs::create_dir_all(&resource_dir).map_err(|error| error.to_string())?;
        let database_path = data_dir.join("clipraft.sqlite3");
        let store = SqliteStore::open(&database_path, resource_dir)?;
        let persistence_enabled = store.bool_setting("history_persistence", true)?;
        let session_resource_dir = std::env::temp_dir().join(format!(
            "clipraft-session-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        let session_store = SqliteStore::in_memory_with_resources(session_resource_dir.clone())?;
        Ok(Self {
            store: Mutex::new(store),
            session_store: Mutex::new(session_store),
            persistence_enabled: Mutex::new(persistence_enabled),
            session_resource_dir: Some(session_resource_dir),
            ignored_hashes: Mutex::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        Self {
            store: Mutex::new(SqliteStore::in_memory()),
            session_store: Mutex::new(SqliteStore::in_memory()),
            persistence_enabled: Mutex::new(true),
            session_resource_dir: None,
            ignored_hashes: Mutex::new(HashMap::new()),
        }
    }

    fn with_active_store<T>(
        &self,
        operation: impl FnOnce(&mut SqliteStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let persistence_enabled = *self
            .persistence_enabled
            .lock()
            .map_err(|_| "persistence setting lock poisoned".to_string())?;
        if persistence_enabled {
            let mut store = self
                .store
                .lock()
                .map_err(|_| "history lock poisoned".to_string())?;
            operation(&mut store)
        } else {
            let mut store = self
                .session_store
                .lock()
                .map_err(|_| "session history lock poisoned".to_string())?;
            operation(&mut store)
        }
    }

    fn history_persistence(&self) -> Result<bool, String> {
        self.persistence_enabled
            .lock()
            .map(|value| *value)
            .map_err(|_| "persistence setting lock poisoned".to_string())
    }

    fn set_history_persistence(&self, enabled: bool) -> Result<(), String> {
        let mut persistence_enabled = self
            .persistence_enabled
            .lock()
            .map_err(|_| "persistence setting lock poisoned".to_string())?;
        self.store
            .lock()
            .map_err(|_| "history lock poisoned".to_string())?
            .set_bool_setting("history_persistence", enabled)?;
        if !enabled {
            self.session_store
                .lock()
                .map_err(|_| "session history lock poisoned".to_string())?
                .clear()?;
        }
        *persistence_enabled = enabled;
        Ok(())
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Some(session_resource_dir) = &self.session_resource_dir {
            let _ = fs::remove_dir_all(session_resource_dir);
        }
    }
}

impl SqliteStore {
    fn open(database_path: &Path, resource_dir: PathBuf) -> Result<Self, String> {
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        let mut store = Self {
            connection,
            resource_dir,
        };
        store.initialize()?;
        Ok(store)
    }

    fn in_memory_with_resources(resource_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&resource_dir).map_err(|error| error.to_string())?;
        let connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
        let mut store = Self {
            connection,
            resource_dir,
        };
        store.initialize()?;
        Ok(store)
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory sqlite");
        let mut store = Self {
            connection,
            resource_dir: std::env::temp_dir().join("clipraft-test-resources"),
        };
        store.initialize().expect("initialize sqlite");
        store
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS clips (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   preview TEXT NOT NULL,
                   detail TEXT NOT NULL,
                   copied_at TEXT NOT NULL,
                   use_count INTEGER NOT NULL DEFAULT 1,
                   pinned INTEGER NOT NULL DEFAULT 0,
                   hash TEXT NOT NULL UNIQUE,
                   order_index INTEGER NOT NULL,
                   deleted_at INTEGER
                 );
                 CREATE TABLE IF NOT EXISTS representations (
                   clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
                   format TEXT NOT NULL,
                   text_value TEXT,
                   bytes BLOB,
                   resource_path TEXT,
                   PRIMARY KEY (clip_id, format)
                 );
                 CREATE INDEX IF NOT EXISTS idx_clips_stream
                   ON clips (deleted_at, order_index DESC);
                 CREATE TABLE IF NOT EXISTS settings (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 );
                 INSERT OR IGNORE INTO settings (key, value)
                   VALUES ('history_persistence', 'true');",
            )
            .map_err(|error| error.to_string())
    }

    fn bool_setting(&self, key: &str, fallback: bool) -> Result<bool, String> {
        let value = self
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        Ok(value
            .as_deref()
            .map(|value| value == "true")
            .unwrap_or(fallback))
    }

    fn set_bool_setting(&mut self, key: &str, value: bool) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, if value { "true" } else { "false" }],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn list(&self) -> Result<Vec<ClipCard>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, kind, preview, detail, copied_at, use_count, pinned
                 FROM clips
                 WHERE deleted_at IS NULL
                 ORDER BY order_index DESC
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let cards = statement
            .query_map(params![MAX_CARDS], card_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(cards)
    }

    fn upsert(&mut self, capture: ClipboardCapture) -> Result<ClipCard, String> {
        let existing = self
            .connection
            .query_row(
                "SELECT id, pinned, use_count FROM clips WHERE hash = ?1",
                params![capture.hash],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, u32>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;

        if let Some((id, pinned, use_count)) = existing {
            let next_order = self.next_order()?;
            let copied_at = now_label();
            let order_index = if pinned { None } else { Some(next_order) };
            self.connection
                .execute(
                    "UPDATE clips
                     SET copied_at = ?1, use_count = ?2, deleted_at = NULL,
                         order_index = COALESCE(?3, order_index)
                     WHERE id = ?4",
                    params![copied_at, use_count.saturating_add(1), order_index, id],
                )
                .map_err(|error| error.to_string())?;
            return self
                .card_by_id(&id)?
                .ok_or_else(|| "clip disappeared".to_string());
        }

        let transaction = self
            .connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let order_index = next_order_with(&transaction)?;
        transaction
            .execute(
                "INSERT INTO clips
                 (id, kind, preview, detail, copied_at, use_count, pinned, hash, order_index)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    capture.card.id,
                    capture.card.kind,
                    capture.card.preview,
                    capture.card.detail,
                    capture.card.copied_at,
                    capture.card.use_count,
                    capture.card.pinned,
                    capture.hash,
                    order_index,
                ],
            )
            .map_err(|error| error.to_string())?;

        for representation in capture.representations {
            let (format, text_value, bytes, resource_path): (
                String,
                Option<String>,
                Option<Vec<u8>>,
                Option<String>,
            ) = match representation {
                CapturedRepresentation::Text { format, value } => (format, Some(value), None, None),
                CapturedRepresentation::Bytes { format, value } => {
                    let resource_path = self.resource_dir.join(format!(
                        "{}.{}",
                        capture.card.id,
                        image_extension(&format)
                    ));
                    fs::write(&resource_path, value).map_err(|error| error.to_string())?;
                    (
                        format,
                        None,
                        None,
                        Some(resource_path.to_string_lossy().into_owned()),
                    )
                }
                CapturedRepresentation::Files(paths) => (
                    "files".to_string(),
                    Some(serde_json::to_string(&paths).map_err(|error| error.to_string())?),
                    None,
                    None,
                ),
            };
            transaction
                .execute(
                    "INSERT INTO representations
                     (clip_id, format, text_value, bytes, resource_path)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![capture.card.id, format, text_value, bytes, resource_path],
                )
                .map_err(|error| error.to_string())?;
        }

        transaction.commit().map_err(|error| error.to_string())?;
        self.prune_history()?;
        Ok(capture.card)
    }

    fn card_by_id(&self, id: &str) -> Result<Option<ClipCard>, String> {
        self.connection
            .query_row(
                "SELECT id, kind, preview, detail, copied_at, use_count, pinned
                 FROM clips WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                card_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    fn payload_by_id(&self, id: &str) -> Result<RestorePayload, String> {
        let hash = self
            .connection
            .query_row(
                "SELECT hash FROM clips WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT format, text_value, bytes, resource_path
                 FROM representations WHERE clip_id = ?1 ORDER BY format",
            )
            .map_err(|error| error.to_string())?;
        let representations = statement
            .query_map(params![id], |row| {
                Ok(StoredRepresentation {
                    format: row.get(0)?,
                    text_value: row.get(1)?,
                    bytes: row.get(2)?,
                    resource_path: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(RestorePayload {
            hash,
            representations,
        })
    }

    fn soft_delete(&mut self, id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE clips SET deleted_at = ?1 WHERE id = ?2",
                params![unix_seconds(), id],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn restore_deleted(&mut self, id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE clips SET deleted_at = NULL WHERE id = ?1",
                params![id],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn clear(&mut self) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM clips", [])
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn next_order(&self) -> Result<i64, String> {
        next_order_with(&self.connection)
    }

    fn prune_history(&mut self) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM clips
                 WHERE id IN (
                   SELECT id FROM clips
                   WHERE deleted_at IS NULL AND pinned = 0
                   ORDER BY order_index DESC
                   LIMIT -1 OFFSET ?1
                 )",
                params![MAX_CARDS],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn card_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipCard> {
    Ok(ClipCard {
        id: row.get(0)?,
        kind: row.get(1)?,
        preview: row.get(2)?,
        detail: row.get(3)?,
        copied_at: row.get(4)?,
        use_count: row.get(5)?,
        pinned: row.get(6)?,
    })
}

fn next_order_with(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(order_index), 0) + 1 FROM clips",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn image_extension(format: &str) -> &str {
    match format {
        "image/png" => "png",
        _ => "bin",
    }
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn now_label() -> String {
    unix_seconds().to_string()
}

fn digest_bytes(prefix: &str, bytes: &[u8]) -> String {
    let mut hasher = Hasher::new();
    hasher.update(prefix.as_bytes());
    hasher.update(bytes);
    hasher.finalize().to_hex().to_string()
}

fn text_hash(text: &str) -> String {
    digest_bytes("text/plain\0", text.as_bytes())
}

fn card_id(hash: &str) -> String {
    hash.chars().take(16).collect()
}

fn text_capture(text: &str) -> ClipboardCapture {
    let trimmed = text.trim();
    let hash = text_hash(trimmed);
    let preview = if trimmed.chars().count() > 92 {
        format!("{}…", trimmed.chars().take(92).collect::<String>())
    } else {
        trimmed.to_string()
    };
    ClipboardCapture {
        card: ClipCard {
            id: card_id(&hash),
            kind: "text".to_string(),
            preview,
            detail: format!("文本 · {} 字符", trimmed.chars().count()),
            copied_at: now_label(),
            use_count: 1,
            pinned: false,
        },
        hash,
        representations: vec![CapturedRepresentation::Text {
            format: "text/plain".to_string(),
            value: trimmed.to_string(),
        }],
    }
}

fn file_capture(paths: Vec<String>) -> Option<ClipboardCapture> {
    let paths = paths
        .into_iter()
        .filter(|path| !path.trim().is_empty())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return None;
    }
    let first_name = Path::new(&paths[0])
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&paths[0]);
    let hash_input = serde_json::to_vec(&paths).ok()?;
    let hash = digest_bytes("files\0", &hash_input);
    Some(ClipboardCapture {
        card: ClipCard {
            id: card_id(&hash),
            kind: "file".to_string(),
            preview: first_name.to_string(),
            detail: format!("文件 · {} 个", paths.len()),
            copied_at: now_label(),
            use_count: 1,
            pinned: false,
        },
        hash,
        representations: vec![CapturedRepresentation::Files(paths)],
    })
}

fn capture_clipboard(reader: &ClipboardContext) -> Option<ClipboardCapture> {
    let files = reader
        .get_files()
        .ok()
        .filter(|paths| !paths.is_empty())
        .map(|paths| {
            paths
                .into_iter()
                .filter(|path| !path.trim().is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|paths| !paths.is_empty());
    let image = reader.get_image().ok().and_then(|image| {
        let (width, height) = image.get_size();
        image
            .to_png()
            .ok()
            .map(|png| (width, height, png.get_bytes().to_vec()))
    });
    let text = reader
        .get_text()
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let html = reader
        .get_html()
        .ok()
        .filter(|value| !value.trim().is_empty());
    let rtf = reader
        .get_rich_text()
        .ok()
        .filter(|value| !value.trim().is_empty());
    let copied_at = now_label();

    if let Some(paths) = files {
        let mut capture = file_capture(paths)?;
        if let Some(value) = text {
            capture.representations.push(CapturedRepresentation::Text {
                format: "text/plain".to_string(),
                value,
            });
        }
        capture.card.copied_at = copied_at;
        return Some(capture);
    }

    if let Some((width, height, bytes)) = image {
        let hash = digest_bytes("image/png\0", &bytes);
        let mut representations = vec![CapturedRepresentation::Bytes {
            format: "image/png".to_string(),
            value: bytes,
        }];
        if let Some(value) = text {
            representations.push(CapturedRepresentation::Text {
                format: "text/plain".to_string(),
                value,
            });
        }
        if let Some(value) = html {
            representations.push(CapturedRepresentation::Text {
                format: "text/html".to_string(),
                value,
            });
        }
        return Some(ClipboardCapture {
            card: ClipCard {
                id: card_id(&hash),
                kind: "image".to_string(),
                preview: format!("PNG · {}×{}", width, height),
                detail: "图片 · 已保存 PNG 快照".to_string(),
                copied_at,
                use_count: 1,
                pinned: false,
            },
            hash,
            representations,
        });
    }

    let value = text?;
    let mut capture = text_capture(&value);
    if let Some(value) = html {
        capture.representations.push(CapturedRepresentation::Text {
            format: "text/html".to_string(),
            value,
        });
    }
    if let Some(value) = rtf {
        capture.representations.push(CapturedRepresentation::Text {
            format: "text/rtf".to_string(),
            value,
        });
    }
    Some(capture)
}

fn consume_ignored_hash(state: &AppState, hash: &str) -> bool {
    let Ok(mut ignored) = state.ignored_hashes.lock() else {
        return false;
    };
    match ignored.remove(hash) {
        Some(created_at) if created_at.elapsed() <= IGNORE_WINDOW => true,
        _ => false,
    }
}

fn ingest_capture(state: &AppState, capture: ClipboardCapture) -> Option<ClipCard> {
    if consume_ignored_hash(state, &capture.hash) {
        return None;
    }
    state.with_active_store(|store| store.upsert(capture)).ok()
}

#[cfg(test)]
fn ingest_text(state: &AppState, text: String) -> Option<ClipCard> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    ingest_capture(state, text_capture(trimmed))
}

struct ClipboardChangeHandler {
    app: AppHandle,
    reader: ClipboardContext,
}

impl ClipboardHandler for ClipboardChangeHandler {
    fn on_clipboard_change(&mut self) {
        let Some(capture) = capture_clipboard(&self.reader) else {
            return;
        };
        let Some(state) = self.app.try_state::<AppState>() else {
            return;
        };
        if let Some(card) = ingest_capture(&state, capture) {
            expand_window(&self.app);
            let _ = self.app.emit(CLIPBOARD_UPDATED, card);
        }
    }
}

fn expand_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
    }
}

fn dock_window(window: &WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "ClipRaft monitor unavailable".to_string())?;
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let x = monitor.position().x + monitor.size().width as i32 - window_size.width as i32;
    let y = monitor.position().y;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

fn start_clipboard_watcher(app: AppHandle) {
    thread::Builder::new()
        .name("clipraft-clipboard-watcher".to_string())
        .spawn(move || {
            let reader = match ClipboardContext::new() {
                Ok(reader) => reader,
                Err(error) => {
                    eprintln!("ClipRaft clipboard reader failed: {error}");
                    return;
                }
            };
            let mut watcher = match ClipboardWatcherContext::new() {
                Ok(watcher) => watcher,
                Err(error) => {
                    eprintln!("ClipRaft clipboard watcher failed: {error}");
                    return;
                }
            };
            watcher.add_handler(ClipboardChangeHandler { app, reader });
            watcher.start_watch();
        })
        .expect("failed to start ClipRaft clipboard watcher");
}

#[tauri::command]
fn history_list(state: State<'_, AppState>) -> Result<Vec<ClipCard>, String> {
    state.with_active_store(|store| store.list())
}

#[tauri::command]
fn delete_clip(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.with_active_store(|store| store.soft_delete(&id))
}

#[tauri::command]
fn undo_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.with_active_store(|store| store.restore_deleted(&id))
}

#[tauri::command]
fn ingest_paths(paths: Vec<String>, state: State<'_, AppState>) -> Result<ClipCard, String> {
    let capture = file_capture(paths).ok_or_else(|| "拖入的文件列表为空".to_string())?;
    state.with_active_store(|store| store.upsert(capture))
}

fn contents_from_payload(
    payload: RestorePayload,
) -> Result<(String, Vec<ClipboardContent>), String> {
    let mut contents = Vec::new();
    for representation in payload.representations {
        match representation.format.as_str() {
            "text/plain" => {
                if let Some(value) = representation.text_value {
                    contents.push(ClipboardContent::Text(value));
                }
            }
            "text/html" => {
                if let Some(value) = representation.text_value {
                    contents.push(ClipboardContent::Html(value));
                }
            }
            "text/rtf" => {
                if let Some(value) = representation.text_value {
                    contents.push(ClipboardContent::Rtf(value));
                }
            }
            "image/png" => {
                let path = representation
                    .resource_path
                    .ok_or_else(|| "图片快照路径缺失".to_string())?;
                let image = RustImageData::from_path(&path).map_err(|error| error.to_string())?;
                contents.push(ClipboardContent::Image(image));
            }
            "files" => {
                let value = representation
                    .text_value
                    .ok_or_else(|| "文件列表缺失".to_string())?;
                let paths = serde_json::from_str::<Vec<String>>(&value)
                    .map_err(|error| error.to_string())?;
                contents.push(ClipboardContent::Files(paths));
            }
            format => {
                if let Some(bytes) = representation.bytes {
                    contents.push(ClipboardContent::Other(format.to_string(), bytes));
                }
            }
        }
    }
    if contents.is_empty() {
        return Err("剪贴内容为空".to_string());
    }
    Ok((payload.hash, contents))
}

#[tauri::command]
fn restore_clip(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let payload = state.with_active_store(|store| store.payload_by_id(&id))?;
    let (hash, contents) = contents_from_payload(payload)?;
    {
        let mut ignored = state
            .ignored_hashes
            .lock()
            .map_err(|_| "ignore lock poisoned".to_string())?;
        ignored.insert(hash.clone(), Instant::now());
    }
    let context = ClipboardContext::new().map_err(|error| error.to_string())?;
    if let Err(error) = context.set(contents) {
        if let Ok(mut ignored) = state.ignored_hashes.lock() {
            ignored.remove(&hash);
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    state.with_active_store(|store| store.clear())
}

#[tauri::command]
fn get_history_persistence(state: State<'_, AppState>) -> Result<bool, String> {
    state.history_persistence()
}

#[tauri::command]
fn set_history_persistence(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.set_history_persistence(enabled)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("ClipRaft data directory failed: {error}"))?;
            app.manage(AppState::open(&data_dir)?);
            if let Some(window) = app.get_webview_window("main") {
                dock_window(&window)?;
            }
            start_clipboard_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            history_list,
            delete_clip,
            undo_delete,
            ingest_paths,
            restore_clip,
            clear_history,
            get_history_persistence,
            set_history_persistence
        ])
        .run(tauri::generate_context!())
        .expect("error while running ClipRaft");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_hashes_are_stable() {
        assert_eq!(text_hash("ClipRaft"), text_hash("ClipRaft"));
        assert_ne!(text_hash("ClipRaft"), text_hash("ClipRaft "));
    }

    #[test]
    fn duplicate_text_moves_existing_raft_to_upstream() {
        let state = AppState::in_memory();
        let first = ingest_text(&state, "downstream".to_string()).expect("first raft");
        let second = ingest_text(&state, "upstream".to_string()).expect("second raft");
        let duplicate = ingest_text(&state, "downstream".to_string()).expect("duplicate raft");

        let cards = state
            .store
            .lock()
            .expect("store lock")
            .list()
            .expect("list cards");
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].id, first.id);
        assert_eq!(cards[1].id, second.id);
        assert_eq!(duplicate.use_count, 2);
    }

    #[test]
    fn sqlite_round_trip_preserves_html_and_text_representations() {
        let state = AppState::in_memory();
        let mut capture = text_capture("hello");
        capture.representations.push(CapturedRepresentation::Text {
            format: "text/html".to_string(),
            value: "<strong>hello</strong>".to_string(),
        });
        let card = ingest_capture(&state, capture).expect("capture");
        let payload = state
            .store
            .lock()
            .expect("store lock")
            .payload_by_id(&card.id)
            .expect("payload");
        assert_eq!(payload.representations.len(), 2);
        assert!(payload
            .representations
            .iter()
            .any(|item| item.format == "text/html"));
    }

    #[test]
    fn soft_deleted_raft_can_be_restored() {
        let state = AppState::in_memory();
        let card = ingest_text(&state, "undo me".to_string()).expect("capture");
        {
            let mut store = state.store.lock().expect("store lock");
            store.soft_delete(&card.id).expect("soft delete");
            assert!(store.list().expect("list after delete").is_empty());
            store.restore_deleted(&card.id).expect("restore delete");
        }
        assert_eq!(
            state
                .store
                .lock()
                .expect("store lock")
                .list()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn file_capture_discards_empty_paths_and_keeps_all_files() {
        let capture = file_capture(vec!["".to_string(), "C:\\Temp\\a.txt".to_string()])
            .expect("file capture");
        assert_eq!(capture.card.kind, "file");
        assert_eq!(capture.card.detail, "文件 · 1 个");
        assert_eq!(capture.representations.len(), 1);
    }

    #[test]
    fn disabling_persistence_keeps_session_history_out_of_persistent_history() {
        let state = AppState::in_memory();
        let persistent =
            ingest_text(&state, "keep after restart".to_string()).expect("persistent capture");
        state
            .set_history_persistence(false)
            .expect("disable persistence");
        assert!(state
            .with_active_store(|store| store.list())
            .unwrap()
            .is_empty());
        let session =
            ingest_text(&state, "only this session".to_string()).expect("session capture");
        assert_ne!(persistent.id, session.id);
        state
            .set_history_persistence(true)
            .expect("enable persistence");
        let cards = state.with_active_store(|store| store.list()).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].id, persistent.id);
    }
}
