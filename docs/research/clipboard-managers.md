# Windows 多槽位多模态剪贴板：开源项目代码研究

采集日期：2026-09-01（Asia/Shanghai）。Stars 是采集时 GitHub REST API 的快照，会继续变化。资料只取 GitHub 仓库元数据、README、许可证与固定 commit 源码。

## 筛选结论

| 项目 | Stars | 栈 / Windows | 许可证 | 本研究角色 |
| --- | ---: | --- | --- | --- |
| [Ditto](https://github.com/sabrogden/Ditto) | [7,054](https://api.github.com/repos/sabrogden/Ditto) | [C++17、MFC/Win32/OLE、SQLite](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/CP_Main.vcxproj#L31-L33)；[仅 Windows](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/ReadMe.md#L9-L17) | [GPL-3.0](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/LICENSE) | Windows 剪贴板底层模板 |
| [EcoPaste](https://github.com/EcoPasteHub/EcoPaste) | [7,347](https://api.github.com/repos/EcoPasteHub/EcoPaste) | [Tauri v2、Rust、React 19、Ant Design 6、sqlx/SQLite](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/CONTRIBUTING.md#L35-L57)；[Windows + macOS](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/README.md#L6-L23) | [Apache-2.0](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/LICENSE) | 可直接复用的工程与存储模板 |
| [PasteBar](https://github.com/PasteBar/PasteBarApp) | [2,141](https://api.github.com/repos/PasteBar/PasteBarApp) | [Tauri 1.8、Rust、React 19、Diesel/SQLite、dnd-kit](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/README.md#L86-L89)；[Windows + macOS](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/README.md#L70-L74) | [自定义 CC BY-NC + limited commercial exception](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/CC-LICENSE) | 多板、多槽 UI/交互模板 |

另核验了 [CopyQ](https://github.com/hluk/CopyQ)：[12,203 stars](https://api.github.com/repos/hluk/CopyQ)、Windows 支持、C++/Qt、[GPL-3.0](https://github.com/hluk/CopyQ/blob/0abed10b903dcfb00f59de75b4fdfb2f9f2cda11/LICENSE)。它的自定义 tabs、任意 MIME 与双向拖拽非常成熟（[README](https://github.com/hluk/CopyQ/blob/0abed10b903dcfb00f59de75b4fdfb2f9f2cda11/README.md#L20-L37)），但 GPL 代码不可安全嵌入非 GPL 产品，Qt 列表式 UI 对“侧边浮窗 + 多槽板”也不如 PasteBar 贴近，因此未占最终三个名额。

## 1. Ditto：Windows 原生底层最值得学

### 用户体验与布局

Ditto 常驻托盘，复制时后台保存，不自动展开；用户点击托盘或按默认 `Ctrl + \`` 唤出 Quick Paste，双击/Enter 粘回此前窗口（[官方 README](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/ReadMe.md#L20-L25)）。历史按最近顺序呈现，重复内容不会新增一行，而是刷新原记录的排序值（[去重并更新 `clipOrder`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/Clip.cpp#L767-L809)）。

窗口支持光标处、鼠标处、上次位置，Always-on-top 与失焦 Auto Hide（[Quick Paste 选项](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/QPasteWnd.cpp#L1894-L1934)）；移动窗口接近显示器工作区边缘时会吸附（[SnapWindow](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/SnapWindow.cpp#L53-L103)）。注意：这是“移动时贴边 + 失焦隐藏”，不是本项目设想的“边缘留把手、悬停展开”。

格式层可保存文本、图片、HTML 与任意自定义 Windows clipboard format（[README](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/ReadMe.md#L9-L9)）；文件走 `CF_HDROP`。列表可把条目作为 OLE 数据拖到外部应用（[拖动入口](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/QPasteWnd.cpp#L5601-L5638)），但没有可直接照搬的“拖到垃圾区删除”交互。

### 源码架构映射

- 系统监听：[`ClipboardViewer.cpp`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/ClipboardViewer.cpp#L65-L103) 优先注册 `AddClipboardFormatListener`，兼容旧 `SetClipboardViewer`；收到变更后延时去抖并交给 [`CopyThread.cpp`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/CopyThread.cpp#L53-L127) 读取，失败还会按设置重试。
- 多格式解析：[`Clip.cpp::LoadFromClipboard`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/Clip.cpp#L350-L585) 通过 OLE 枚举/读取配置格式，保留 `CF_UNICODETEXT`、`CF_TEXT`、`CF_DIB`、`CF_HDROP` 与注册格式；同时尊重 Windows 的 `ExcludeClipboardContentFromMonitorProcessing` / `CanIncludeInClipboardHistory` 标记。
- 历史与持久化：[`Clip.cpp::AddToMainTable`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/Clip.cpp#L953-L992) 把展示、排序、分组、置顶元数据写入 `Main`；[`AddToDataTable`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/Clip.cpp#L1055-L1088) 以“一个条目多行 format/blob”的方式写入 `Data`。这是本次三个项目中最忠实保留 Windows 多表示格式的模型。
- 窗口：[`QPasteWnd.cpp`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/QPasteWnd.cpp#L1894-L1950) 管 Quick Paste，`SnapWindow.cpp` 管贴边，窗口层与剪贴板线程分离。
- 拖拽：[`OleClipSource.cpp`](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/OleClipSource.cpp#L39-L74) 延迟渲染全部格式；多选时可聚合文本、图片、RTF 和 `CF_HDROP`（[聚合路径](https://github.com/sabrogden/Ditto/blob/d36f864f9e6bc3558e11e3f1c9f5f522b8079702/src/OleClipSource.cpp#L95-L149)）。

### 可复用性审计

**分类：借鉴模式，不直接复制代码。** GPL-3.0 允许修改与分发，但把 Ditto 实现直接并入产品通常会带来整体 GPL 源码义务；除非本项目明确选择 GPL，否则不要复制其源码。

最值得保留的是设计而非代码：`WM_CLIPBOARDUPDATE` 监听 + 延迟读取/重试、尊重 Windows 隐私格式、同一 clip 的多 format 行、CRC 去重后刷新顺序、OLE delayed rendering。对应系统能力应重新基于 Microsoft API 或 permissive 库实现。若需要数据库加密，可另行评估 Ditto 使用的 SQLite3MultipleCiphers，但不应默认引入。

## 2. EcoPaste：最适合直接复用工程骨架与存储

### 用户体验与布局

EcoPaste 是 local-first 的 Windows/macOS 剪贴板，支持纯文本、HTML、RTF、图片、文件与文件夹，带预览、分组、收藏、置顶、备注、过滤和拖出（[官方功能清单](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/README.md#L19-L36)）。复制后后台入库并发 `clipboard://updated`，不会自动把窗口展开（[入库与 emit](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/watcher.rs#L122-L136)）；窗口由全局快捷键 toggle（[shortcut handler](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/shortcut/mod.rs#L230-L241)）。

位置策略只有 FollowCursor、Center、Remember，默认 FollowCursor（[设置模型](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/settings/model.rs#L564-L584)，[定位实现](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/window/position.rs#L36-L90)），Windows 上可点击窗口外自动隐藏（[Windows 窗口行为](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/window/windows.rs#L15-L80)），没有边缘吸附/折叠把手。

历史默认按最近使用时间，亦可按创建时间或使用次数；置顶始终优先（[查询排序](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/db/items.rs#L460-L481)）。值得注意的是，同一次剪贴板事件即使有多种表示，也按用户配置的捕获优先级归类为**一个 payload**（[read_with_capture](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/read.rs#L23-L63)）；这比 Ditto 的“保留全部 format”简单，但会丢掉同一内容的备用表示。

### 源码架构映射

- 系统监听：[`clipboard/watcher.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/watcher.rs#L1-L11) 直接复用 `clipboard-rs`，其 Windows 后端是 `AddClipboardFormatListener → WM_CLIPBOARDUPDATE`；监听线程只做同步读取/归一化，再交 Tauri async runtime 入库（[主回调](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/watcher.rs#L268-L310)）。
- 多格式解析：[`clipboard/read.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/read.rs#L23-L110) 读取 files/image/text+HTML+RTF；[`payload.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/payload.rs#L1-L35) 定义边界；[`ingest.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/ingest.rs#L182-L330) 做类型识别、hash、文件/图片转换与 DB model 构造。
- 历史与持久化：[`db/items.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/db/items.rs#L60-L140) 负责 hash 去重、insert、查询；SQLite FTS5 用于正文/备注搜索。图片不塞数据库 blob，而由 [`clipboard/storage.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/clipboard/storage.rs#L48-L116) 以内容摘要分片落盘，DB 只存引用，并按需生成缩略图。
- 窗口：[`window/mod.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/window/mod.rs#L112-L190) 统一 show/hide/toggle；`window/windows.rs` 管 Windows focusable、键盘导航与点击外部隐藏；`window/position.rs` 管多屏定位。
- 拖拽：React 卡片把浏览器 drag 事件转为 Tauri command（[`ClipboardCard.tsx`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src/pages/Clipboard/components/cards/ClipboardCard.tsx#L93-L149)）；[`commands/drag.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/commands/drag.rs#L26-L85) 按 item kind 派发；Windows 文件拖出复用 `drag` crate，文本/HTML/RTF 用 OLE `IDataObject` + `DoDragDrop`（[`drag_out/windows.rs`](https://github.com/EcoPasteHub/EcoPaste/blob/5139d30b0f4c1309356a9b308c05092f1038bc9b/src-tauri/src/drag_out/windows.rs#L1-L7)）。

### 可复用性审计

**分类：直接复用代码。** Apache-2.0 允许商业使用、修改和再分发；复用时保留许可证、版权/NOTICE，并记录修改。三者中它与本项目预期栈最接近，法律与技术成本最低。

优先复用范围：`clipboard-rs` watcher 薄封装、Windows 读取重试、`ClipboardPayload → ingest → upsert → event` 管线、SQLite/sqlx repository、图片 content-addressed 外置存储、`drag` crate 文件拖出，以及 Windows 文本/HTML/RTF `IDataObject`。不要整仓搬运；按上述模块边界逐块引入并保留来源说明。

## 3. PasteBar：最适合 UI/多槽交互模板

### 用户体验与布局

PasteBar 把历史、Collections、Tabs、Boards 和可保存 Clips 组合成主工作台，并另有 Quick Paste 浮窗（[README 功能与视频](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/README.md#L40-L74)，[panel/board resize 视频入口](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/README.md#L133-L153)）。主窗/Quick Paste 可由托盘或系统热键显示；Quick Paste 是 always-on-top 小窗，出现在鼠标附近并避开屏幕边界（[窗口创建与定位](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/main.rs#L530-L629)）。没有边缘 dock/自动折叠，也不会因复制自动展开。

历史按 `updated_date DESC` 分页（[history query](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/services/history_service.rs#L600-L631)）。内部拖拽是三者最成熟的：dnd-kit 统一处理 tab/board/clip，支持跨 tab 移动、置顶、排序与 drop-to-add（[`DndContext`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/packages/pastebar-app-ui/src/pages/components/Dashboard/Dashboard.tsx#L498-L519)，[`onDragEnd`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/packages/pastebar-app-ui/src/pages/components/Dashboard/Dashboard.tsx#L1194-L1268)，[Drop To Add](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/packages/pastebar-app-ui/src/pages/components/Dashboard/components/ClipDropZone.tsx#L23-L39)）。源码未呈现“拖入垃圾区删除”；删除仍应设计成独立命令并提供撤销。

多模态要谨慎解读：README 宣称支持 text/images/files/links/code，但当前自动监听实现先读 text，失败才读 image（[`on_clipboard_change`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/clipboard/mod.rs#L66-L107)，[image fallback](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/clipboard/mod.rs#L237-L293)）；未见自动捕获 Windows `CF_HDROP` 文件或保留 HTML/RTF。因此“文件”更适合作为保存 Clip/Board 能力理解，不能拿它做本项目的多格式底层。

### 源码架构映射

- 系统监听：[`clipboard/mod.rs`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/clipboard/mod.rs#L1-L27) 用 `clipboard-master` 驱动 callback、`arboard` 读文本/图，Windows 图片再用 `clipboard-win` 读取 PNG/DIB；[`init`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/clipboard/mod.rs#L511-L530) 启动 monitor。
- 格式解析：同一大文件 `clipboard/mod.rs` 内直接分支文本/图片，没有独立 MIME payload 层；这是可维护性弱点，不建议复制。
- 历史与持久化：[`history_service.rs`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/services/history_service.rs#L210-L311) 用感知 hash 去重图片、原图落盘、Diesel 写 SQLite；文本路径做 link/code/language 等派生识别（[`add_clipboard_history_from_text`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/services/history_service.rs#L389-L570)）。
- 窗口：[`main.rs`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/src-tauri/src/main.rs#L375-L526) 创建独立 History 窗；同文件的 `open_quickpaste_window` 创建鼠标旁 always-on-top Quick Paste。
- 拖拽：[`Dashboard.tsx`](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/packages/pastebar-app-ui/src/pages/components/Dashboard/Dashboard.tsx#L1194-L1598) 是内部 tab/board/clip 状态迁移中心。它解决的是应用内组织，不是把真实 OS 文件/图片/富文本拖到外部应用。

### 可复用性审计

**分类：不要复用代码，只借鉴交互。** 仓库不是标准 SPDX 许可证；自定义条款允许带署名复用部分函数/模块/snippet，但整体商业分发需额外许可（[条款 13–21](https://github.com/PasteBar/PasteBarApp/blob/bcad6a9dde0681c4e93bf2f2e38a6394a88d7760/CC-LICENSE#L13-L21)）。边界含糊，不值得把法律不确定性带进产品。

值得复用的是上游依赖而非 PasteBar 封装：`@dnd-kit/core`/`sortable` 做多槽拖放、`react-resizable-panels` 做可调整 board、`react-virtuoso` 做长历史虚拟列表。正式采用前分别核验上游许可证和当前维护状态。

## 横向结论与“不从零造”清单

**UI/交互模板选 PasteBar**：它把“历史流”和“用户固定槽位”清楚分开，boards/tabs 的拖动和可调整布局最接近本项目。**Windows 剪贴板底层选 Ditto**：它对系统格式、隐私标志、延迟读取、重复顺序和 OLE 的处理最老练。**存储与可落地工程选 EcoPaste**：Rust-first 边界、SQLite FTS5、图片外置、hash 去重和 Tauri command/event 最适合直接进入新项目。

不要从零实现以下能力：

- 剪贴板监听/读取：先用 `clipboard-rs`；Windows 底层最终依赖系统 `AddClipboardFormatListener`、`WM_CLIPBOARDUPDATE`、标准/注册 clipboard formats。
- 文件与富文本拖出：文件用 Rust `drag` crate；文本/HTML/RTF 用 Windows OLE `IDataObject`/`DoDragDrop`，可复用 EcoPaste Apache 实现。
- 历史数据库：SQLite + sqlx migration；搜索用 SQLite FTS5；图片原件/缩略图放文件系统，DB 存内容 hash 与相对路径。
- UI 拖放与长列表：`@dnd-kit` + `react-virtuoso`；panel resize 用成熟组件，不自写指针碰撞和虚拟化。
- 唤出与系统集成：Tauri v2 global shortcut、tray、single-instance；窗口定位使用 Windows monitor/work-area/DPI API，不能假设单屏或 100% 缩放。

## 对本项目的初步选型

建议以 **Tauri v2 + Rust + React 19 + TypeScript** 起步：直接采用 EcoPaste 的 Rust-first 分层和 permissive 模块，借鉴 Ditto 的 Windows 格式语义，借鉴 PasteBar 的“历史流 + 固定 boards/slots”视觉模型。第一版数据模型不应把一个复制动作压成单一字符串；建议 `clipboard_event` 为父记录、`representation` 为子记录（plain/HTML/RTF/image/file-list/custom format），另有 `slot`/`board` 关系。这样既保留 Ditto 的多格式真实性，又能用 EcoPaste 的 hash、FTS 和文件外置策略。

边缘浮窗需要单独做小而明确的状态机：`collapsed-handle → revealed → pinned-open`，位置持久化按 monitor identity + edge + offset 存储；复制事件只触发状态转换，不和采集/入库耦合。三个项目都没有完整实现这一交互，所以这里不能机械搬代码，但底层窗口、监视器、DPI、always-on-top 与失焦处理仍应复用 Tauri/Windows 能力。

以下问题必须在 grill-with-docs 用户访谈后决定，不能由技术调研代替：

- “每次复制自动展开”是否总是发生，还是仅鼠标靠近所在边、非全屏/游戏/演示、非敏感来源时发生；展开多久、是否抢焦点。
- “多槽位”是固定数量的短期槽，还是无限历史上的 pin/board；槽满时覆盖、拒绝还是自动扩容。
- 同一复制动作是否保留所有 Windows formats；文件是保存路径引用、复制实体快照，还是两者可选。
- 去重语义：重复复制应新建事件，还是把旧记录移到顶部；该选择会影响用户对“复制顺序”的信任。
- 拖拽删除是否立即删除、移入回收区还是只解除槽位；图片/文件资源何时真正回收，撤销窗口多长。
- 产品是否商业分发、是否需要跨设备同步/加密。这会直接决定许可证边界、数据库加密和数据迁移策略。
