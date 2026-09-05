use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use blake3::Hasher;
use clipboard_rs::common::RustImage;
use clipboard_rs::{
    Clipboard, ClipboardContent, ClipboardContext, ClipboardHandler, ClipboardWatcher,
    ClipboardWatcherContext, RustImageData,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

mod platform;

use platform::DragPayload;

const CLIPBOARD_UPDATED: &str = "clipboard://updated";
const PANEL_OPENED: &str = "panel://opened";
const PASTE_DEGRADED: &str = "paste://degraded";
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

#[derive(Debug, Clone)]
struct StoredRepresentation {
    format: String,
    text_value: Option<String>,
    bytes: Option<Vec<u8>>,
    resource_path: Option<String>,
}

#[derive(Debug, Clone)]
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
    // 仅 Windows 平台实现读写（前台窗口记录），macOS 无需恢复目标
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    last_active_window: Mutex<Option<usize>>,
    ignored_hashes: Mutex<HashMap<String, Instant>>,
    // macOS 原生拖拽进行中：悬停监视器据此暂停"离开即收起"
    #[cfg_attr(windows, allow(dead_code))]
    dragging: AtomicBool,
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
            last_active_window: Mutex::new(None),
            ignored_hashes: Mutex::new(HashMap::new()),
            dragging: AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        Self {
            store: Mutex::new(SqliteStore::in_memory()),
            session_store: Mutex::new(SqliteStore::in_memory()),
            persistence_enabled: Mutex::new(true),
            session_resource_dir: None,
            last_active_window: Mutex::new(None),
            ignored_hashes: Mutex::new(HashMap::new()),
            dragging: AtomicBool::new(false),
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

    fn auto_paste(&self) -> Result<bool, String> {
        self.store
            .lock()
            .map_err(|_| "history lock poisoned".to_string())?
            .bool_setting("auto_paste", true)
    }

    fn set_auto_paste(&self, enabled: bool) -> Result<(), String> {
        self.store
            .lock()
            .map_err(|_| "history lock poisoned".to_string())?
            .set_bool_setting("auto_paste", enabled)
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
        let resource_dir = std::env::temp_dir().join("clipraft-test-resources");
        fs::create_dir_all(&resource_dir).expect("test resource directory");
        let mut store = Self {
            connection,
            resource_dir,
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
                   VALUES ('history_persistence', 'true');
                 INSERT OR IGNORE INTO settings (key, value)
                   VALUES ('auto_paste', 'true');",
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

    fn image_preview_data_url(&self, id: &str) -> Result<Option<String>, String> {
        let path = self
            .connection
            .query_row(
                "SELECT resource_path
                 FROM representations
                 WHERE clip_id = ?1 AND format = 'image/png'",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        let Some(path) = path else {
            return Ok(None);
        };
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
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
        let changed = self
            .connection
            .execute(
                "UPDATE clips SET deleted_at = NULL WHERE id = ?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("要恢复的卡片不存在或已被清理".to_string());
        }
        Ok(())
    }

    fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<ClipCard, String> {
        let changed = self
            .connection
            .execute(
                "UPDATE clips SET pinned = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![pinned, id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("要固定的卡片不存在".to_string());
        }
        self.card_by_id(id)?
            .ok_or_else(|| "卡片更新后无法读取".to_string())
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
            platform::remember_paste_target(&state);
            expand_window(&self.app, false);
            let _ = self.app.emit(CLIPBOARD_UPDATED, card);
        }
    }
}

/// 展开/停靠面板并显示。
/// `explicit` 表示用户主动打开（托盘、快捷键、点击把手）：此时才允许取得键盘焦点；
/// 复制触发的预览（`explicit = false`）在 macOS 上必须保持不可聚焦（ADR-0002）。
fn expand_window(app: &AppHandle, explicit: bool) {
    if let Some(window) = app.get_webview_window("main") {
        match set_panel_width(&window, 184.0) {
            Ok(width) => {
                let _ = dock_window(&window, width);
            }
            Err(error) => println!("ClipRaft expand resize failed: {error}"),
        }
        #[cfg(target_os = "macos")]
        {
            let _ = window.set_focusable(explicit);
        }
        let _ = window.show();
        let _ = window.unminimize();
        if explicit {
            let _ = window.set_focus();
        }
        let _ = app.emit(PANEL_OPENED, ());
    }
}

/// 调整面板宽度，返回**目标物理宽度**。
/// macOS 上 set_size 经事件循环异步生效，调用后 outer_size 仍是旧值，
/// 所以停靠必须使用这里返回的宽度，不能事后查询。
fn set_panel_width(window: &WebviewWindow, logical_width: f64) -> Result<u32, String> {
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let height = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .height;
    let width = ((logical_width * scale_factor).round() as u32).max(1);
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    Ok(width)
}

/// 收起态。macOS：窄条覆盖整条侧边工作区（悬停热区全长），
/// 宽度 26pt 给把手呼吸辉光留出渲染空间（box-shadow 会被窗口边界裁剪）；
/// Windows：保持 9pt 既有行为。
#[cfg(target_os = "macos")]
fn collapse_window(window: &WebviewWindow) -> Result<(), String> {
    let width = set_panel_width(window, 30.0)?;
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        let _ = window.set_size(PhysicalSize::new(width, area.size.height));
    }
    dock_window(window, width)
}

#[cfg(not(target_os = "macos"))]
fn collapse_window(window: &WebviewWindow) -> Result<(), String> {
    let width = set_panel_width(window, 9.0)?;
    dock_window(window, width)
}

fn dock_window(window: &WebviewWindow, physical_width: u32) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "ClipRaft monitor unavailable".to_string())?;
    // macOS 用 work_area 避开菜单栏与程序坞；Windows 保持全屏高度停靠的既有行为
    #[cfg(target_os = "macos")]
    let (monitor_x, monitor_y, monitor_width) = {
        let area = monitor.work_area();
        (area.position.x, area.position.y, area.size.width as i32)
    };
    #[cfg(not(target_os = "macos"))]
    let (monitor_x, monitor_y, monitor_width) = (
        monitor.position().x,
        monitor.position().y,
        monitor.size().width as i32,
    );
    let x = monitor_x + monitor_width - physical_width as i32;
    let y = monitor_y;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

