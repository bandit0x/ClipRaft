# ClipRaft

ClipRaft 是一个本机优先的 Windows 多模态剪贴板浮窗。它平时只留下贴在屏幕边缘的窄溪把手，复制时自动展开，让文本、图片和文件以一张张小木筏顺流保存。

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
- 卡片支持单击选中、双击或 Enter 恢复、搜索、固定、拖入和拖到垃圾区删除，删除后 5 秒内可撤销。
- 恢复时可选择自动粘贴到复制前的前台应用，也可以关闭自动粘贴而只复制到系统剪贴板。
- 历史持久化可以在底部设置按钮中关闭；关闭后新内容只保留在本次会话内，应用重启不会带入会话内容。
- 窗口启动时吸附当前显示器右侧；收起态原生窗口缩为窄把手，不遮挡桌面；复制或托盘左键会展开，关闭按钮只隐藏到托盘。
- 拖入 Explorer 文件会创建文件木筏；拖动木筏时出现垃圾区，可用来软删除。

## 本地验证

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
cargo fmt --check --manifest-path src-tauri/Cargo.toml
npm run build
npm run tauri build
```

项目只使用本地 Git，未配置远程仓库，不执行 `git push`。
