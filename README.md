# ClipRaft

ClipRaft 是一个本机优先的多模态剪贴板浮窗。它平时只留下贴在屏幕边缘的窄溪把手，复制时自动展开，让文本、图片和文件以一张张小木筏顺流保存。支持 Windows 10/11 与 macOS。

## 本地开发

```bash
npm install
```

运行 Tauri 桌面窗口：

```bash
npm run tauri dev
```

## 当前能力

- 系统剪贴板自动捕获文本、图片和文件，并按复制顺序保存为独立卡片。
- 重复内容复用原卡片并回到上游；图片卡片显示本地 PNG 快照，文件卡片保留原路径列表。
- 卡片支持单击选中、双击或 Enter 恢复、搜索、固定、拖入文件和拖到垃圾区删除，删除后 5 秒内可撤销。
- 按住木筏拖动，松手把内容投递到目标窗口：Windows 上自动聚焦落点窗口并模拟粘贴；macOS 上走原生拖拽会话（把文本/HTML/RTF/图片/文件直接交给目标应用，无需额外权限）。三种模态的木筏以颜色与形状区分：文本青竹简、图片紫画框、文件橙货舱。
- 恢复时可选择自动粘贴到复制前的前台应用（Windows 用 SendInput Ctrl+V；macOS 用 CGEvent ⌘V，需要辅助功能权限），也可以关闭自动粘贴而只复制到系统剪贴板。
- 历史持久化可以在底部设置按钮中关闭；关闭后新内容只保留在本次会话内，应用重启不会带入会话内容。
- 窗口启动时吸附当前显示器右侧；收起态原生窗口缩为窄把手，不遮挡桌面；复制或托盘左键会展开，关闭按钮只隐藏到托盘。
- macOS：应用常驻菜单栏托盘、无 Dock 图标；复制预览不抢焦点（面板保持不可聚焦直到悬停/点击）；⌥⌘V 全局快捷键把最新木筏恢复并粘贴到前台应用。
- 拖入 Finder/资源管理器文件会创建文件木筏；拖动木筏时出现垃圾区，可用来软删除。

## macOS 说明

- 透明小溪窗口使用 `macOSPrivateApi`（私有 API），因此不会上架 Mac App Store，只做直接分发。
- 自动粘贴需要授予**辅助功能**权限：首次自动粘贴降级时会自动打开 系统设置 → 隐私与安全性 → 辅助功能，把 ClipRaft 加入列表并开启即可；未授权时内容仍会正常复制到剪贴板。
- 已知限制：面板无法显示在原生全屏应用所在的 Space 之上；多显示器混合 DPI 定位可能受 Tauri 已知 bug 影响。

## 本地验证

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
cargo fmt --check --manifest-path src-tauri/Cargo.toml
npm run build
npm run tauri build
```

项目只使用本地 Git，未配置远程仓库，不执行 `git push`。
