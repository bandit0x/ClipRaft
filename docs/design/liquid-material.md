# ClipRaft 液态材质实现记录

Status: implementation reference, 2026-09-02

## 参考来源

- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)：MIT；参考其 GPU 流体的速度场 / 扰动思路。ClipRaft 不复制完整 Navier–Stokes 求解器，因为窄边栏常驻桌面时，完整交互式流体模拟的成本高于收益。
- [runvendo/fluidkit](https://github.com/runvendo/fluidkit)：参考“surface layer 与 content layer 分离”和 FLIP / stagger 补位原则。ClipRaft 已把流体 canvas、木筏表面和卡片内容分层，文本不参与缩放变形。
- [DevSam7t3/liquid-glass](https://github.com/DevSam7t3/liquid-glass)：MIT；参考 SVG displacement、边缘高光和无依赖降级策略。ClipRaft 当前采用 WebGL2 + CSS fallback，保留在 WebView2 不支持 WebGL 时的可读性。

## 当前落地

`src/App.tsx` 中的 `FlowBackdrop` 使用单个 WebGL2 canvas：以低频流向场推动双向波纹，使用 caustic field 生成水下折射光斑，再以透明边缘保留桌面背景。所有动画均在独立 surface layer 上执行，React 文本和操作控件不被 shader 拉伸。

`src/App.css` 中的木筏采用不规则 clip-path、底层厚度、绳索和纸张纹理叠层；删除 / 去重时由 wrapper 执行 FLIP，木筏表面只做短暂漂移，避免卡片内容弹跳。

## 取舍

目前不引入完整流体模拟包或第三方 animation runtime：边栏宽度只有约 200 logical px，常驻桌面的首要目标是稳定、低功耗和不抢焦点。后续如果实机帧率达不到 60Hz，再把 shader 降级为静态 caustics；如果需要鼠标扰动，再沿用同一速度场接口增加局部 impulse。
