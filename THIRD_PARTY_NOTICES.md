# ClipRaft 第三方代码与依赖说明

## 当前依赖

- Tauri、Tauri Plugin Opener：Apache-2.0 / MIT，版本由 `package-lock.json` 与 `Cargo.lock` 固定。
- React、React DOM、Vite、TypeScript：各自上游许可证，未复制其源代码。
- `clipboard-rs`：MIT，提供 Windows 剪贴板读取与监听能力。
- `blake3`：CC0-1.0 / Apache-2.0 / MIT，提供内容 hash。
- `base64`：MIT / Apache-2.0，将本地 PNG 快照编码为 WebView 可显示的 data URL。

## 计划中的选择性复用

ClipRaft 计划从 EcoPaste 的 Apache-2.0 固定提交 `5139d30b0f4c1309356a9b308c05092f1038bc9b` 选择性移植 clipboard、storage、SQLite 和 Windows drag-out 模块。移植发生前必须记录具体来源文件、保留原版权声明，并在此文件追加本地修改说明。

Ditto（GPL-3.0）、CopyQ（GPL-3.0）和 PasteBar（自定义 CC BY-NC/商业例外条款）目前只作为行为与架构研究资料，不复制代码。

## 液态材质代码与参考

- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)：MIT；`src/flow/WebGLFluidBackdrop.ts` 选择性移植并改写其 GPU 流体核心 pass，保留此处 MIT 版权声明。液态实现只复用此 5k+ star 级项目的核心方法。

## macOS 移植的选择性复用（2026-09-05）

- [EcoPaste](https://github.com/EcoPasteHub/EcoPaste)（Apache-2.0）macOS 模块选择性移植：
  - `src-tauri/src/platform/macos_impl.rs` 的 ⌘V 键盘事件注入移植自 EcoPaste `src-tauri/src/keystroke/macos.rs`（core-graphics CGEvent，keycode 0x09 + COMMAND，post HID tap），仅做错误类型与调用方适配。
  - `src-tauri/src/platform/drag_out_macos.rs` 移植自 EcoPaste `src-tauri/src/drag_out/macos.rs`（后者 vendor 自 `drag` v2.1.1 的 macOS 路径并做了预览图 DPI 解耦）：NSDraggingItem / NSPasteboardItem / DragSource 结构与 beginDraggingSession 流程一比一保留，本地改动为错误类型统一为 `String`、按 ClipRaft 的 `DragPayload` 分派文件/文本拖出、拖拽会话结束把落点经 Tauri event 回传前端。
  - 来源版本：EcoPaste master（2026-09 提交）。原版权声明：Copyright 2023-present EcoPaste contributors，Apache License 2.0（<http://www.apache.org/licenses/LICENSE-2.0>）。

ClipRaft 未捆绑上述项目的运行时或网站资源；液态核心为本地选择性移植，水面材质片来自批准视觉稿的本地裁切，运行时不联网、不上传视觉稿或用户剪贴板内容。