/// 常驻托盘、无 Dock 图标、只有一条窄窗的应用极易被 App Nap 节流，
/// 收起态把手的呼吸动画会因此停摆。声明"延迟关键"活动并保留 token
/// 至进程结束，让 WKWebView 的合成器持续出帧。
#[cfg(target_os = "macos")]
fn disable_app_nap() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::LatencyCritical,
        &NSString::from_str("ClipRaft edge panel rendering"),
    );
    std::mem::forget(token);
}

/// macOS：全局光标读取（无需任何权限）。CGEvent 坐标系为左上原点的逻辑点，
/// 与窗口矩形的换算一致。
#[cfg(target_os = "macos")]
mod edge_hover {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
        fn CFRelease(cf: *mut c_void);
    }

    pub fn cursor_location() -> CGPoint {
        unsafe {
            let event = CGEventCreate(std::ptr::null());
            if event.is_null() {
                return CGPoint {
                    x: f64::NAN,
                    y: f64::NAN,
                };
            }
            let point = CGEventGetLocation(event);
            CFRelease(event);
            point
        }
    }
}

#[cfg(target_os = "macos")]
fn start_edge_hover_watcher(app: AppHandle) {
    thread::Builder::new()
        .name("clipraft-edge-hover".to_string())
        .spawn(move || {
            const COLLAPSED_MAX_PT: f64 = 60.0;
            const LEAVE_COLLAPSE_MS: u64 = 2000;
            let mut outside_since: Option<Instant> = None;
            let mut hover_expanded = false;
            loop {
                thread::sleep(Duration::from_millis(100));
                let Some(window) = app.get_webview_window("main") else {
                    continue;
                };
                if !window.is_visible().unwrap_or(false) {
                    outside_since = None;
                    hover_expanded = false;
                    continue;
                }
                let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size())
                else {
                    continue;
                };
                let Ok(scale) = window.scale_factor() else {
                    continue;
                };
                if scale <= 0.0 {
                    continue;
                }
                let dragging = app.state::<AppState>().dragging.load(Ordering::Relaxed);
                if dragging {
                    outside_since = None;
                    continue;
                }
                let point = edge_hover::cursor_location();
                let (wx, wy) = (position.x as f64 / scale, position.y as f64 / scale);
                let (ww, wh) = (size.width as f64 / scale, size.height as f64 / scale);
                let inside =
                    point.x >= wx && point.x <= wx + ww && point.y >= wy && point.y <= wy + wh;
                if ww <= COLLAPSED_MAX_PT {
                    if inside && !hover_expanded {
                        hover_expanded = true;
                        expand_window(&app, false);
                    } else if !inside {
                        hover_expanded = false;
                    }
                    outside_since = None;
                } else if inside {
                    outside_since = None;
                } else {
                    match outside_since {
                        None => outside_since = Some(Instant::now()),
                        Some(since)
                            if since.elapsed() >= Duration::from_millis(LEAVE_COLLAPSE_MS) =>
                        {
                            outside_since = None;
                            hover_expanded = false;
                            let _ = collapse_window(&window);
                        }
                        _ => {}
                    }
                }
            }
        })
        .expect("failed to start ClipRaft edge hover watcher");
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "打开 ClipRaft", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 ClipRaft", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("ClipRaft tray icon unavailable")?;

    let builder = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("ClipRaft")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => expand_window(app, true),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        expand_window(tray.app_handle(), true);
                    }
                }
            }
        });
    // macOS 菜单栏用单色模板图标，跟随深/浅色外观
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder.build(app)?;
    Ok(())
}

