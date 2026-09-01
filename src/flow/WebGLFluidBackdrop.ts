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
  uniform float u_time;
  uniform vec2 u_resolution;
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

  void main() {
    vec2 uv = v_uv;
    vec2 velocity = texture(u_velocity, uv).xy;
    float time = u_time * 0.18;
    float current = 0.5 + sin(uv.y * 6.4 + sin(time + uv.y * 1.8) * 0.45) * 0.05 + sin(uv.y * 13.0 - time * 0.9) * 0.009;
    float width = 0.4 + sin(uv.y * 3.2 - time * 0.18) * 0.014;
    float distance_to_current = abs(uv.x - current);
    float water = 1.0 - smoothstep(width - 0.2, width, distance_to_current);
    float edge = smoothstep(0.0, 0.16, water);

    vec2 flow = vec2((uv.x - current) * 12.0, uv.y * 23.0 - time * 2.8);
    flow += velocity * vec2(3.6, -2.2);
    vec2 warp = vec2(fbm(flow * 0.15 + vec2(time * 0.13, 2.0)), fbm(flow * 0.15 + vec2(-3.0, -time * 0.08)));
    vec2 surface = flow + (warp - 0.5) * vec2(3.3, 2.5);

    float strand_a = sin(dot(surface, vec2(1.08, 0.72)) + fbm(surface * 0.15) * 2.2);
    float strand_b = sin(dot(surface, vec2(-0.86, 1.0)) + fbm(surface * 0.11 + 4.0) * 2.3);
    float cell_field = 1.0 - abs(strand_a * strand_b);
    float breakup = fbm(surface * 0.31 + vec2(-time * 0.05, time * 0.08));
    float caustic = smoothstep(0.935, 0.995, cell_field + (breakup - 0.5) * 0.13) * edge;
    float soft_caustic = smoothstep(0.84, 0.975, cell_field) * smoothstep(0.26, 0.7, breakup) * edge;
    float sparkle_field = 1.0 - abs(sin(surface.x * 2.2 + fbm(surface * 0.22) * 2.0) * sin(surface.y * 1.9 - time));
    float sparkles = pow(max(sparkle_field - 0.84, 0.0) * 6.0, 8.0) * edge;
    float shallow_edge = (1.0 - smoothstep(0.0, 0.18, water)) * edge;
    float depth = smoothstep(0.04, 0.44, water) * (1.0 - smoothstep(0.5, 0.9, water));
    float grain = fbm(surface * 0.28 + vec2(1.0, -time * 0.2));

    vec3 shallow = vec3(0.075, 0.38, 0.41);
    vec3 deep = vec3(0.012, 0.16, 0.21);
    vec3 color = mix(shallow, deep, smoothstep(0.04, 0.95, uv.y) * 0.38 + depth * 0.28);
    color += vec3(0.02, 0.08, 0.085) * grain * edge;
    color += vec3(0.25, 0.56, 0.54) * soft_caustic * 0.09;
    color += vec3(0.62, 0.86, 0.74) * caustic * 0.4;
    color += vec3(0.9, 0.98, 0.84) * sparkles * 0.2;
    color += vec3(0.44, 0.7, 0.62) * shallow_edge * 0.18;
    color += vec3(0.02, 0.1, 0.12) * depth;
    out_color = vec4(color, edge * 0.96);
  }
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
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

export function mountFluidSurface(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return () => undefined;

  const splatProgram = createProgram(gl, splatSource);
  const curlProgram = createProgram(gl, curlSource);
  const vorticityProgram = createProgram(gl, vorticitySource);
  const divergenceProgram = createProgram(gl, divergenceSource);
  const pressureProgram = createProgram(gl, pressureSource);
  const gradientProgram = createProgram(gl, gradientSource);
  const advectionProgram = createProgram(gl, advectionSource);
  const displayProgram = createProgram(gl, displaySource);
  const programs = [splatProgram, curlProgram, vorticityProgram, divergenceProgram, pressureProgram, gradientProgram, advectionProgram, displayProgram];
  if (programs.some((program) => !program)) return () => undefined;

  const uniforms = {
    splat: getUniforms(gl, splatProgram!, ["u_target", "u_aspect_ratio", "u_point", "u_amount", "u_radius"]),
    curl: getUniforms(gl, curlProgram!, ["u_velocity", "u_texel_size"]),
    vorticity: getUniforms(gl, vorticityProgram!, ["u_velocity", "u_curl", "u_texel_size", "u_curl_strength", "u_dt"]),
    divergence: getUniforms(gl, divergenceProgram!, ["u_velocity", "u_texel_size"]),
    pressure: getUniforms(gl, pressureProgram!, ["u_pressure", "u_divergence", "u_texel_size"]),
    gradient: getUniforms(gl, gradientProgram!, ["u_pressure", "u_velocity", "u_texel_size"]),
    advection: getUniforms(gl, advectionProgram!, ["u_velocity", "u_source", "u_texel_size", "u_dt", "u_dissipation"]),
    display: getUniforms(gl, displayProgram!, ["u_velocity", "u_time", "u_resolution"]),
  };

  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) return () => undefined;
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
        gl.uniform1f(uniforms.display.u_time, now / 1000);
        gl.uniform2f(uniforms.display.u_resolution, canvas.width, canvas.height);
      });
    }
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    destroyTargets();
    programs.forEach((program) => { if (program) gl.deleteProgram(program); });
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
  };
}
