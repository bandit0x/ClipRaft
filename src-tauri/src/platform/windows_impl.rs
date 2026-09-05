//! Windows 实现：前台窗口记录 / SetForegroundWindow + SendInput 粘贴 / 拖出粘贴监视。
//! 从 lib.rs 原样迁入，行为不变。
use std::thread;
use std::time::{Duration, Instant};

use clipboard_rs::ClipboardContent;
use tauri::AppHandle;
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    mouse_event, GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, VK_CONTROL, VK_LBUTTON, VK_V,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetForegroundWindow, IsWindow, SetCursorPos, SetForegroundWindow,
    WindowFromPoint, GA_ROOT,
};

use crate::AppState;

/// Windows 注入键击无需系统权限。
pub fn accessibility_trusted() -> bool {
    true
}

pub fn request_accessibility() -> bool {
    true
}

/// 记录当前前台窗口，作为后续自动粘贴的目标。
pub fn remember_paste_target(state: &AppState) {
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return;
    }
    if let Ok(mut last_active_window) = state.last_active_window.lock() {
        *last_active_window = Some(window as usize);
    }
}

/// 把上一个前台窗口带回前台并注入 Ctrl+V。
pub fn paste_to_target(_app: &AppHandle, state: &AppState) -> Result<(), String> {
    let handle = state
        .last_active_window
        .lock()
        .map_err(|_| "active window lock poisoned".to_string())?
        .to_owned()
        .ok_or_else(|| "previous active window unavailable".to_string())?;
    let window = handle as HWND;
    if unsafe { IsWindow(window) } == 0 {
        return Err("previous active window is no longer available".to_string());
    }
    if unsafe { SetForegroundWindow(window) } == 0 {
        return Err("previous active window rejected focus".to_string());
    }
    thread::sleep(Duration::from_millis(35));
    send_paste()
}

pub fn send_paste() -> Result<(), String> {
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err("paste input was rejected".to_string())
    }
}

/// 拖出粘贴监视：记录卡片内容后，后台轮询全局光标与左键状态——
/// 不依赖 WebView2 的指针事件（跨窗口拖出时网页事件流会断流）。
/// 左键释放即：内容写入剪贴板 → 聚焦落点窗口 → 落点点击 → Ctrl+V。
pub fn start_drag_out(
    _app: AppHandle,
    _hash: String,
    contents: Vec<ClipboardContent>,
) -> Result<(), String> {
    thread::spawn(move || {
        // 等待左键释放（上限 15 秒防挂死），期间持续跟踪全局光标
        let mut last = POINT { x: 0, y: 0 };
        let start = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(16));
            let (cursor, held) = unsafe {
                let mut pt = POINT { x: 0, y: 0 };
                GetCursorPos(&mut pt);
                let held = (GetAsyncKeyState(VK_LBUTTON.into()) as u32 & 0x8000) != 0;
                (pt, held)
            };
            last = cursor;
            if !held || start.elapsed() > Duration::from_secs(15) {
                break;
            }
        }

        let point = POINT {
            x: last.x,
            y: last.y,
        };
        let target = unsafe { WindowFromPoint(point) };
        let target_root = unsafe { GetAncestor(target, GA_ROOT) };
        unsafe { SetForegroundWindow(target_root) };
        thread::sleep(Duration::from_millis(140));
        // 落点补一次左键点击：让目标可编辑区拿到焦点与光标
        unsafe {
            SetCursorPos(point.x, point.y);
            mouse_event(0x0002, 0, 0, 0, usize::default());
        }
        thread::sleep(Duration::from_millis(50));
        unsafe {
            mouse_event(0x0004, 0, 0, 0, usize::default());
        }
        thread::sleep(Duration::from_millis(160));

        let context = match clipboard_rs::ClipboardContext::new() {
            Ok(context) => context,
            Err(_) => return,
        };
        if context.set(contents).is_err() {
            return;
        }
        thread::sleep(Duration::from_millis(120));
        let _ = send_paste();
    });
    Ok(())
}