fn start_clipboard_watcher(app: AppHandle) {
    thread::Builder::new()
        .name("clipraft-clipboard-watcher".to_string())
        .spawn(move || {
            let reader = match ClipboardContext::new() {
                Ok(reader) => reader,
                Err(error) => {
                    println!("ClipRaft clipboard reader failed: {error}");
                    return;
                }
            };
            // macOS 无剪贴板变更事件，只能轮询 changeCount：120ms 是 EcoPaste
            // 验证过的响应性/功耗折中；Windows 事件驱动下该参数被忽略
            let mut watcher =
                match ClipboardWatcherContext::new_with_interval(Duration::from_millis(120)) {
                    Ok(watcher) => watcher,
                    Err(error) => {
                        println!("ClipRaft clipboard watcher failed: {error}");
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

#[tauri::command]
fn set_clip_pinned(
    id: String,
    pinned: bool,
    state: State<'_, AppState>,
) -> Result<ClipCard, String> {
    state.with_active_store(|store| store.set_pinned(&id, pinned))
}

#[tauri::command]
fn image_preview_data_url(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    state.with_active_store(|store| store.image_preview_data_url(&id))
}

/// 把卡片内容整理成拖出/粘贴载荷：文件路径列表 + 文本内容。
fn clip_drag_targets(state: &AppState, id: &str) -> Result<(Vec<PathBuf>, Option<String>), String> {
    let payload = state.with_active_store(|store| store.payload_by_id(id))?;
    let mut file_paths: Vec<PathBuf> = Vec::new();
    let mut image_path: Option<PathBuf> = None;
    let mut plain_text: Option<String> = None;
    let mut text_fallback: Vec<(String, String)> = Vec::new();

    for representation in &payload.representations {
        match representation.format.as_str() {
            "files" => {
                if let Some(value) = &representation.text_value {
                    let stored: Vec<String> =
                        serde_json::from_str(value).map_err(|error| error.to_string())?;
                    for path in stored {
                        if Path::new(&path).exists() {
                            file_paths.push(PathBuf::from(&path));
                        }
                    }
                }
            }
            "image/png" => {
                if let Some(path) = &representation.resource_path {
                    if Path::new(path).exists() && image_path.is_none() {
                        image_path = Some(PathBuf::from(path));
                    }
                }
            }
            "text/plain" => {
                if let Some(value) = &representation.text_value {
                    if !value.trim().is_empty() {
                        plain_text.get_or_insert_with(|| value.clone());
                        text_fallback.push((representation.format.clone(), value.clone()));
                    }
                }
            }
            "text/html" | "text/rtf" => {
                if let Some(value) = &representation.text_value {
                    if !value.trim().is_empty() {
                        text_fallback.push((representation.format.clone(), value.clone()));
                    }
                }
            }
            _ => {}
        }
    }

    // 优先级：真实文件 > 图片快照 > 纯文本（txt 文件 + 文本内容）
    if !file_paths.is_empty() {
        return Ok((file_paths, None));
    }
    if let Some(path) = image_path {
        return Ok((vec![path], None));
    }

    let dir = std::env::temp_dir().join("ClipRaft");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let mut paths: Vec<PathBuf> = Vec::new();
    for (format, value) in &text_fallback {
        let name = sanitize_clip_filename(format, value);
        let target = dir.join(name);
        fs::write(&target, value).map_err(|error| error.to_string())?;
        paths.push(target);
    }
    if paths.is_empty() {
        return Err("没有可拖出的文件".to_string());
    }
    Ok((paths, plain_text))
}

/// 把存储载荷整理成跨平台拖出载荷：Windows 需要可写回剪贴板的表示，
/// macOS 需要文件路径 / 文本表示 / 图片快照预览。
fn build_drag_payload(id: &str, payload: &RestorePayload) -> Result<DragPayload, String> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut image_path: Option<PathBuf> = None;
    let mut plain: Option<String> = None;
    let mut html: Option<String> = None;
    let mut rtf: Option<String> = None;
    let mut preview_png: Option<Vec<u8>> = None;

    for representation in &payload.representations {
        match representation.format.as_str() {
            "files" => {
                if let Some(value) = &representation.text_value {
                    let stored: Vec<String> =
                        serde_json::from_str(value).map_err(|error| error.to_string())?;
                    for path in stored {
                        if Path::new(&path).exists() {
                            files.push(PathBuf::from(&path));
                        }
                    }
                }
            }
            "image/png" => {
                if let Some(path) = &representation.resource_path {
                    if Path::new(path).exists() && image_path.is_none() {
                        image_path = Some(PathBuf::from(path));
                    }
                }
            }
            "text/plain" => {
                if plain.is_none() {
                    plain = representation
                        .text_value
                        .clone()
                        .filter(|v| !v.trim().is_empty());
                }
            }
            "text/html" => {
                html = representation
                    .text_value
                    .clone()
                    .filter(|v| !v.trim().is_empty());
            }
            "text/rtf" => {
                rtf = representation
                    .text_value
                    .clone()
                    .filter(|v| !v.trim().is_empty());
            }
            _ => {}
        }
    }

    // 图片卡没有真实文件时按其 PNG 快照文件拖出（与 Windows 行为一致）
    if files.is_empty() {
        if let Some(path) = image_path {
            preview_png = fs::read(&path).ok();
            files.push(path);
        }
    }

    if files.is_empty() && plain.is_none() {
        return Err("没有可拖出的内容".to_string());
    }

    Ok(DragPayload {
        id: id.to_string(),
        hash: payload.hash.clone(),
        contents: contents_from_payload(payload.clone()).map(|(_, contents)| contents)?,
        files,
        plain,
        html,
        rtf,
        preview_png,
    })
}

/// 拖出：载荷整理与自回环抑制与平台无关，交由平台模块执行
/// Windows 后台监视（光标跟踪 + 左键释放粘贴）或 macOS 原生拖拽会话。
#[tauri::command]
async fn start_clip_drag_monitor(id: String, app: AppHandle) -> Result<(), String> {
    let state: State<AppState> = app.state();
    let payload = state.with_active_store(|store| store.payload_by_id(&id))?;
    let drag = build_drag_payload(&id, &payload)?;

    {
        let mut ignored = state
            .ignored_hashes
            .lock()
            .map_err(|_| "ignore lock poisoned".to_string())?;
        ignored.insert(drag.hash.clone(), Instant::now());
    }

    platform::start_drag_out(app, drag)
}

/// 把剪贴卡片导出为可拖出的真实文件列表（浏览器预览/调试用）。
#[tauri::command]
fn export_clip_paths(id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let (files, _) = clip_drag_targets(&state, &id)?;
    Ok(files
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

/// 从剪贴文本派生一个可读且合法的临时文件名
fn sanitize_clip_filename(format: &str, value: &str) -> String {
    let extension = match format {
        "text/html" => "html",
        "text/rtf" => "rtf",
        _ => "txt",
    };
    let head: String = value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                ' '
            }
        })
        .skip_while(|c| c.is_whitespace())
        .take(16)
        .collect();
    let trimmed = head.trim();
    if trimmed.is_empty() {
        format!("clip.{extension}")
    } else {
        format!("{trimmed}.{extension}")
    }
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

/// 恢复卡片到系统剪贴板，可选把内容粘贴进此前的前台应用。
/// restore_clip 命令与全局粘贴快捷键共用此路径。
fn restore_clip_inner(app: &AppHandle, id: &str, auto_paste: bool) -> Result<(), String> {
    let state: State<AppState> = app.state();
    let payload = state.with_active_store(|store| store.payload_by_id(id))?;
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
    if auto_paste {
        // 注入失败不丢内容：内容已进剪贴板，按 spec 安全降级为"已复制"
        if let Err(error) = platform::paste_to_target(app, &state) {
            let _ = app.emit(PASTE_DEGRADED, error);
        }
    }
    Ok(())
}

#[tauri::command]
fn restore_clip(id: String, auto_paste: bool, app: AppHandle) -> Result<(), String> {
    restore_clip_inner(&app, &id, auto_paste)
}

/// 查询粘贴注入所需的系统权限（macOS 辅助功能权限；Windows 恒可用）。
#[tauri::command]
fn check_paste_permission() -> Result<bool, String> {
    Ok(platform::accessibility_trusted())
}

/// 未授权时触发系统引导（macOS 打开系统设置 → 辅助功能）。
#[tauri::command]
fn request_paste_permission() -> Result<bool, String> {
    Ok(platform::request_accessibility())
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

#[tauri::command]
fn get_auto_paste(state: State<'_, AppState>) -> Result<bool, String> {
    state.auto_paste()
}

#[tauri::command]
fn set_auto_paste(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.set_auto_paste(enabled)
}

#[tauri::command]
fn set_panel_expanded(expanded: bool, app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "ClipRaft window unavailable".to_string())?;
    if expanded {
        let width = set_panel_width(&window, 184.0)?;
        dock_window(&window, width)
    } else {
        collapse_window(&window)
    }
}

/// 用户显式交互（悬停/点击把手/打开面板）后允许面板取得键盘焦点。
/// 仅 macOS 需要：复制预览期间窗口被设为不可聚焦（ADR-0002 焦点契约）。
#[tauri::command]
fn focus_panel(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "ClipRaft window unavailable".to_string())?;
        window
            .set_focusable(true)
            .map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    let _ = app;
    Ok(())
}

/// macOS 全局快捷键 ⌥⌘V：把最新木筏恢复并粘贴到前台应用
/// （对应 spec 的 Win+Alt+V；Windows 沿用面板内 F9）。
#[cfg(target_os = "macos")]
fn setup_global_paste_shortcut(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let paste_latest = Shortcut::from_str("cmd+alt+v")?;
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if *shortcut != paste_latest || event.state() != ShortcutState::Pressed {
                    return;
                }
                let state: State<AppState> = app.state();
                let latest = match state.with_active_store(|store| store.list()) {
                    Ok(cards) if !cards.is_empty() => cards[0].id.clone(),
                    _ => return,
                };
                if let Err(error) = restore_clip_inner(app, &latest, true) {
                    println!("ClipRaft global paste failed: {error}");
                }
            })
            .build(),
    )?;
    app.global_shortcut().register(paste_latest)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // macOS：托盘常驻，不显示 Dock 图标（对应 Windows skipTaskbar）
            #[cfg(target_os = "macos")]
            app.handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)
                .map_err(|error| format!("ClipRaft activation policy failed: {error}"))?;
            #[cfg(target_os = "macos")]
            disable_app_nap();
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("ClipRaft data directory failed: {error}"))?;
            app.manage(AppState::open(&data_dir)?);
            if let Some(window) = app.get_webview_window("main") {
                collapse_window(&window)?;
                let close_target = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_target.hide();
                    }
                });
            }
            setup_tray(app)?;
            start_clipboard_watcher(app.handle().clone());
            // macOS 全局快捷键：⌥⌘V 恢复并粘贴最新卡片
            #[cfg(target_os = "macos")]
            setup_global_paste_shortcut(app.handle())?;
            // macOS：悬停右缘灯带展开 / 离开收起
            #[cfg(target_os = "macos")]
            start_edge_hover_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            history_list,
            delete_clip,
            undo_delete,
            ingest_paths,
            set_clip_pinned,
            image_preview_data_url,
            export_clip_paths,
            start_clip_drag_monitor,
            restore_clip,
            clear_history,
            get_history_persistence,
            set_history_persistence,
            get_auto_paste,
            set_auto_paste,
            set_panel_expanded,
            focus_panel,
            check_paste_permission,
            request_paste_permission
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
    fn image_preview_is_exposed_as_a_local_data_url() {
        let state = AppState::in_memory();
        let png = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96,
            0, 0, 0, 4, 0, 1, 161, 13, 10, 45, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ];
        let capture = ClipboardCapture {
            card: ClipCard {
                id: "image-card".to_string(),
                kind: "image".to_string(),
                preview: "PNG · 1×1".to_string(),
                detail: "图片 · 已保存 PNG 快照".to_string(),
                copied_at: now_label(),
                use_count: 1,
                pinned: false,
            },
            hash: digest_bytes("image/png\0", &png),
            representations: vec![CapturedRepresentation::Bytes {
                format: "image/png".to_string(),
                value: png.clone(),
            }],
        };
        let card = ingest_capture(&state, capture).expect("image capture");
        let preview = state
            .store
            .lock()
            .expect("store lock")
            .image_preview_data_url(&card.id)
            .expect("image preview")
            .expect("image preview url");
        assert_eq!(
            preview,
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            )
        );
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
    fn pin_state_is_persisted_without_reordering_the_raft() {
        let state = AppState::in_memory();
        let first = ingest_text(&state, "first raft".to_string()).expect("first raft");
        let second = ingest_text(&state, "second raft".to_string()).expect("second raft");
        let pinned = state
            .store
            .lock()
            .expect("store lock")
            .list()
            .expect("list cards");
        assert_eq!(pinned[0].id, second.id);

        let updated = state
            .store
            .lock()
            .expect("store lock")
            .set_pinned(&first.id, true)
            .expect("pin raft");
        assert!(updated.pinned);

        let cards = state
            .store
            .lock()
            .expect("store lock")
            .list()
            .expect("list after pin");
        assert_eq!(cards[0].id, second.id);
        assert!(cards.iter().any(|card| card.id == first.id && card.pinned));
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

    #[test]
    fn auto_paste_setting_is_persistent_and_independent_from_history_mode() {
        let state = AppState::in_memory();
        assert!(state.auto_paste().expect("default auto paste"));
        state.set_auto_paste(false).expect("disable auto paste");
        assert!(!state.auto_paste().expect("read auto paste"));
        state
            .set_history_persistence(false)
            .expect("disable history persistence");
        assert!(!state
            .auto_paste()
            .expect("read auto paste after history change"));
    }
}
