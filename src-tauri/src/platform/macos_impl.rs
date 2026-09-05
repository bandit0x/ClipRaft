//! macOS 实现。切片 3/4 将填充：CGEvent ⌘V 注入 + 原生 NSDraggingSession 拖出。
use clipboard_rs::ClipboardContent;
use tauri::AppHandle;

use crate::AppState;

pub fn remember_paste_target(_state: &AppState) {
    // macOS 面板从不激活前台应用，恢复时先隐藏面板让系统自动归还焦点，
    // 因此无需记录前台窗口。
}

pub fn paste_to_target(_state: &AppState) -> Result<(), String> {
    Err("macOS 自动粘贴尚未实现".to_string())
}

pub fn send_paste() -> Result<(), String> {
    Err("macOS 粘贴键注入尚未实现".to_string())
}

pub fn start_drag_out(
    _app: AppHandle,
    _hash: String,
    _contents: Vec<ClipboardContent>,
) -> Result<(), String> {
    Err("macOS 拖出尚未实现".to_string())
}
