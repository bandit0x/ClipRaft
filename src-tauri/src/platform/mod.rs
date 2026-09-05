//! 平台边界：把前台窗口、粘贴键注入和拖出实现隔离在平台模块后面。
//!
//! lib.rs 只调用这里的接口，永远不直接接触 Win32 / AppKit。
//! 接口约定（对应 spec 的 Capture / Paste / Drag 深模块切面）：
//! - [`remember_paste_target`]：在用户复制时记录"恢复目标"。
//! - [`paste_to_target`]：把内容粘贴回恢复目标；失败时调用方按 spec 安全降级为"已复制"。
//! - [`send_paste`]：向前台注入粘贴键（Ctrl+V / Cmd+V）。
//! - [`start_drag_out`]：开始把卡片内容拖出/投递到目标应用。
//! - [`accessibility_trusted`] / [`request_accessibility`]：注入类操作所需的系统权限。

use clipboard_rs::ClipboardContent;
use serde::Serialize;
use std::path::PathBuf;

/// 一次拖出的完整载荷：Windows 需要可写回剪贴板的 `contents`，
/// macOS 原生拖拽会话需要 `files` / 文本表示 / `preview_png` 预览。
pub struct DragPayload {
    pub id: String,
    pub hash: String,
    // 仅 Windows 平台实现读取（拖出后写回剪贴板），macOS 由拖拽会话直接携带数据
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub contents: Vec<ClipboardContent>,
    pub files: Vec<PathBuf>,
    pub plain: Option<String>,
    pub html: Option<String>,
    pub rtf: Option<String>,
    pub preview_png: Option<Vec<u8>>,
}

/// 拖拽会话结束回调：AppKit 屏幕坐标已换算为左上原点的逻辑点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragEnded {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub dropped: bool,
}

#[cfg(windows)]
mod windows_impl;
#[cfg(windows)]
pub use windows_impl::*;

#[cfg(target_os = "macos")]
mod drag_out_macos;
#[cfg(target_os = "macos")]
mod macos_impl;
#[cfg(target_os = "macos")]
pub use macos_impl::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod unsupported {
    use crate::AppState;
    use tauri::AppHandle;

    use super::{DragEnded, DragPayload};

    pub fn remember_paste_target(_state: &AppState) {}
    pub fn paste_to_target(_app: &AppHandle, _state: &AppState) -> Result<(), String> {
        Err("当前平台不支持自动粘贴".to_string())
    }
    pub fn send_paste() -> Result<(), String> {
        Err("当前平台不支持粘贴键注入".to_string())
    }
    pub fn start_drag_out(_app: AppHandle, _payload: DragPayload) -> Result<(), String> {
        Err("当前平台不支持拖出".to_string())
    }
    pub fn accessibility_trusted() -> bool {
        false
    }
    pub fn request_accessibility() -> bool {
        false
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub use unsupported::*;
