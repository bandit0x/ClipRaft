# ClipRaft 第三方代码与依赖说明

## 当前依赖

- Tauri、Tauri Plugin Opener：Apache-2.0 / MIT，版本由 `package-lock.json` 与 `Cargo.lock` 固定。
- React、React DOM、Vite、TypeScript：各自上游许可证，未复制其源代码。
- `clipboard-rs`：MIT，提供 Windows 剪贴板读取与监听能力。
- `blake3`：CC0-1.0 / Apache-2.0 / MIT，提供内容 hash。

## 计划中的选择性复用

ClipRaft 计划从 EcoPaste 的 Apache-2.0 固定提交 `5139d30b0f4c1309356a9b308c05092f1038bc9b` 选择性移植 clipboard、storage、SQLite 和 Windows drag-out 模块。移植发生前必须记录具体来源文件、保留原版权声明，并在此文件追加本地修改说明。

Ditto（GPL-3.0）、CopyQ（GPL-3.0）和 PasteBar（自定义 CC BY-NC/商业例外条款）目前只作为行为与架构研究资料，不复制代码。

## 液态材质代码与参考

- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)：MIT；`src/flow/WebGLFluidBackdrop.ts` 选择性移植并改写其 GPU 流体核心 pass，保留此处 MIT 版权声明。液态实现只复用此 5k+ star 级项目的核心方法。

ClipRaft 未捆绑上述项目的运行时或网站资源；液态核心为本地选择性移植，水面材质片来自批准视觉稿的本地裁切，运行时不联网、不上传视觉稿或用户剪贴板内容。
