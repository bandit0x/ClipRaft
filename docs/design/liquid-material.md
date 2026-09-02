# ClipRaft 液态材质实现记录

Status: implementation reference, 2026-09-02

## 参考来源

- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)：MIT、高星开源项目；选择性移植其 GPU 流体的 advection、curl/vorticity、divergence、pressure 与 gradient subtract 管线，改写为 ClipRaft 的窄溪流 surface。液态效果只以这个 5k+ star 级项目为代码与交互参考。

## 当前落地

`src/flow/WebGLFluidBackdrop.ts` 从 MIT 项目的核心 pass 选择性移植出单个 WebGL2 canvas 的低分辨率流体速度场；`display` pass 用速度场推动域扭曲的波面、方向性尾流和 caustic surface。折射与高光采用原尺度 10 倍以上的远景高频采样，避免出现贴近水面的超大网格。`public/assets/plates/creek-water-v2.png` 以两个交叠、羽化的远景切片提供低频颜色 / 反光材质，不承担动画，也不产生可见拼接缝。

`src/App.css` 复用真实水面微纹理 `public/assets/stream-water.png` 补足远景密度，也作为 WebView2 无法启用浮点纹理扩展时的材质降级路径。摄影材质保持静态，不使用有限周期位移动画；动态水流只来自连续时间的 WebGL surface，避免纹理在循环边界跳回起点。React 文本和操作控件不被 shader 拉伸。

木筏扩散环虽然周期性生成，但每一圈都使用首尾透明的生命周期包络，在半径重置前完全淡出，避免出现水环瞬移回中心的重播断点。

`src/App.css` 中的木筏采用不规则 clip-path、底层厚度、绳索和纸张纹理叠层；木筏持续进行小幅升沉和横摇，左右舷白沫、船底水环与 WebGL 尾流共同表现贴水关系。删除 / 去重时由 wrapper 执行 FLIP，避免卡片内容弹跳。

## 取舍

不引入完整流体模拟包或第三方 animation runtime：只保留 MIT 项目里适合窄边栏的核心 pass，并把模拟分辨率限制为 64×128–256。常驻桌面的首要目标是稳定、低功耗和不抢焦点；如果实机帧率达不到 60Hz，再通过同一速度场接口降低 pressure iterations 或关闭 vorticity，而不是回退到静态线条。
