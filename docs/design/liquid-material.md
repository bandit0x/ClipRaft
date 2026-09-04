# ClipRaft 液态材质实现记录

Status: implementation reference, 2026-09-02

## 参考来源

- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)：MIT、高星开源项目；选择性移植其 GPU 流体的 advection、curl/vorticity、divergence、pressure 与 gradient subtract 管线，改写为 ClipRaft 的窄溪流 surface。液态效果只以这个 5k+ star 级项目为代码与交互参考。
- 视觉保真基准：`.impeccable/mocks/creek-c-meander.png`（明亮绿松石浅溪、卵石透底、焦散光网、圆润河石与木质筏台）。

## 当前落地

`src/flow/WebGLFluidBackdrop.ts` 从 MIT 项目的核心 pass 选择性移植出单个 WebGL2 canvas 的低分辨率流体速度场（96–128 × 128–256）；display pass 输出**完整不透明水面**。像素合成路径（2026-09-03 重造后的最终架构）：

1. **波面 = 解析多波列**（`waveField`）：八列短碎波，能量集中在中小波长（32–90px），波向偏斜。**长波幅值必须压低**——110px 长波一旦占主导，波峰会横贯面板、随域扭曲荡成横拱（「一拱一拱」已被否）；域扭曲只用高频小幅（±5px），低频大幅会荡拱。相位速度 14–29px/s 向下游（缓溪档：过快会与静止的木筏脱节），并被流体速度场强拖曳（90px）。**禁用各向同性 fbm 噪声做水纹**——不规则圆斑块即用户痛斥的「迷彩大光斑」。法线取解析导数。
2. **木筏涟漪并入法线**：`raftRippleField` 的环坡度以有限差分并入 normal（解析波面接管法线后涟漪曾因此消失，被用户抓到），环另有中性亮带（0.28）。木筏 CSS 浮动 ±5–6px / ±3.6°、周期 3.8–4.6s，与水速匹配。
3. **焦散 = 波面 Laplacian**（webgl-water「面积压缩比」的解析退化）：多列波相长干涉处光线汇聚成细网，随波列整体向下游跑；`pow(convergence, 1.4)` 收细成丝，光色日光白。**禁用 voronoi 网格与噪声光丝**（均已被否）。
3. **水色 = 水下辐照模型（单一色相族）**：`body = 底色 × exp(-vec3(2.4,0.62,0.46)·depth) + 深度散射`；depth 只有均匀光学深度（0.55）加岸边变浅（0.16），**禁止任何大尺度色斑场**（迷彩已禁）。沙/石基色暖中性+冷中性（禁止 g>b 绿味）。照片纹理已从水色路径完全移除（其色相与程序化底色拼贴曾造成竖向异色带）。
4. **反射/高光**：three.js Water.js 公式——Schlick 菲涅尔（F0=0.02）+ `pow(dot(eye,reflect(-sunDir,n)),100)*2.0` 太阳镜面项。
5. **涟漪/浪花**：涟漪环**只属于木筏**——从船舷半径（≈48px）起波，扩到约 100px 后消散，无全局随机涟漪；木筏另有 bow/hull foam 与尾流。
6. **岸线**：窗口边缘白沫线由 shader 输出。

实现陷阱：GLSL ES 3.00 的保留字（`patch`、`sample` 等）不能用作变量名——编译失败只会 console.warn 并静默回退 CSS 兜底层，画面看似正常实则流体全无。FlowBackdrop 对 `active === false` 会打点告警；改动 shader 后必须确认画布 `width/height` 已被 resize（默认 300×150 即未渲染）。

流速标定：噪声坐标里 `time * k` 的屏幕速度 = `k * 0.26 / y 频率`（0.26 是全局 time 缩放），写系数前先换算，避免频闪或冻结。当前校准值：水底斑驳 ≈12px/s、焦散光丝 ≈14px/s、深槽照片漂移 ≈8px/s，全部向下游（屏幕下方）；曾因系数写在噪声空间导致光丝 2000px/s 频闪、斑驳近乎冻结（被用户判为「流速低」）。验证方法：rAF 帧内把画布拷到 2D canvas，对竖直像素带做互相关测位移。

CSS 侧（`src/App.css`）：`.water-photo-material` 保留为 WebGL 不可用时的静态降级层（正常被不透明画布覆盖）；此前的 `.water-caustic-layer`（92px 平铺小图，方块感的元凶）与 `.water-highlight` 假光斑已删除。标题/搜索改为**刻字河石**（多层 radial-gradient + 斑点网、不规则 border-radius），底部 dock 为横向木板平台，木筏卡片以圆角厚木 + 绳框呈现，纸片圆角微旋。卡片操作按钮默认隐藏，hover/选中时出现。分界线类装饰（`::before/::after` 暗带、四象限 conic 渐变、硬 stop 渐变）全部移除。

React 文本和操作控件不被 shader 拉伸。木筏升沉/横摇动画与 FLIP 补位逻辑保持不变；删除 / 去重时由 wrapper 执行 FLIP，避免卡片内容弹跳。

## 性能

display pass 是逐像素成本大头。为保住常驻 60Hz（实机 IAB/WebView2 实测满刷新率）：

- fbm 限 3 阶（`fbm3`）；height 场法线只采样 3 点，环剖面用 smoothstep。
- 深浅水分支：深水区跳过 voronoi 卵石与 cellular caustic。
- sparkle / 天空降为单 octave noise；canvas DPR 上限 1.25。
- 降级路径：如果实机帧率仍不达标，先降 pressure iterations 或关闭 vorticity，再考虑进一步收窄浅水分支，而不是回退到静态线条。
