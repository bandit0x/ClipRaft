# ClipRaft

ClipRaft 是一个本机优先的 Windows 多模态剪贴板浮窗。当前首个纵切片已接入文本复制监听、历史流、恢复剪贴板和小溪木筏视觉预览。

## 本地开发

```bash
npm install
npm run dev
```

运行 Tauri 桌面窗口：

```bash
npm run tauri dev
```

## 当前能力

- 系统剪贴板自动捕获文本、图片和文件，并按复制顺序保存为独立卡片。
- 重复内容复用原卡片并回到上游；卡片支持恢复、搜索、拖入和拖到垃圾区删除，删除后 5 秒内可撤销。
- 卡片支持单击选中和 Enter 恢复；恢复时可选择自动粘贴到复制前的前台应用，也可以仅复制。
- 历史持久化可以在底部设置按钮中关闭；关闭后新内容只保留在本次会话内。
- 窗口启动时吸附当前显示器右侧，托盘左键可显示/隐藏，窗口关闭按钮只隐藏到托盘。

## 本地验证

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
npm run build
npm run tauri build
```

项目只使用本地 Git，未配置远程仓库，不执行 `git push`。
