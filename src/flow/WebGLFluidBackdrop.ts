// Adapted from PavelDoGreat/WebGL-Fluid-Simulation (MIT).
// Source: https://github.com/PavelDoGreat/WebGL-Fluid-Simulation

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

const displaySource = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_velocity;
  uniform vec2 u_velocity_texel_size;
  uniform sampler2D u_water_texture;
  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec3 u_raft_points[6];
  uniform int u_raft_count;
  out vec4 out_color;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec2(7.1, 3.7);
      amplitude *= 0.5;
    }
    return value;
  }

  vec2 smoothVelocity(vec2 uv) {
    vec2 texel = u_velocity_texel_size;
    vec2 velocity = texture(u_velocity, clamp(uv, 0.001, 0.999)).xy * 0.28;
    velocity += texture(u_velocity, clamp(uv + vec2(texel.x, 0.0), 0.001, 0.999)).xy * 0.11;
    velocity += texture(u_velocity, clamp(uv - vec2(texel.x, 0.0), 0.001, 0.999)).xy * 0.11;
    velocity += texture(u_velocity, clamp(uv + vec2(0.0, texel.y), 0.001, 0.999)).xy * 0.11;
    velocity += texture(u_velocity, clamp(uv - vec2(0.0, texel.y), 0.001, 0.999)).xy * 0.11;
    velocity += texture(u_velocity, clamp(uv + vec2(texel.x, texel.y), 0.001, 0.999)).xy * 0.0675;
    velocity += texture(u_velocity, clamp(uv + vec2(texel.x, -texel.y), 0.001, 0.999)).xy * 0.0675;
    velocity += texture(u_velocity, clamp(uv + vec2(-texel.x, texel.y), 0.001, 0.999)).xy * 0.0675;
    velocity += texture(u_velocity, clamp(uv - vec2(texel.x, texel.y), 0.001, 0.999)).xy * 0.0675;
    return velocity;
  }

  float riverCenter(float y, float time) {
    float slowBend = sin(y * 4.3 + sin(time * 0.55 + y * 1.2) * 0.65 + time * 0.05) * 0.045;
    float smallBend = sin(y * 9.0 - time * 0.18) * 0.014;
    return 0.5 + slowBend + smallBend;
  }

  float raftRipple(vec2 uv, vec3 raft, float time) {
    vec2 delta = (uv - raft.xy) * u_resolution;
    delta.x *= 1.08;
    float radius = length(delta / vec2(1.0, 1.28));
    float ringRadius = 16.0 + mod(time * 28.0 + raft.z * 24.0, 124.0);
    float ringWidth = 1.5 + ringRadius * 0.016;
    float ring = exp(-pow(abs(radius - ringRadius) / ringWidth, 2.0)) * exp(-ringRadius * 0.009) * raft.z;

    float downstream = max(-delta.y, 0.0);
    float wakeSpread = 8.0 + downstream * 0.115;
    float wakeAxis = abs(delta.x + sin(downstream * 0.046 + time * 1.15) * 3.0);
    float wake = (1.0 - smoothstep(0.0, wakeSpread, wakeAxis)) * exp(-downstream * 0.011);
    float wakeWave = 0.5 + 0.5 * sin(downstream * 0.17 - time * 2.5 + sin(delta.x * 0.035) * 1.1);
    float bow = exp(-length(delta / vec2(13.0, 8.0))) * 0.62;
    return ring * 0.48 + wake * wakeWave * 0.42 + bow;
  }

  float raftRippleField(vec2 uv, float time) {
    float field = 0.0;
    for (int index = 0; index < 6; index++) {
      if (index < u_raft_count) field += raftRipple(uv, u_raft_points[index], time);
    }
    return field;
  }

  float raftWaveRing(vec2 uv, vec3 raft, float time) {
    vec2 delta = (uv - raft.xy) * u_resolution;
    float radius = length(delta / vec2(1.0, 1.28));
    float ringRadius = 18.0 + mod(time * 32.0 + raft.z * 30.0, 138.0);
    float ringWidth = 2.0 + ringRadius * 0.024;
    float ring = exp(-pow(abs(radius - ringRadius) / ringWidth, 2.0));
    return ring * exp(-ringRadius * 0.008) * raft.z;
  }

  float raftWaveRingField(vec2 uv, float time) {
    float field = 0.0;
    for (int index = 0; index < 6; index++) {
      if (index < u_raft_count) field = max(field, raftWaveRing(uv, u_raft_points[index], time));
    }
    return field;
  }

  vec2 flowCoordinates(vec2 uv, float time) {
    vec2 localVelocity = smoothVelocity(uv);
    float center = riverCenter(uv.y, time * 0.7);
    vec2 p = vec2((uv.x - center) * 6.9 + uv.y * 0.8, uv.y * 11.2);
    p += localVelocity * vec2(0.42, -0.32);
    vec2 warp = vec2(
      fbm(p * 0.42 + vec2(-time * 0.08, time * 0.04)),
      fbm(p * 0.42 + vec2(5.3 + time * 0.06, 2.1 - time * 0.05))
    ) - 0.5;
    vec2 microWarp = vec2(
      fbm(p * 0.38 + vec2(time * 0.13, -time * 0.09)),
      fbm(p * 0.38 + vec2(4.2 - time * 0.1, 1.8 + time * 0.07))
    ) - 0.5;
    return p + warp * vec2(1.75, 0.94) + microWarp * vec2(0.52, 0.28);
  }

  float surfaceHeight(vec2 uv, float time) {
    vec2 p = flowCoordinates(uv, time);
    vec2 flow = smoothVelocity(uv);
    float flowLift = dot(flow, vec2(1.2, -0.8));
    float broad = sin(p.x * 1.35 + p.y * 0.46 - time * 1.15 + sin(p.y * 0.74 - time * 0.5) * 0.72 + flowLift * 0.9);
    float middle = sin(p.x * 3.6 - p.y * 0.83 - time * 1.8 + sin(p.y * 1.2 + p.x * 0.7) * 0.45 + flowLift * 0.55);
    float raftDisplacement = raftRippleField(uv, time);
    return broad * 0.028 + middle * 0.008 + raftDisplacement * 0.008;
  }

  float caustic(vec2 uv, float time) {
    vec2 p = flowCoordinates(uv, time);
    float broadWave = 0.5 + 0.5 * sin(p.x * 1.75 + p.y * 0.62 - time * 1.2);
    float broken = 0.68 + 0.32 * fbm(p * 0.28 + vec2(-time * 0.08, time * 0.05));
    float broad = smoothstep(0.62, 0.95, broadWave) * broken;
    return clamp(broad * 0.76, 0.0, 1.0);
  }

  float waterRibbons(vec2 uv, float time) {
    vec2 p = flowCoordinates(uv, time);
    float center = riverCenter(uv.y, time * 0.7);
    float across = (uv.x - center) * u_resolution.x;
    float along = uv.y * u_resolution.y;
    vec2 flow = smoothVelocity(uv);
    float current = dot(flow, vec2(0.8, -0.5));
    float broadWave = 0.5 + 0.5 * sin(p.x * 1.15 + p.y * 0.58 - time * 0.9 + current * 1.8);
    float middleWave = 0.5 + 0.5 * sin(p.x * 2.2 - p.y * 0.64 - time * 1.45 + sin(p.y * 0.7) * 0.65);
    float broken = 0.62 + 0.38 * fbm(p * 0.34 + vec2(time * 0.05, -time * 0.06));
    float broad = smoothstep(0.56, 0.94, broadWave) * broken;
    float middle = smoothstep(0.66, 0.96, middleWave) * (0.5 + 0.5 * broken);
    float bend = sin(across * 0.018 + time * 0.22) * 4.2 + sin(across * 0.043 - time * 0.35) * 1.5;
    float longWave = 0.5 + 0.5 * sin(along * 0.034 - time * 1.05 + bend + current * 2.0);
    float softWave = smoothstep(0.58, 0.9, longWave) * (0.68 + 0.32 * broken);
    return clamp(broad * 0.48 + middle * 0.2 + softWave * 0.52, 0.0, 1.0);
  }

  float raftFoam(vec2 uv, vec3 raft, float time) {
    vec2 delta = (uv - raft.xy) * u_resolution;
    float bow = exp(-length(delta / vec2(15.0, 9.0))) * 0.7;
    float hullRadius = length(delta / vec2(36.0, 50.0));
    float hullRipple = exp(-pow(abs(hullRadius - 1.0) * 5.0, 2.0)) * 0.34;
    float downstream = max(-delta.y, 0.0);
    float spread = 10.0 + downstream * 0.14;
    float wakeAxis = abs(delta.x + sin(downstream * 0.05 + time * 1.15) * 3.0);
    float wake = (1.0 - smoothstep(0.0, spread, wakeAxis)) * exp(-downstream * 0.014);
    float wakeWave = 0.45 + 0.55 * sin(downstream * 0.18 - time * 1.75 + sin(delta.x * 0.04) * 0.8);
    return clamp((bow + hullRipple + wake * wakeWave * 0.72) * raft.z, 0.0, 1.0);
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
    float time = u_time * 0.18;
    float current = riverCenter(uv.y, time * 0.7);
    float width = 0.46 + sin(uv.y * 3.2 - time * 0.18) * 0.012;
    float distance_to_current = abs(uv.x - current);
    float water = 1.0 - smoothstep(width - 0.2, width, distance_to_current);
    float edge = smoothstep(0.0, 0.1, water);

    vec2 texel = 1.0 / u_resolution;
    float height = surfaceHeight(uv, time);
    float height_x = surfaceHeight(uv + vec2(texel.x, 0.0), time);
    float height_y = surfaceHeight(uv + vec2(0.0, texel.y), time);
    vec3 normal = normalize(vec3((height - height_x) * 22.0, (height - height_y) * 22.0, 1.0));
    vec3 light_direction = normalize(vec3(-0.35, 0.88, 1.4));
    float diffuse = 0.55 + 0.45 * max(dot(normal, light_direction), 0.0);
    float specular = pow(max(dot(reflect(-light_direction, normal), vec3(0.0, 0.0, 1.0)), 0.0), 12.0) * 0.78;
    float ripple = raftRippleField(uv, time);
    float waveRing = raftWaveRingField(uv, time);
    float foam = raftFoamField(uv, time);
    float ribbons = waterRibbons(uv, time);
    float depthTone = fbm(flowCoordinates(uv, time) * 0.45 + vec2(time * 0.025, -time * 0.018));
    float grain = depthTone;
    float sunwash = smoothstep(0.26, 0.76, depthTone);
    float causticLight = caustic(uv + vec2(ripple * 0.018, ripple * 0.008), time);
    float crest = smoothstep(0.018, 0.05, height) * smoothstep(0.25, 0.72, grain);
    float shallow_edge = (1.0 - smoothstep(0.0, 0.18, water)) * edge;
    float depth = smoothstep(0.04, 0.44, water) * (1.0 - smoothstep(0.5, 0.9, water));

    vec3 shallow = vec3(0.055, 0.52, 0.56);
    vec3 deep = vec3(0.008, 0.17, 0.22);
    vec2 plateUv = clamp(vec2(0.12 + uv.x * 0.76 + height * 1.8 + ripple * 0.01, 0.06 + uv.y * 0.86 + height_y * 0.2), 0.02, 0.98);
    vec3 plateTone = textureLod(u_water_texture, plateUv, 4.0).rgb;
    vec3 naturalWater = mix(deep, shallow, 0.16 + depthTone * 0.3 + diffuse * 0.08);
    vec3 color = mix(naturalWater, plateTone * vec3(0.58, 0.78, 0.8), 0.1);
    color += vec3(0.012, 0.05, 0.055) * grain * edge;
    color += vec3(0.025, 0.11, 0.12) * diffuse * edge;
    color += vec3(0.08, 0.23, 0.23) * causticLight * (0.21 + sunwash * 0.16) * edge;
    color += vec3(0.14, 0.36, 0.32) * ribbons * (0.34 + sunwash * 0.18) * edge;
    color += vec3(0.36, 0.76, 0.64) * specular * (0.32 + sunwash * 0.22) * edge;
    color += vec3(0.35, 0.72, 0.6) * crest * 0.18 * edge;
    color += vec3(0.5, 0.92, 0.74) * waveRing * 0.86 * edge;
    color += vec3(0.38, 0.82, 0.67) * smoothstep(0.7, 0.98, causticLight) * 0.32 * edge;
    color += vec3(0.68, 0.96, 0.8) * foam * 0.6 * edge;
    color *= 0.9;
    color += vec3(0.43, 0.76, 0.67) * shallow_edge * 0.19;
    color += vec3(0.018, 0.11, 0.14) * depth;
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
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return { setRafts: () => undefined, cleanup: () => undefined };

  const splatProgram = createProgram(gl, splatSource);
  const curlProgram = createProgram(gl, curlSource);
  const vorticityProgram = createProgram(gl, vorticitySource);
  const divergenceProgram = createProgram(gl, divergenceSource);
  const pressureProgram = createProgram(gl, pressureSource);
  const gradientProgram = createProgram(gl, gradientSource);
  const advectionProgram = createProgram(gl, advectionSource);
  const displayProgram = createProgram(gl, displaySource);
  const programs = [splatProgram, curlProgram, vorticityProgram, divergenceProgram, pressureProgram, gradientProgram, advectionProgram, displayProgram];
  if (programs.some((program) => !program)) return { setRafts: () => undefined, cleanup: () => undefined };

  const uniforms = {
    splat: getUniforms(gl, splatProgram!, ["u_target", "u_aspect_ratio", "u_point", "u_amount", "u_radius"]),
    curl: getUniforms(gl, curlProgram!, ["u_velocity", "u_texel_size"]),
    vorticity: getUniforms(gl, vorticityProgram!, ["u_velocity", "u_curl", "u_texel_size", "u_curl_strength", "u_dt"]),
    divergence: getUniforms(gl, divergenceProgram!, ["u_velocity", "u_texel_size"]),
    pressure: getUniforms(gl, pressureProgram!, ["u_pressure", "u_divergence", "u_texel_size"]),
    gradient: getUniforms(gl, gradientProgram!, ["u_pressure", "u_velocity", "u_texel_size"]),
    advection: getUniforms(gl, advectionProgram!, ["u_velocity", "u_source", "u_texel_size", "u_dt", "u_dissipation"]),
    display: getUniforms(gl, displayProgram!, ["u_velocity", "u_velocity_texel_size", "u_water_texture", "u_time", "u_resolution", "u_raft_points[0]", "u_raft_count"]),
  };

  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) return { setRafts: () => undefined, cleanup: () => undefined };

  const waterTexture = gl.createTexture();
  if (!waterTexture) return { setRafts: () => undefined, cleanup: () => undefined };
  gl.bindTexture(gl.TEXTURE_2D, waterTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([37, 137, 143, 255]));
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const waterImage = new Image();
  waterImage.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, waterTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, waterImage);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
  waterImage.src = "/assets/stream-water.png";

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
  let simWidth = 0;
  let simHeight = 0;
  const raftData = new Float32Array(18);
  let raftCount = 0;
  let raftImpulseQueue: FluidRaft[] = [];
  let raftSnapshot = "";
  const setRafts = (rafts: FluidRaft[]) => {
    const nextRafts = rafts.slice(0, 6).map((raft) => ({ ...raft }));
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
    if (divergence) destroyTarget(gl, divergence);
    if (curl) destroyTarget(gl, curl);
    velocity = null;
    pressure = null;
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
    if (!nextVelocity || !nextPressure || !nextDivergence || !nextCurl) return;
    velocity = nextVelocity;
    pressure = nextPressure;
    divergence = nextDivergence;
    curl = nextCurl;
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

  const emitRaftImpulses = () => {
    if (!raftImpulseQueue.length) return;
    const rafts = raftImpulseQueue;
    raftImpulseQueue = [];
    rafts.forEach((raft) => {
      const force = 0.018 + raft.strength * 0.012;
      splat(raft.x, raft.y, 0.0, -force, 0.006);
      splat(raft.x - 0.02, raft.y + 0.006, force * 0.34, -force * 0.42, 0.004);
      splat(raft.x + 0.02, raft.y + 0.006, -force * 0.34, -force * 0.42, 0.004);
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
  };

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    initializeTargets();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  for (let index = 0; index < 10; index += 1) {
    splat(0.5 + Math.sin(index * 2.3) * 0.06, 0.12 + index * 0.085, Math.sin(index * 1.7) * 0.04, -0.12, 0.009);
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
        splat(0.5 + Math.sin(phase * 1.7) * 0.055, 0.97, Math.sin(phase) * 0.045, -0.18, 0.008);
        lastImpulse = now;
      }
      emitRaftImpulses();
      step(dt);
      draw(displayProgram!, null, () => {
        bindTexture(velocity!.read.texture, 0, uniforms.display.u_velocity);
        bindTexture(waterTexture, 1, uniforms.display.u_water_texture);
        gl.uniform2f(uniforms.display.u_velocity_texel_size, velocity!.read.texelX, velocity!.read.texelY);
        gl.uniform1f(uniforms.display.u_time, now / 1000);
        gl.uniform2f(uniforms.display.u_resolution, canvas.width, canvas.height);
        gl.uniform3fv(uniforms.display.u_raft_points, raftData);
        gl.uniform1i(uniforms.display.u_raft_count, raftCount);
      });
    }
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);

  return {
    setRafts,
    cleanup: () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      destroyTargets();
      programs.forEach((program) => { if (program) gl.deleteProgram(program); });
      gl.deleteTexture(waterTexture);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
    },
  };
}
