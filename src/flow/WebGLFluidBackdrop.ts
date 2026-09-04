// Adapted from PavelDoGreat/WebGL-Fluid-Simulation (MIT).
// Source: https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
// Fresnel / sun specular structure adapted from three.js Water.js (MIT):
// https://github.com/mrdoob/three.js/blob/dev/examples/jsm/objects/Water.js
// Caustics approximated from the area-ratio technique in evanw/webgl-water (technique reference only, no license).

type RenderTarget = {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  texelX: number;
  texelY: number;
};

type DoubleTarget = {
  read: RenderTarget;
  write: RenderTarget;
  swap: () => void;
};

type Uniforms = Record<string, WebGLUniformLocation | null>;

export type FluidRaft = {
  x: number;
  y: number;
  strength: number;
};

type FluidSurfaceController = {
  setRafts: (rafts: FluidRaft[]) => void;
  cleanup: () => void;
  active: boolean;
};

const vertexSource = `#version 300 es
  layout(location = 0) in vec2 a_position;
  out vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const splatSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_target;
  uniform float u_aspect_ratio;
  uniform vec2 u_point;
  uniform vec2 u_amount;
  uniform float u_radius;
  out vec4 out_color;
  void main() {
    vec2 p = v_uv - u_point;
    p.x *= u_aspect_ratio;
    vec2 splat = exp(-dot(p, p) / u_radius) * u_amount;
    vec2 base = texture(u_target, v_uv).xy;
    out_color = vec4(base + splat, 0.0, 1.0);
  }
`;

const dyeSplatSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_target;
  uniform float u_aspect_ratio;
  uniform vec2 u_point;
  uniform vec3 u_amount;
  uniform float u_radius;
  out vec4 out_color;
  void main() {
    vec2 p = v_uv - u_point;
    p.x *= u_aspect_ratio;
    float splat = exp(-dot(p, p) / u_radius);
    vec3 base = texture(u_target, v_uv).rgb;
    out_color = vec4(base + splat * u_amount, 1.0);
  }
`;

const curlSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_velocity;
  uniform vec2 u_texel_size;
  out vec4 out_color;
  void main() {
    float left = texture(u_velocity, v_uv - vec2(u_texel_size.x, 0.0)).y;
    float right = texture(u_velocity, v_uv + vec2(u_texel_size.x, 0.0)).y;
    float top = texture(u_velocity, v_uv + vec2(0.0, u_texel_size.y)).x;
    float bottom = texture(u_velocity, v_uv - vec2(0.0, u_texel_size.y)).x;
    out_color = vec4(0.5 * (right - left - top + bottom), 0.0, 0.0, 1.0);
  }
`;

const vorticitySource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_velocity;
  uniform sampler2D u_curl;
  uniform vec2 u_texel_size;
  uniform float u_curl_strength;
  uniform float u_dt;
  out vec4 out_color;
  void main() {
    float left = texture(u_curl, v_uv - vec2(u_texel_size.x, 0.0)).x;
    float right = texture(u_curl, v_uv + vec2(u_texel_size.x, 0.0)).x;
    float top = texture(u_curl, v_uv + vec2(0.0, u_texel_size.y)).x;
    float bottom = texture(u_curl, v_uv - vec2(0.0, u_texel_size.y)).x;
    float center = texture(u_curl, v_uv).x;
    vec2 force = 0.5 * vec2(abs(top) - abs(bottom), abs(right) - abs(left));
    force /= length(force) + 0.0001;
    force *= u_curl_strength * center;
    force.y *= -1.0;
    vec2 velocity = texture(u_velocity, v_uv).xy + force * u_dt;
    out_color = vec4(clamp(velocity, vec2(-2.0), vec2(2.0)), 0.0, 1.0);
  }
