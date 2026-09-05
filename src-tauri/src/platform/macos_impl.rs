//! macOS 实现：辅助功能权限、CGEvent ⌘V 注入；（切片 4）原生 NSDraggingSession 拖出。
//! 键盘事件注入移植自 EcoPaste `src-tauri/src/keystroke/macos.rs`（Apache-2.0），
//! 详见 THIRD_PARTY_NOTICES.md。
use std::thread;
use std::time::Duration;

use clipboard_rs::ClipboardContent;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use tauri::{AppHandle, Manager};

use crate::AppState;

const KEY_V: CGKeyCode = 0x09; // kVK_ANSI_V

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// 是否已授予辅助功能权限（⌘V 注入的前置条件）。
pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// 检查并在未授权时弹出系统引导（打开系统设置 → 辅助功能）。
pub fn request_accessibility() -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let dict = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            CFBoolean::true_value().as_CFType() as CFType,
        )]);
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const std::ffi::c_void)
    }
}

pub fn remember_paste_target(_state: &AppState) {
    // macOS 面板从不激活前台应用，恢复时先隐藏面板让系统自动归还焦点，
    // 因此无需记录前台窗口。
}

/// 隐藏面板让系统把焦点还给此前的前台应用，再注入 ⌘V。
/// 需要辅助功能权限；未授权时返回 Err，调用方按 spec 降级为"已复制"。
pub fn paste_to_target(app: &AppHandle, _state: &AppState) -> Result<(), String> {
    if !accessibility_trusted() {
        return Err("需要辅助功能权限才能自动粘贴".to_string());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    thread::sleep(Duration::from_millis(80));
    send_paste()
}

pub fn send_paste() -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "CGEventSource 创建失败".to_string())?;
    let key_down = CGEvent::new_keyboard_event(source.clone(), KEY_V, true)
        .map_err(|_| "键盘按下事件创建失败".to_string())?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);
    thread::sleep(Duration::from_millis(30));
    let key_up = CGEvent::new_keyboard_event(source, KEY_V, false)
        .map_err(|_| "键盘抬起事件创建失败".to_string())?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);
    key_up.post(CGEventTapLocation::HID);
    Ok(())
}

pub fn start_drag_out(
    _app: AppHandle,
    _hash: String,
    _contents: Vec<ClipboardContent>,
) -> Result<(), String> {
    Err("macOS 拖出尚未实现".to_string())
}
