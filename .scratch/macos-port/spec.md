# ClipRaft macOS 版移植规格

Status: in-progress
计划版本：2026-09-05
分支：`feature/macos`（自 `feature/zcode` 切出）

## 1. 交付目标

在保持 Windows 行为不变的前提下，交付 macOS 版 ClipRaft：复制文本/图片/文件 → 捕获卡片（去重/固定/软删除/撤销）→ 小溪面板展示（WebGL 流体水面 + 三色木筏）→ 恢复/自动粘贴/拖出/拖入/垃圾区 → 历史保留开关 → 托盘常驻 + 右缘停靠 + 不抢焦点复制预览。

## 2. 平台技术决策

- **剪贴板监听**：clipboard-rs 0.3.5 的 `ClipboardWatcherContext::new_with_interval(120ms)` 轮询 `NSPasteboard.changeCount`（macOS 无变更事件 API；Windows 事件驱动，忽略该参数）。
- **无 Dock 图标**：`set_activation_policy(Accessory)`，对齐 Windows `skipTaskbar`。
- **透明窗口**：`app.macOSPrivateApi: true`（私有 API，WKWebView `drawsBackground=false`；本产品不上架 App Store）。
- **焦点契约（ADR-0002）**：复制触发的展开先 `set_focusable(false)` 再 `show()`，不抢焦点；悬停/点击把手/托盘打开（`focus_panel` 命令）才恢复可聚焦。窗口配置 `acceptFirstMouse: true`。
- **停靠**：macOS 用 `monitor.work_area()` 避开菜单栏/程序坞；Windows 保留全屏高度停靠。macOS `set_size` 经事件循环异步生效，停靠一律使用目标宽度计算，不得事后查询 `outer_size`。
- **收起态灯带（macOS）**：窗口覆盖整条侧边工作区高度、宽 26pt（给把手 box-shadow 辉光留出渲染空间，窗口过窄会被裁剪）；悬停检测在 Rust 侧以 100ms 光标轮询实现（CGEventGetLocation，无需权限），不依赖 WebView 的 mousemove（非 key 窗口交付不可靠）；悬停展开、离开展开面板 2 秒收起；原生拖拽进行中（`dragging` 标志）暂停收起。Windows 保持 9pt 与点击展开的既有行为。
- **自动粘贴**：无需记录前台应用——面板从不激活前台 app；恢复时先隐藏面板（系统自动归还焦点）→ 80ms → CGEvent 注入 ⌘V（keycode 0x09 + COMMAND，post HID tap）。需辅助功能权限；未授权降级为"已复制"并首次引导授权（`AXIsProcessTrustedWithOptions` + kAXTrustedCheckOptionPrompt）。
- **拖出**：原生 `NSDraggingSession`（NSPasteboardItem + NSDraggingItem，`run_on_main_thread` 启动）。文本卡携带 plain/html/rtf 三表示；文件卡/图片卡按路径拖出（图片为受管 PNG 快照），预览图 DPI 与显示尺寸解耦（长边 128pt）。无需任何系统权限。
- **垃圾区**：拖拽会话结束回调把落点（换算为左上原点屏幕逻辑点）经 `drag://ended` 事件回传，前端换算物理像素后与垃圾区矩形比较；原生拖出经过本窗口时抑制 `onDragDropEvent` 自拖入。
- **全局快捷键**：`tauri-plugin-global-shortcut` 注册 ⌥⌘V = 恢复并粘贴最新卡片（对应 spec 的 Win+Alt+V）；Windows 沿用面板内 F9。
- **字体**：font-family 补 `-apple-system` / `PingFang SC`。

## 3. 架构

平台边界统一收口在 `src-tauri/src/platform/`：

- `mod.rs`：深模块接口（`remember_paste_target` / `paste_to_target` / `send_paste` / `start_drag_out` / 权限检查）与跨平台 `DragPayload`。
- `windows_impl.rs`：原 lib.rs 的 Win32 实现原样迁入（行为不变）。
- `macos_impl.rs`：辅助功能权限、CGEvent ⌘V、拖出派发。
- `drag_out_macos.rs`：原生拖拽会话（移植自 EcoPaste Apache-2.0）。

存储层（SQLite/去重/清理）、捕获管线（clipboard-rs）、前端 React/WebGL 全部平台无关。

## 4. 验收

- `cargo test`（9 项，平台无关）、`cargo check`、`cargo fmt --check`、`npm run build` 全绿。
- 真机闭环：复制文本/图片/文件捕获；去重回上游；固定；软删除+撤销；恢复到剪贴板；授权辅助功能后自动粘贴；拖出到 Finder/文本编辑器/聊天窗口；拖入建卡；历史保留开关重启行为；托盘开合；⌥⌘V。
- 打包 `npm run tauri build` 产出 .app。

## 5. 已知限制

- 原生窗口无法覆盖原生全屏 app 所在 Space（tao 仅 NSFloatingWindowLevel）；如需覆盖，后续引入 tauri-nspanel。
- 辅助功能权限是自动粘贴的硬门槛；未授权自动降级为仅复制。
- 打包后 Dock 图标可能偶现（Tauri #15005），兜底 `set_dock_visibility(false)`。
- 混合 DPI 多显示器定位存在 Tauri 已知 bug（#7890）；MVP 单显示器不受影响。
- ⌘V 注入对 Dvorak-QWERTY 等布局沿用 keycode 0x09，未做布局修正（Maccy #482）。