`;

const divergenceSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_velocity;
  uniform vec2 u_texel_size;
  out vec4 out_color;
  void main() {
    vec2 left_uv = v_uv - vec2(u_texel_size.x, 0.0);
    vec2 right_uv = v_uv + vec2(u_texel_size.x, 0.0);
    vec2 top_uv = v_uv + vec2(0.0, u_texel_size.y);
    vec2 bottom_uv = v_uv - vec2(0.0, u_texel_size.y);
    vec2 center = texture(u_velocity, v_uv).xy;
    float left = texture(u_velocity, left_uv).x;
    float right = texture(u_velocity, right_uv).x;
    float top = texture(u_velocity, top_uv).y;
    float bottom = texture(u_velocity, bottom_uv).y;
    if (left_uv.x < 0.0) left = -center.x;
    if (right_uv.x > 1.0) right = -center.x;
    if (top_uv.y > 1.0) top = -center.y;
    if (bottom_uv.y < 0.0) bottom = -center.y;
    out_color = vec4(0.5 * (right - left + top - bottom), 0.0, 0.0, 1.0);
  }
`;

const pressureSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_pressure;
  uniform sampler2D u_divergence;
  uniform vec2 u_texel_size;
  out vec4 out_color;
  void main() {
    float left = texture(u_pressure, v_uv - vec2(u_texel_size.x, 0.0)).x;
    float right = texture(u_pressure, v_uv + vec2(u_texel_size.x, 0.0)).x;
    float top = texture(u_pressure, v_uv + vec2(0.0, u_texel_size.y)).x;
    float bottom = texture(u_pressure, v_uv - vec2(0.0, u_texel_size.y)).x;
    float divergence = texture(u_divergence, v_uv).x;
    out_color = vec4((left + right + bottom + top - divergence) * 0.25, 0.0, 0.0, 1.0);
  }
`;

const gradientSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_pressure;
  uniform sampler2D u_velocity;
  uniform vec2 u_texel_size;
  out vec4 out_color;
  void main() {
    float left = texture(u_pressure, v_uv - vec2(u_texel_size.x, 0.0)).x;
    float right = texture(u_pressure, v_uv + vec2(u_texel_size.x, 0.0)).x;
    float top = texture(u_pressure, v_uv + vec2(0.0, u_texel_size.y)).x;
    float bottom = texture(u_pressure, v_uv - vec2(0.0, u_texel_size.y)).x;
    vec2 velocity = texture(u_velocity, v_uv).xy - vec2(right - left, top - bottom);
    out_color = vec4(velocity * 0.98, 0.0, 1.0);
  }
`;

const advectionSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_velocity;
  uniform sampler2D u_source;
  uniform vec2 u_texel_size;
  uniform float u_dt;
  uniform float u_dissipation;
  out vec4 out_color;
  void main() {
    vec2 coordinate = v_uv - u_dt * texture(u_velocity, v_uv).xy * u_texel_size;
    vec2 result = texture(u_source, coordinate).xy;
    out_color = vec4(result / (1.0 + u_dissipation * u_dt), 0.0, 1.0);
  }
`;

const dyeAdvectionSource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_velocity;
  uniform sampler2D u_source;
  uniform vec2 u_texel_size;
  uniform float u_dt;
  uniform float u_dissipation;
  out vec4 out_color;
  void main() {
    vec2 coordinate = v_uv - u_dt * texture(u_velocity, v_uv).xy * u_texel_size;
    vec4 result = texture(u_source, coordinate);
    out_color = vec4(result.rgb / (1.0 + u_dissipation * u_dt), 1.0);
  }
`;

