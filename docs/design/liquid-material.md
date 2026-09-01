# ClipRaft 液态材质实现记录

Status: implementation reference, 2026-09-02

## 参考来源

- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)：MIT；选择性移植其 GPU 流体的 advection、curl/vorticity、divergence、pressure 与 gradient subtract 管线，改写为 ClipRaft 的窄溪流 surface。
- [runvendo/fluidkit](https://github.com/runvendo/fluidkit)：参考“surface layer 与 content layer 分离”和 FLIP / stagger 补位原则。ClipRaft 已把流体 canvas、木筏表面和卡片内容分层，文本不参与缩放变形。
- [DevSam7t3/liquid-glass](https://github.com/DevSam7t3/liquid-glass)：MIT；参考 SVG displacement、边缘高光和无依赖降级策略。ClipRaft 当前采用 WebGL2 + CSS fallback，保留在 WebView2 不支持 WebGL 时的可读性。

## 当前落地

`src/flow/WebGLFluidBackdrop.ts` 从 MIT 项目的核心 pass 选择性移植出单个 WebGL2 canvas 的低分辨率流体速度场；`display` pass 再用这个真实速度场推动 caustic surface，最后以透明边缘保留桌面背景。所有动画均在独立 surface layer 上执行，React 文本和操作控件不被 shader 拉伸。

`src/App.css` 中的木筏采用不规则 clip-path、底层厚度、绳索和纸张纹理叠层；删除 / 去重时由 wrapper 执行 FLIP，木筏表面只做短暂漂移，避免卡片内容弹跳。

## 取舍

不引入完整流体模拟包或第三方 animation runtime：只保留 MIT 项目里适合窄边栏的核心 pass，并把模拟分辨率限制为 64×128–256。常驻桌面的首要目标是稳定、低功耗和不抢焦点；如果实机帧率达不到 60Hz，再通过同一速度场接口降低 pressure iterations 或关闭 vorticity，而不是回退到静态线条。
