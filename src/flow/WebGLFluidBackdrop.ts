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

  float riverCenter(float y, float time) {
    return 0.5 + sin(y * 6.4 + sin(time + y * 1.8) * 0.45) * 0.05 + sin(y * 13.0 - time * 0.9) * 0.009;
  }

  float raftRipple(vec2 uv, vec3 raft, float time) {
    vec2 delta = (uv - raft.xy) * u_resolution;
    delta.x *= 1.08;
    float radius = length(delta / vec2(1.0, 1.28));
    float ringEnvelope = exp(-radius * 0.035) * raft.z;
    float ring = sin(radius * 0.19 - time * 3.0 + raft.z * 4.0) * ringEnvelope;

    // The current runs down the panel. A narrow, asymmetric wake makes the
    // raft feel like it is displacing water instead of sitting on a texture.
    float downstream = max(-delta.y, 0.0);
    float wakeAxis = delta.x + sin(downstream * 0.08 + time * 1.2) * 3.0;
    float wake = exp(-abs(wakeAxis) * 0.085) * exp(-downstream * 0.023);
    float wakeWave = sin(downstream * 0.34 - time * 2.4) * wake;
    float bow = exp(-length(delta / vec2(8.0, 6.0))) * 0.7;
    return ring * 0.32 + wakeWave * 0.68 + bow;
  }

  float raftRippleField(vec2 uv, float time) {
    float field = 0.0;
    for (int index = 0; index < 6; index++) {
      if (index < u_raft_count) field += raftRipple(uv, u_raft_points[index], time);
    }
    return field;
  }

  vec2 flowCoordinates(vec2 uv, float time) {
    vec2 localVelocity = texture(u_velocity, clamp(uv, 0.001, 0.999)).xy;
    float center = riverCenter(uv.y, time * 0.7);
    vec2 p = vec2((uv.x - center) * 8.2 + uv.y * 1.35, uv.y * 9.4);
    p += localVelocity * vec2(1.8, -1.4);
    vec2 warp = vec2(
      fbm(p * 0.42 + vec2(-time * 0.08, time * 0.04)),
      fbm(p * 0.42 + vec2(5.3 + time * 0.06, 2.1 - time * 0.05))
    ) - 0.5;
    return p + warp * vec2(2.6, 1.7);
  }

  float surfaceHeight(vec2 uv, float time) {
    vec2 p = flowCoordinates(uv, time);
    float broad = fbm(p * 0.68 + vec2(0.0, -time * 0.25));
    float middle = fbm(p * 1.45 + vec2(0.0, -time * 0.52));
    float fine = fbm(p * 3.4 + vec2(0.0, -time * 0.92));
    float raftDisplacement = raftRippleField(uv, time);
    return (broad - 0.5) * 0.06 + (middle - 0.5) * 0.024 + (fine - 0.5) * 0.007 + raftDisplacement * 0.021;
  }

  float caustic(vec2 uv, float time) {
    vec2 p = flowCoordinates(uv, time);
    float broad = fbm(p * vec2(0.72, 1.18) + vec2(-time * 0.07, -time * 0.32));
    float broken = fbm(p * vec2(1.45, 2.35) + vec2(3.1 + time * 0.04, -time * 0.62));
    float fine = noise(p * 4.2 + vec2(-2.3, -time * 1.06));
    float broadRidge = 1.0 - abs(broad * 2.0 - 1.0);
    float brokenRidge = 1.0 - abs(broken * 2.0 - 1.0);
    float filament = smoothstep(0.58, 0.94, broadRidge * (0.72 + brokenRidge * 0.5));
    float sparkle = pow(max(broadRidge * brokenRidge * (0.55 + fine * 0.65), 0.0), 3.5);
    return clamp(filament * 0.72 + sparkle * 0.46, 0.0, 1.0);
  }

  float raftFoam(vec2 uv, vec3 raft, float time) {
    vec2 delta = (uv - raft.xy) * u_resolution;
    float bow = exp(-length(delta / vec2(9.0, 6.0))) * 0.78;
    float hullRadius = length(delta / vec2(36.0, 50.0));
    float hullRipple = exp(-abs(hullRadius - 1.0) * 9.0) * 0.34;
    float downstream = max(-delta.y, 0.0);
    float wakeAxis = delta.x + sin(downstream * 0.08 + time * 1.2) * 3.0;
    float wake = exp(-abs(wakeAxis) * 0.11) * exp(-downstream * 0.028);
    float breakup = 0.55 + 0.45 * noise(delta * 0.045 + vec2(time * 0.08, -time * 0.12));
    return clamp((bow + hullRipple + wake * breakup * 0.42) * raft.z, 0.0, 1.0);
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
    float time = u_time * 0.22;
    float current = riverCenter(uv.y, time * 0.7);
    float width = 0.46 + sin(uv.y * 3.2 - time * 0.18) * 0.012;
    float distance_to_current = abs(uv.x - current);
    float water = 1.0 - smoothstep(width - 0.2, width, distance_to_current);
    float edge = smoothstep(0.0, 0.1, water);

    vec2 texel = 1.0 / u_resolution;
    float height = surfaceHeight(uv, time);
    float height_x = surfaceHeight(uv + vec2(texel.x, 0.0), time);
    float height_y = surfaceHeight(uv + vec2(0.0, texel.y), time);
    vec3 normal = normalize(vec3((height - height_x) * 42.0, (height - height_y) * 42.0, 1.0));
    vec3 light_direction = normalize(vec3(-0.45, 0.82, 1.2));
    float diffuse = 0.55 + 0.45 * max(dot(normal, light_direction), 0.0);
    float specular = pow(max(dot(reflect(-light_direction, normal), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
    float ripple = raftRippleField(uv, time);
    float foam = raftFoamField(uv, time);
    vec2 localVelocity = texture(u_velocity, clamp(uv, 0.001, 0.999)).xy;
    float fluidSpeed = length(localVelocity);
    float grain = fbm(vec2(uv.x * 3.2 + time * 0.03, uv.y * 4.8 - time * 0.12));
    float sunwash = smoothstep(0.28, 0.84, fbm(vec2(uv.x * 1.05 + time * 0.035, uv.y * 1.35 - time * 0.06)));
    float causticLight = caustic(uv + vec2(ripple * 0.018, ripple * 0.008), time);
    float crest = smoothstep(0.018, 0.05, height) * smoothstep(0.25, 0.72, grain);
    float shallow_edge = (1.0 - smoothstep(0.0, 0.18, water)) * edge;
    float depth = smoothstep(0.04, 0.44, water) * (1.0 - smoothstep(0.5, 0.9, water));

    vec3 shallow = vec3(0.055, 0.48, 0.52);
    vec3 deep = vec3(0.008, 0.16, 0.21);
    vec2 plateUv = vec2(
      clamp(0.08 + uv.x * 0.84 + height * 3.5 + ripple * 0.014 + localVelocity.x * 0.18, 0.02, 0.98),
      clamp(0.06 + uv.y * 0.88 + grain * 0.025, 0.02, 0.98)
    );
    vec2 plateUv2 = vec2(
      clamp(0.12 + uv.x * 0.76 - height_y * 2.8 + localVelocity.x * 0.12, 0.03, 0.97),
      clamp(0.08 + uv.y * 0.84 - height * 0.12, 0.03, 0.97)
    );
    vec3 plate = (
      texture(u_water_texture, plateUv + vec2(-0.018, 0.0)).rgb
      + texture(u_water_texture, plateUv).rgb
      + texture(u_water_texture, plateUv + vec2(0.018, 0.0)).rgb
      + texture(u_water_texture, plateUv2 + vec2(0.0, -0.025)).rgb
      + texture(u_water_texture, plateUv2 + vec2(0.0, 0.025)).rgb
    ) * 0.2;
    plate = mix(vec3(0.018, 0.16, 0.18), plate, 0.64);
    plate = pow(plate, vec3(1.08));
    vec3 naturalWater = mix(deep, shallow, 0.28 + sunwash * 0.38 + diffuse * 0.12);
    vec3 color = mix(naturalWater, plate * vec3(0.58, 0.78, 0.8), 0.18);
    color += vec3(0.025, 0.095, 0.095) * grain * edge;
    color += vec3(0.09, 0.31, 0.32) * diffuse * edge;
    color += vec3(0.2, 0.5, 0.5) * causticLight * (0.28 + sunwash * 0.34) * edge;
    color += vec3(0.62, 0.94, 0.82) * specular * (0.3 + sunwash * 0.3) * edge;
    color += vec3(0.5, 0.82, 0.7) * crest * 0.18 * edge;
    color += vec3(0.44, 0.85, 0.74) * abs(ripple) * (0.1 + fluidSpeed * 0.16) * edge;
    color += vec3(0.48, 0.9, 0.78) * smoothstep(0.64, 0.95, causticLight) * 0.28 * edge;
    color += vec3(0.72, 0.98, 0.87) * foam * 0.68 * edge;
    color *= 0.82;
    color += vec3(0.43, 0.76, 0.67) * shallow_edge * 0.19;
    color += vec3(0.018, 0.11, 0.14) * depth;
    out_color = vec4(color, edge * 0.96);
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
    display: getUniforms(gl, displayProgram!, ["u_velocity", "u_water_texture", "u_time", "u_resolution", "u_raft_points[0]", "u_raft_count"]),
  };

  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) return { setRafts: () => undefined, cleanup: () => undefined };

  const waterTexture = gl.createTexture();
  if (!waterTexture) return { setRafts: () => undefined, cleanup: () => undefined };
  gl.bindTexture(gl.TEXTURE_2D, waterTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([37, 137, 143, 255]));
  gl.bindTexture(gl.TEXTURE_2D, null);
  const waterImage = new Image();
  waterImage.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, waterTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, waterImage);
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
  const setRafts = (rafts: FluidRaft[]) => {
    raftCount = Math.min(rafts.length, 6);
    raftData.fill(-2);
    rafts.slice(0, 6).forEach((raft, index) => {
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
    const width = 64;
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
      step(dt);
      draw(displayProgram!, null, () => {
        bindTexture(velocity!.read.texture, 0, uniforms.display.u_velocity);
        bindTexture(waterTexture, 1, uniforms.display.u_water_texture);
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