const displaySource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_velocity;
  uniform vec2 u_velocity_texel_size;
  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec3 u_raft_points[6];
  uniform int u_raft_count;
  out vec4 out_color;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  float fbm3(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec2(7.1, 3.7);
      amplitude *= 0.5;
    }
    return value;
  }

  // 解析波面：八列短碎波叠加（three.js Ocean 多波列思路的解析版）。
  // 波向偏斜、能量集中在中小波长（32–90px）——长波幅值过大时
  // 波峰会横贯面板荡成「拱」（已被否）。相位速度即真实像素速度
  // （14–29px/s 向下游）。返回 vec4(h, dh/dx, dh/dy, lap)：
  // 解析导数，法线与焦散都不需要额外采样。
  vec4 waveField(vec2 p, float rt) {
    float h = 0.0;
    float dx = 0.0;
    float dy = 0.0;
    float lap = 0.0;
    float q;
    vec2 k;
    float a;
    k = vec2(0.020, 0.055);  a = 0.18; q = dot(p, k) - rt * 1.05;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    k = vec2(-0.025, 0.081); a = 0.22; q = dot(p, k) - rt * 1.85;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    k = vec2(0.030, 0.125);  a = 0.20; q = dot(p, k) - rt * 3.20;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    k = vec2(-0.018, 0.194); a = 0.14; q = dot(p, k) - rt * 5.60;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    k = vec2(0.048, 0.052);  a = 0.14; q = dot(p, k) - rt * 1.00;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    k = vec2(-0.038, 0.048); a = 0.12; q = dot(p, k) - rt * 1.10;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    k = vec2(0.070, 0.090);  a = 0.08; q = dot(p, k) - rt * 2.96;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    k = vec2(-0.062, 0.085); a = 0.07; q = dot(p, k) - rt * 2.10;  h += a * sin(q); dx += a * k.x * cos(q); dy += a * k.y * cos(q); lap -= a * dot(k, k) * sin(q);
    return vec4(h, dx, dy, lap);
  }

  // 涟漪环只属于木筏：从船舷半径起波，扩到约一倍船长后消散
  float raftRipple(vec2 uv, vec3 raft, float time) {
    vec2 delta = (uv - raft.xy) * u_resolution;
    delta.x *= 1.08;
    float radius = length(delta / vec2(1.0, 1.28));
    float ringProgress = fract((time * 22.0 + raft.z * 24.0) / 100.0);
    float ringRadius = 48.0 + ringProgress * 52.0;
    float ringWidth = 1.5 + ringRadius * 0.02;
    float ringLife = smoothstep(0.0, 0.08, ringProgress) * (1.0 - smoothstep(0.62, 1.0, ringProgress));
    float ring = smoothstep(ringWidth, 0.0, abs(radius - ringRadius)) * exp(-ringRadius * 0.012) * ringLife * raft.z;

    float downstream = max(-delta.y, 0.0);
    float wakeSpread = 8.0 + downstream * 0.115;
    float wakeAxis = abs(delta.x + sin(downstream * 0.046 + time * 1.15) * 3.0);
    float wake = (1.0 - smoothstep(0.0, wakeSpread, wakeAxis)) * exp(-downstream * 0.011);
    float wakeWave = 0.5 + 0.5 * sin(downstream * 0.17 - time * 2.5 + sin(delta.x * 0.035) * 1.1);
    float bow = exp(-length(delta / vec2(13.0, 8.0))) * 0.62;
    return ring * 0.85 + wake * wakeWave * 0.42 + bow;
  }

  float raftRippleField(vec2 uv, float time) {
    float field = 0.0;
    for (int index = 0; index < 6; index++) {
      if (index < u_raft_count) field += raftRipple(uv, u_raft_points[index], time);
    }
    return field;
  }

  // 水底：灰石与沙的多频噪声斑驳。对比度拉出卵石质感，
  // 但刻意不用 voronoi 单元——规则的细胞状网格已被否掉。
  vec3 creekBottom(vec2 uv, float time, vec2 refr) {
    vec2 p = (uv + refr) * u_resolution;
    float large = noise(p * 0.024 + vec2(0.0, time * 1.08));
    float medium = noise(p * 0.06 + vec2(13.7, 4.2 + time * 2.7));
    float fine = noise(p * 0.17 + vec2(7.9, 1.3));
    float mottle = smoothstep(0.44, 0.55, large * 0.6 + medium * 0.4);
    vec3 sand = mix(vec3(0.78, 0.77, 0.70), vec3(0.88, 0.87, 0.80), fine);
    vec3 stone = mix(vec3(0.32, 0.38, 0.40), vec3(0.62, 0.70, 0.72), medium);
    vec3 bottom = mix(sand, stone, mottle);
    bottom *= 0.86 + 0.24 * fine;
    return bottom;
  }

  float raftFoam(vec2 uv, vec3 raft, float time) {
    vec2 delta = (uv - raft.xy) * u_resolution;
    float bow = exp(-length(delta / vec2(20.0, 11.0))) * 0.34;
    float hullRadius = length(delta / vec2(48.0, 63.0));
    float hullRipple = exp(-pow(abs(hullRadius - 1.0) * 5.0, 2.0)) * 0.28;
    float downstream = max(-delta.y, 0.0);
    float veeDistance = 8.0 + downstream * 0.13;
    float veeWidth = 2.1 + downstream * 0.012;
    float veeWake = exp(-pow((abs(delta.x) - veeDistance) / veeWidth, 2.0)) * exp(-downstream * 0.012);
    float centerSpread = 9.0 + downstream * 0.08;
    float centerWake = (1.0 - smoothstep(0.0, centerSpread, abs(delta.x))) * exp(-downstream * 0.018);
    float breakup = 0.46 + 0.54 * fbm3(vec2(delta.x * 0.028 + time * 0.06, downstream * 0.02 - time * 0.09));
    float wakeWave = 0.42 + 0.58 * sin(downstream * 0.18 - time * 1.75 + sin(delta.x * 0.04) * 0.8);
    float wake = (veeWake * 0.36 + centerWake * 0.12) * (0.42 + 0.58 * wakeWave) * breakup;
    return clamp((bow + hullRipple + wake) * raft.z, 0.0, 1.0);
  }

  float raftFoamField(vec2 uv, float time) {
    float field = 0.0;
    for (int index = 0; index < 6; index++) {
      if (index < u_raft_count) field = max(field, raftFoam(uv, u_raft_points[index], time));
    }
    return field;
  }

  void main() {
    vec2 uv = v_uv;
    float rt = u_time;
    float time = rt * 0.26;   // 旧动效（水底斑驳漂移/泡沫/涟漪环）的时间轴
    vec3 viewDir = normalize(vec3(0.10, -0.10, 1.0));
    vec3 sunDirection = normalize(vec3(-0.35, 0.88, 1.4));
    vec3 sunColor = vec3(1.0, 0.98, 0.92);

    // 波网只随自身相位速度整体输运；流场位移已完全移除——低分辨率
    // 流场的缓慢演化会让整片纹理蠕动（用户否决）。木筏对水面的作用
    // 由涟漪环与泡沫表达，不再位移波网。
    vec2 px = uv * u_resolution;
    px.y += (noise(px * vec2(0.016, 0.020) + vec2(0.0, rt * 0.22)) - 0.5) * 10.0;
    vec4 wave = waveField(px, rt);
    vec3 normal = normalize(vec3(-wave.y * 16.0, -wave.z * 16.0, 1.0));

    // 木筏涟漪并入法线：环的坡度折射焦散与高光（解析波面接管法线后
    // 涟漪一度消失，这里必须显式加回）
    float ringTexel = 2.0 / u_resolution.y;
    float ring0 = raftRippleField(uv, time);
    float ringX = raftRippleField(uv + vec2(ringTexel, 0.0), time);
    float ringY = raftRippleField(uv + vec2(0.0, ringTexel), time);
    vec2 ringGrad = vec2(ringX - ring0, ringY - ring0) / ringTexel;
    normal = normalize(vec3(normal.x - ringGrad.x * 9.0, normal.y - ringGrad.y * 9.0, 1.0));
    vec2 refr = normal.xy;

    // 焦散 = 波面 Laplacian（webgl-water 面积压缩比的解析退化）：
    // 多列波相长干涉处光线汇聚成细网，随波列整体向下游输运
    float convergence = clamp(-wave.w / 0.0138, -1.0, 1.0);
    float caustic = pow(max(convergence, 0.0), 1.4);

    // 水下辐照：均匀光学深度 + 岸边略浅；大尺度色斑已被禁（迷彩）
    float bank = min(uv.x, 1.0 - uv.x);
    float depth = mix(0.16, 0.55, smoothstep(0.0, 0.09, bank));
    vec3 transmission = exp(-vec3(2.4, 0.62, 0.46) * depth);

    vec2 bottomRefr = refr * (0.03 + 0.035 * (1.0 - depth));
    vec3 bottom = creekBottom(uv, time, bottomRefr);
    vec3 body = bottom * transmission * (0.80 + 0.85 * caustic) + vec3(0.02, 0.16, 0.18) * depth;

    // PavelDoGreat SHADING：波面朝向调制亮度，给液体体积感
    body *= clamp(0.55 + 0.5 * normal.z, 0.72, 1.06);

    // three.js Water.js：Schlick 菲涅尔（F0=0.02）+ pow=100 太阳镜面高光
    float cosTheta = max(dot(normal, viewDir), 0.0);
    float reflectance = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
    float spec = pow(max(dot(viewDir, normalize(reflect(-sunDirection, normal))), 0.0), 100.0) * 2.0;
    vec3 reflection = vec3(0.78, 0.90, 0.92) + sunColor * spec;
    vec3 color = mix(body, reflection, clamp(reflectance * 8.0, 0.0, 0.9));

    // 水面焦散泛白
    color += sunColor * caustic * 0.10;

    // 涟漪环亮带（只来自木筏，环的折射部分已并入法线）
    color += vec3(0.55, 0.60, 0.58) * ring0 * 0.28;

    // 浪花：木筏船首与尾流泡沫，加岸线白沫
    float foam = raftFoamField(uv, time);
    float shoreFoam = (1.0 - smoothstep(0.004, 0.020, bank)) * (0.55 + 0.45 * noise(vec2(uv.y * 140.0, time * 0.8)));
    foam = clamp(foam + shoreFoam * 0.7, 0.0, 1.0);
    color = mix(color, vec3(0.96, 1.0, 0.97), foam * 0.75);

    out_color = vec4(color, 1.0);
  }
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn("[ClipRaft] WebGL shader compile failed", gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  console.warn("[ClipRaft] WebGL program link failed", gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
  return null;
}

function getUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, names: string[]): Uniforms {
  return Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget | null {
  const texture = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!texture || !fbo) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (!complete) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  return { fbo, texture, width, height, texelX: 1 / width, texelY: 1 / height };
}

