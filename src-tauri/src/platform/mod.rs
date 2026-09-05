//! 平台边界：把前台窗口、粘贴键注入和拖出实现隔离在平台模块后面。
//!
//! lib.rs 只调用这里的接口，永远不直接接触 Win32 / AppKit。
//! 接口约定（对应 spec 的 Capture / Paste / Drag 深模块切面）：
//! - [`remember_paste_target`]：在用户复制时记录"恢复目标"。
//! - [`paste_to_target`]：把内容粘贴回恢复目标；失败时调用方按 spec 安全降级为"已复制"。
//! - [`send_paste`]：向前台注入粘贴键（Ctrl+V / Cmd+V）。
//! - [`start_drag_out`]：开始把卡片内容拖出/投递到目标应用。
//! - [`accessibility_trusted`] / [`request_accessibility`]：注入类操作所需的系统权限。

#[cfg(windows)]
mod windows_impl;
#[cfg(windows)]
pub use windows_impl::*;

#[cfg(target_os = "macos")]
mod macos_impl;
#[cfg(target_os = "macos")]
pub use macos_impl::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod unsupported {
    use crate::AppState;
    use clipboard_rs::ClipboardContent;
    use tauri::AppHandle;

    pub fn remember_paste_target(_state: &AppState) {}
    pub fn paste_to_target(_app: &AppHandle, _state: &AppState) -> Result<(), String> {
        Err("当前平台不支持自动粘贴".to_string())
    }
    pub fn send_paste() -> Result<(), String> {
        Err("当前平台不支持粘贴键注入".to_string())
    }
    pub fn start_drag_out(
        _app: AppHandle,
        _hash: String,
        _contents: Vec<ClipboardContent>,
    ) -> Result<(), String> {
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
