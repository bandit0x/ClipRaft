//! macOS 实现：辅助功能权限、CGEvent ⌘V 注入；（切片 4）原生 NSDraggingSession 拖出。
//! 键盘事件注入移植自 EcoPaste `src-tauri/src/keystroke/macos.rs`（Apache-2.0），
//! 详见 THIRD_PARTY_NOTICES.md。
use std::thread;
use std::time::Duration;

use clipboard_rs::Clipboard;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

use super::{DragEnded, DragPayload};
use crate::{AppState, PASTE_DEGRADED};

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

/// 原生拖出：把载荷派发到主线程启动 NSDraggingSession（无需任何系统权限）。
/// macOS 上 `run_on_main_thread` 派发后立即返回，落点通过 `drag://ended` 事件回传。
pub fn start_drag_out(app: AppHandle, payload: DragPayload) -> Result<(), String> {
    // 文本卡片走"松手即粘贴"（与 Windows 同语义）：聊天框等目标不接受
    // 文本拖入，原生文本拖拽落不进去；文件/图片卡片走原生拖拽会话（已验证可用）。
    if payload.plain.is_some() {
        return start_text_paste_drag(app, payload);
    }
    // 拖拽期间悬停监视器暂停"离开即收起"
    app.state::<AppState>()
        .dragging
        .store(true, Ordering::Relaxed);
    let app_for_thread = app.clone();
    let dispatch = app.run_on_main_thread(move || {
        let Some(window) = app_for_thread.get_webview_window("main") else {
            app_for_thread
                .state::<AppState>()
                .dragging
                .store(false, Ordering::Relaxed);
            return;
        };
        if let Err(error) = super::drag_out_macos::start_drag(&app_for_thread, &window, &payload) {
            println!("ClipRaft drag-out failed: {error}");
            app_for_thread
                .state::<AppState>()
                .dragging
                .store(false, Ordering::Relaxed);
            // 失败也要让前端结束拖拽状态
            let _ = app_for_thread.emit(
                "drag://ended",
                DragEnded {
                    id: payload.id,
                    x: 0.0,
                    y: 0.0,
                    dropped: false,
                },
            );
        }
    });
    if let Err(error) = dispatch {
        app.state::<AppState>()
            .dragging
            .store(false, Ordering::Relaxed);
        return Err(error.to_string());
    }
    Ok(())
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    /// 轮询物理左键状态：CGEventSourceButtonState 是被动查询，无需任何权限。
    /// 参数：kCGEventSourceStateCombinedSessionState = 0，kCGMouseButtonLeft = 0。
    fn CGEventSourceButtonState(state_id: u32, button: u32) -> bool;
}

/// 文本卡片"松手即粘贴"：后台轮询光标与左键（不依赖 WebView 指针事件，
/// 跨窗口拖出时网页事件流会断流），左键释放后：落点补一次点击聚焦输入框
/// → 内容写入剪贴板 → ⌘V。需要辅助功能权限；未授权时降级为"已复制"。
fn start_text_paste_drag(app: AppHandle, payload: DragPayload) -> Result<(), String> {
    if !accessibility_trusted() {
        // 降级不丢内容：文本进剪贴板，用户可手动 ⌘V
        let context = clipboard_rs::ClipboardContext::new().map_err(|error| error.to_string())?;
        context
            .set(payload.contents)
            .map_err(|error| error.to_string())?;
        let _ = app.emit(
            PASTE_DEGRADED,
            "拖出粘贴需要辅助功能权限，内容已复制到剪贴板",
        );
        return Ok(());
    }
    app.state::<AppState>()
        .dragging
        .store(true, Ordering::Relaxed);
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let start = Instant::now();
        let mut last = crate::edge_hover::cursor_location();
        // 等待左键释放（上限 15 秒防挂死），期间持续跟踪全局光标
        loop {
            thread::sleep(Duration::from_millis(16));
            let held = unsafe { CGEventSourceButtonState(0, 0) };
            if !held || start.elapsed() > Duration::from_secs(15) {
                break;
            }
            last = crate::edge_hover::cursor_location();
        }

        // 释放点落在本应用窗口内：视为面板内交互（如拖入垃圾区），取消粘贴
        let inside_own_window = app_for_thread
            .get_webview_window("main")
            .and_then(|window| {
                let scale = window.scale_factor().ok()?;
                let position = window.outer_position().ok()?;
                let size = window.outer_size().ok()?;
                let (wx, wy) = (position.x as f64 / scale, position.y as f64 / scale);
                let (ww, wh) = (size.width as f64 / scale, size.height as f64 / scale);
                Some(last.x >= wx && last.x <= wx + ww && last.y >= wy && last.y <= wy + wh)
            })
            .unwrap_or(false);
        if inside_own_window {
            app_for_thread
                .state::<AppState>()
                .dragging
                .store(false, Ordering::Relaxed);
            return;
        }

        // 落点补一次左键点击：让目标可编辑区拿到焦点与光标（需辅助功能权限）
        let point = core_graphics::geometry::CGPoint {
            x: last.x,
            y: last.y,
        };
        let click_result = (|| -> Result<(), String> {
            let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
                .map_err(|_| "CGEventSource 创建失败".to_string())?;
            let down = CGEvent::new_mouse_event(
                source.clone(),
                CGEventType::LeftMouseDown,
                point,
                CGMouseButton::Left,
            )
            .map_err(|_| "鼠标按下事件创建失败".to_string())?;
            down.post(CGEventTapLocation::HID);
            thread::sleep(Duration::from_millis(50));
            let up = CGEvent::new_mouse_event(
                source,
                CGEventType::LeftMouseUp,
                point,
                CGMouseButton::Left,
            )
            .map_err(|_| "鼠标抬起事件创建失败".to_string())?;
            up.post(CGEventTapLocation::HID);
            Ok(())
        })();
        if let Err(error) = click_result {
            println!("ClipRaft text drag click failed: {error}");
        }
        thread::sleep(Duration::from_millis(160));

        let context = match clipboard_rs::ClipboardContext::new() {
            Ok(context) => context,
            Err(_) => {
                app_for_thread
                    .state::<AppState>()
                    .dragging
                    .store(false, Ordering::Relaxed);
                return;
            }
        };
        if context.set(payload.contents).is_err() {
            app_for_thread
                .state::<AppState>()
                .dragging
                .store(false, Ordering::Relaxed);
            return;
        }
        thread::sleep(Duration::from_millis(120));
        let _ = send_paste();
        app_for_thread
            .state::<AppState>()
            .dragging
            .store(false, Ordering::Relaxed);
    });
    Ok(())
}