function createDoubleTarget(gl: WebGL2RenderingContext, width: number, height: number): DoubleTarget | null {
  const read = createTarget(gl, width, height);
  const write = createTarget(gl, width, height);
  if (!read || !write) return null;
  return { read, write, swap() { [this.read, this.write] = [this.write, this.read]; } };
}

function destroyTarget(gl: WebGL2RenderingContext, target: RenderTarget) {
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.fbo);
}

export function mountFluidSurface(canvas: HTMLCanvasElement): FluidSurfaceController {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return { setRafts: () => undefined, cleanup: () => undefined, active: false };

  const splatProgram = createProgram(gl, splatSource);
  const dyeSplatProgram = createProgram(gl, dyeSplatSource);
  const curlProgram = createProgram(gl, curlSource);
  const vorticityProgram = createProgram(gl, vorticitySource);
  const divergenceProgram = createProgram(gl, divergenceSource);
  const pressureProgram = createProgram(gl, pressureSource);
  const gradientProgram = createProgram(gl, gradientSource);
  const advectionProgram = createProgram(gl, advectionSource);
  const dyeAdvectionProgram = createProgram(gl, dyeAdvectionSource);
  const displayProgram = createProgram(gl, displaySource);
  const programs = [splatProgram, dyeSplatProgram, curlProgram, vorticityProgram, divergenceProgram, pressureProgram, gradientProgram, advectionProgram, dyeAdvectionProgram, displayProgram];
  if (programs.some((program) => !program)) return { setRafts: () => undefined, cleanup: () => undefined, active: false };

  const uniforms = {
    splat: getUniforms(gl, splatProgram!, ["u_target", "u_aspect_ratio", "u_point", "u_amount", "u_radius"]),
    dyeSplat: getUniforms(gl, dyeSplatProgram!, ["u_target", "u_aspect_ratio", "u_point", "u_amount", "u_radius"]),
    curl: getUniforms(gl, curlProgram!, ["u_velocity", "u_texel_size"]),
    vorticity: getUniforms(gl, vorticityProgram!, ["u_velocity", "u_curl", "u_texel_size", "u_curl_strength", "u_dt"]),
    divergence: getUniforms(gl, divergenceProgram!, ["u_velocity", "u_texel_size"]),
    pressure: getUniforms(gl, pressureProgram!, ["u_pressure", "u_divergence", "u_texel_size"]),
    gradient: getUniforms(gl, gradientProgram!, ["u_pressure", "u_velocity", "u_texel_size"]),
    advection: getUniforms(gl, advectionProgram!, ["u_velocity", "u_source", "u_texel_size", "u_dt", "u_dissipation"]),
    dyeAdvection: getUniforms(gl, dyeAdvectionProgram!, ["u_velocity", "u_source", "u_texel_size", "u_dt", "u_dissipation"]),
    display: getUniforms(gl, displayProgram!, ["u_velocity", "u_velocity_texel_size", "u_time", "u_resolution", "u_raft_points[0]", "u_raft_count"]),
  };

  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) return { setRafts: () => undefined, cleanup: () => undefined, active: false };

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let velocity: DoubleTarget | null = null;
  let divergence: RenderTarget | null = null;
  let curl: RenderTarget | null = null;
  let pressure: DoubleTarget | null = null;
  let dye: DoubleTarget | null = null;
  let simWidth = 0;
  let simHeight = 0;
  const raftData = new Float32Array(18);
  let raftCount = 0;
  let raftImpulseQueue: FluidRaft[] = [];
  let activeRafts: FluidRaft[] = [];
  let raftSnapshot = "";
  const setRafts = (rafts: FluidRaft[]) => {
    const nextRafts = rafts.slice(0, 6).map((raft) => ({ ...raft }));
    activeRafts = nextRafts;
    const nextSnapshot = nextRafts.map((raft) => `${raft.x.toFixed(3)},${raft.y.toFixed(3)},${raft.strength.toFixed(2)}`).join("|");
    if (nextSnapshot !== raftSnapshot) {
      raftImpulseQueue = nextRafts;
      raftSnapshot = nextSnapshot;
    }
    raftCount = nextRafts.length;
    raftData.fill(-2);
    nextRafts.forEach((raft, index) => {
      const offset = index * 3;
      raftData[offset] = raft.x;
      raftData[offset + 1] = raft.y;
      raftData[offset + 2] = Math.max(0, Math.min(1, raft.strength));
    });
  };

  const destroyTargets = () => {
    if (velocity) { destroyTarget(gl, velocity.read); destroyTarget(gl, velocity.write); }
    if (pressure) { destroyTarget(gl, pressure.read); destroyTarget(gl, pressure.write); }
    if (dye) { destroyTarget(gl, dye.read); destroyTarget(gl, dye.write); }
    if (divergence) destroyTarget(gl, divergence);
    if (curl) destroyTarget(gl, curl);
    velocity = null;
    pressure = null;
    dye = null;
    divergence = null;
    curl = null;
  };

  const initializeTargets = () => {
    const width = Math.min(128, Math.max(96, Math.round(canvas.width / 2.5)));
    const height = Math.max(128, Math.min(256, Math.round(width * canvas.height / Math.max(1, canvas.width))));
    if (width === simWidth && height === simHeight && velocity) return;
    destroyTargets();
    const nextVelocity = createDoubleTarget(gl, width, height);
    const nextPressure = createDoubleTarget(gl, width, height);
    const nextDivergence = createTarget(gl, width, height);
    const nextCurl = createTarget(gl, width, height);
    const nextDye = createDoubleTarget(gl, width, height);
    if (!nextVelocity || !nextPressure || !nextDivergence || !nextCurl || !nextDye) return;
    velocity = nextVelocity;
    pressure = nextPressure;
    divergence = nextDivergence;
    curl = nextCurl;
    dye = nextDye;
    simWidth = width;
    simHeight = height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.read.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.write.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.read.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.write.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dye.read.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dye.write.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const draw = (program: WebGLProgram, target: RenderTarget | null, setup: () => void) => {
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, target?.width ?? canvas.width, target?.height ?? canvas.height);
    setup();
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  };

  const bindTexture = (texture: WebGLTexture, unit: number, location: WebGLUniformLocation | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  };

  const splat = (x: number, y: number, amountX: number, amountY: number, radius = 0.004) => {
    if (!velocity) return;
    draw(splatProgram!, velocity.write, () => {
      bindTexture(velocity!.read.texture, 0, uniforms.splat.u_target);
      gl.uniform1f(uniforms.splat.u_aspect_ratio, canvas.width / Math.max(1, canvas.height));
      gl.uniform2f(uniforms.splat.u_point, x, y);
      gl.uniform2f(uniforms.splat.u_amount, amountX, amountY);
      gl.uniform1f(uniforms.splat.u_radius, radius);
    });
    velocity.swap();
  };

  const splatDye = (x: number, y: number, amount: number, radius = 0.012) => {
    if (!dye) return;
    draw(dyeSplatProgram!, dye.write, () => {
      bindTexture(dye!.read.texture, 0, uniforms.dyeSplat.u_target);
      gl.uniform1f(uniforms.dyeSplat.u_aspect_ratio, canvas.width / Math.max(1, canvas.height));
      gl.uniform2f(uniforms.dyeSplat.u_point, x, y);
      gl.uniform3f(uniforms.dyeSplat.u_amount, amount, amount, amount);
      gl.uniform1f(uniforms.dyeSplat.u_radius, radius);
    });
    dye!.swap();
  };

  const emitRaftImpulses = () => {
    if (!raftImpulseQueue.length) return;
    const rafts = raftImpulseQueue;
    raftImpulseQueue = [];
    rafts.forEach((raft) => {
      const force = 0.018 + raft.strength * 0.012;
      splat(raft.x, raft.y, 0.0, force, 0.006);
      splat(raft.x - 0.02, raft.y - 0.006, force * 0.34, force * 0.42, 0.004);
      splat(raft.x + 0.02, raft.y - 0.006, -force * 0.34, force * 0.42, 0.004);
      splatDye(raft.x, raft.y, 0.2 + raft.strength * 0.08, 0.014);
    });
  };

  let lastWakeEmission = 0;
  const emitRaftWakes = (now: number) => {
    if (!activeRafts.length || now - lastWakeEmission < 140) return;
    lastWakeEmission = now;
    activeRafts.forEach((raft) => {
      const force = 0.003 + raft.strength * 0.002;
      splat(raft.x, raft.y, 0.0, force, 0.008);
      splat(raft.x - 0.022, raft.y - 0.01, force * 0.24, force * 0.34, 0.005);
      splat(raft.x + 0.022, raft.y - 0.01, -force * 0.24, force * 0.34, 0.005);
    });
  };

  const step = (dt: number) => {
    if (!velocity || !divergence || !curl || !pressure) return;
    gl.disable(gl.BLEND);

    draw(curlProgram!, curl, () => {
      bindTexture(velocity!.read.texture, 0, uniforms.curl.u_velocity);
      gl.uniform2f(uniforms.curl.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
    });

    draw(vorticityProgram!, velocity.write, () => {
      bindTexture(velocity!.read.texture, 0, uniforms.vorticity.u_velocity);
      bindTexture(curl!.texture, 1, uniforms.vorticity.u_curl);
      gl.uniform2f(uniforms.vorticity.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
      gl.uniform1f(uniforms.vorticity.u_curl_strength, 12.0);
      gl.uniform1f(uniforms.vorticity.u_dt, dt);
    });
    velocity.swap();

    draw(divergenceProgram!, divergence, () => {
      bindTexture(velocity!.read.texture, 0, uniforms.divergence.u_velocity);
      gl.uniform2f(uniforms.divergence.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
    });

    draw(pressureProgram!, pressure.write, () => {
      bindTexture(pressure!.read.texture, 0, uniforms.pressure.u_pressure);
      bindTexture(divergence!.texture, 1, uniforms.pressure.u_divergence);
      gl.uniform2f(uniforms.pressure.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
    });
    pressure.swap();

    for (let iteration = 0; iteration < 8; iteration += 1) {
      draw(pressureProgram!, pressure.write, () => {
        bindTexture(pressure!.read.texture, 0, uniforms.pressure.u_pressure);
        bindTexture(divergence!.texture, 1, uniforms.pressure.u_divergence);
        gl.uniform2f(uniforms.pressure.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
      });
      pressure.swap();
    }

    draw(gradientProgram!, velocity.write, () => {
      bindTexture(pressure!.read.texture, 0, uniforms.gradient.u_pressure);
      bindTexture(velocity!.read.texture, 1, uniforms.gradient.u_velocity);
      gl.uniform2f(uniforms.gradient.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
    });
    velocity.swap();

    draw(advectionProgram!, velocity.write, () => {
      bindTexture(velocity!.read.texture, 0, uniforms.advection.u_velocity);
      bindTexture(velocity!.read.texture, 1, uniforms.advection.u_source);
      gl.uniform2f(uniforms.advection.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
      gl.uniform1f(uniforms.advection.u_dt, dt);
      gl.uniform1f(uniforms.advection.u_dissipation, 0.08);
    });
    velocity.swap();

    draw(dyeAdvectionProgram!, dye!.write, () => {
      bindTexture(velocity!.read.texture, 0, uniforms.dyeAdvection.u_velocity);
      bindTexture(dye!.read.texture, 1, uniforms.dyeAdvection.u_source);
      gl.uniform2f(uniforms.dyeAdvection.u_texel_size, velocity!.read.texelX, velocity!.read.texelY);
      gl.uniform1f(uniforms.dyeAdvection.u_dt, dt);
      gl.uniform1f(uniforms.dyeAdvection.u_dissipation, 0.42);
    });
    dye!.swap();
  };

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    initializeTargets();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  for (let index = 0; index < 10; index += 1) {
    splat(0.5 + Math.sin(index * 2.3) * 0.06, 0.12 + index * 0.085, Math.sin(index * 1.7) * 0.04, 0.12, 0.009);
    splatDye(0.5 + Math.sin(index * 2.3) * 0.06, 0.12 + index * 0.085, 0.1, 0.018);
  }

  let frame = 0;
  let lastTime = performance.now();
  let lastImpulse = lastTime;
  const render = (now: number) => {
    const dt = Math.min((now - lastTime) / 1000, 0.0167);
    lastTime = now;
    if (velocity) {
      if (now - lastImpulse > 260) {
        const phase = now * 0.00032;
        splat(0.5 + Math.sin(phase * 1.7) * 0.055, 0.03, Math.sin(phase) * 0.045, 0.18, 0.008);
        lastImpulse = now;
      }
      emitRaftImpulses();
      emitRaftWakes(now);
      step(dt);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      draw(displayProgram!, null, () => {
        bindTexture(velocity!.read.texture, 0, uniforms.display.u_velocity);
        gl.uniform2f(uniforms.display.u_velocity_texel_size, velocity!.read.texelX, velocity!.read.texelY);
        gl.uniform1f(uniforms.display.u_time, now / 1000);
        gl.uniform2f(uniforms.display.u_resolution, canvas.width, canvas.height);
        gl.uniform3fv(uniforms.display.u_raft_points, raftData);
        gl.uniform1i(uniforms.display.u_raft_count, raftCount);
      });
      gl.disable(gl.BLEND);
    }
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);

  return {
    setRafts,
    active: true,
    cleanup: () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      destroyTargets();
      programs.forEach((program) => { if (program) gl.deleteProgram(program); });
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
    },
  };
}
