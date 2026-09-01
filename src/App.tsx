import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type Modality = "text" | "image" | "file";

type ClipCard = {
  id: string;
  kind: Modality;
  preview: string;
  detail: string;
  copiedAt: string;
  useCount: number;
  pinned: boolean;
};

const sampleCards: ClipCard[] = [
  { id: "visual-draft", kind: "text", preview: "视觉稿先行", detail: "文本 · 12 字符", copiedAt: "10:21", useCount: 2, pinned: true },
  { id: "lake-image", kind: "image", preview: "PNG · 1920×1080", detail: "图片 · 2.4 MB", copiedAt: "10:20", useCount: 1, pinned: false },
  { id: "reference-zip", kind: "file", preview: "参考.zip", detail: "ZIP · 24.8 MB", copiedAt: "10:18", useCount: 1, pinned: false },
];

const iconPaths: Record<string, string> = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm6-2 4 4",
  pin: "m12 3 3 3-2 2 4 4-3 3 1 5-3-3-3 3 1-5-3-3 4-4-2-2 3-3Z",
  settings: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm0-12v2m0 13.6v2M3.5 7l1.7 1m13.6 8 1.7 1M3.5 17l1.7-1m13.6-8 1.7-1M2 12h2m16 0h2",
  text: "M5 5h14M8 9h8M7 13h10M5 17h14",
  image: "M4 5h16v14H4zM7 15l3-3 2 2 2-3 3 4M8 9h.01",
  file: "M7 3h7l4 4v14H7zM14 3v5h5M10 12h5M10 16h5",
  restore: "M4 12a8 8 0 1 0 2.34-5.66L4 8.7M4 4v4.7h4.7",
  close: "M6 6l12 12M18 6 6 18",
};

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={iconPaths[name]} />
    </svg>
  );
}

function FlowBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
    if (!canvas || !gl) return;

    const vertexSource = `#version 300 es
      in vec2 a_position;
      void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
    `;
    const fragmentSource = `#version 300 es
      precision highp float;
      uniform vec2 u_resolution;
      uniform float u_time;
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
          p = p * 2.02 + vec2(9.1, 3.7);
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        float time = u_time * 0.09;
        float current = 0.5 + sin(uv.y * 7.0 + sin(time + uv.y * 1.8) * 0.55) * 0.052 + sin(uv.y * 17.0 - time * 1.4) * 0.009;
        float width = 0.39 + sin(uv.y * 3.7 - time * 0.24) * 0.016;
        float distance_to_current = abs(uv.x - current);
        float water = 1.0 - smoothstep(width - 0.22, width, distance_to_current);
        float edge = smoothstep(0.0, 0.16, water);
        vec2 river = vec2((uv.x - current) * 13.0, uv.y * 24.0 - time * 4.6);
        vec2 warp = vec2(
          fbm(river * 0.16 + vec2(time * 0.15, 3.0)),
          fbm(river * 0.16 + vec2(-4.0, -time * 0.11))
        );
        vec2 flowing = river + (warp - 0.5) * vec2(3.2, 2.4);
        float wave_a = sin(dot(flowing, vec2(1.08, 0.72)) + sin(flowing.y * 0.62 + time) * 0.58 + fbm(flowing * 0.16) * 2.1);
        float wave_b = sin(dot(flowing, vec2(-0.88, 1.0)) - cos(flowing.x * 0.8 - time * 0.7) * 0.7 + fbm(flowing * 0.11) * 2.3);
        float caustic_field = 1.0 - abs(wave_a * wave_b);
        float breakup = fbm(flowing * 0.32 + vec2(-time * 0.08, time * 0.12));
        float broken_light = smoothstep(0.935, 0.995, caustic_field + (breakup - 0.5) * 0.12) * edge;
        float soft_light = smoothstep(0.82, 0.98, caustic_field) * smoothstep(0.28, 0.68, breakup) * edge;
        float glint_field = 1.0 - abs(sin(flowing.x * 2.1 + fbm(flowing * 0.22) * 2.0) * sin(flowing.y * 1.8 - time));
        float glints = pow(max(glint_field - 0.82, 0.0) * 5.5, 8.0) * edge;
        float edge_foam = (1.0 - smoothstep(0.0, 0.18, water)) * edge;
        float depth = smoothstep(0.05, 0.42, water) * (1.0 - smoothstep(0.45, 0.9, water));
        float grain = fbm(flowing * 0.28 + vec2(2.0, -time * 0.3));
        vec3 shallow = vec3(0.095, 0.44, 0.46);
        vec3 deep = vec3(0.014, 0.20, 0.25);
        vec3 color = mix(shallow, deep, smoothstep(0.05, 0.95, uv.y) * 0.4 + depth * 0.3);
        color += vec3(0.025, 0.09, 0.095) * grain * edge;
        color += vec3(0.38, 0.72, 0.68) * soft_light * 0.07;
        color += vec3(0.71, 0.91, 0.77) * broken_light * 0.42;
        color += vec3(0.89, 0.98, 0.84) * glints * 0.18;
        color += vec3(0.48, 0.77, 0.67) * edge_foam * 0.2;
        color += vec3(0.03, 0.12, 0.14) * depth;
        out_color = vec4(color, edge * 0.96);
      }
    `;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const time = gl.getUniformLocation(program, "u_time");
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();
    gl.useProgram(program);
    gl.enableVertexAttribArray(position);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0);
    const startedAt = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, (now - startedAt) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, []);

  return <canvas ref={canvasRef} className="flow-backdrop" aria-hidden="true" />;
}

function readTime(value: string) {
  if (/^\d+$/.test(value)) return new Date(Number(value) * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return value;
}

function useRaftMotion(cards: ClipCard[], refs: MutableRefObject<Map<string, HTMLDivElement>>) {
  const previous = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    cards.forEach((card, index) => {
      const element = refs.current.get(card.id);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const oldRect = previous.current.get(card.id);
      next.set(card.id, rect);
      if (!oldRect || reduced) return;

      const deltaX = oldRect.left - rect.left;
      const deltaY = oldRect.top - rect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

      element.animate(
        [{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: Math.min(560, 420 + index * 18), delay: Math.min(index * 30, 120), easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" },
      );
    });

    previous.current = next;
  }, [cards, refs]);
}

function RaftCard({ card, index, removing, onDelete, onRestore, setRef }: {
  card: ClipCard;
  index: number;
  removing: boolean;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  setRef: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div className="raft-motion" ref={setRef}>
      <article className={`raft-card raft-${card.kind} raft-tilt-${index % 3} ${removing ? "is-removing" : ""}`}>
        <div className="raft-rope rope-top" />
        <div className="raft-rope rope-bottom" />
        <div className="raft-rails" aria-hidden="true" />
        <div className={`modality-badge badge-${card.kind}`}><Icon name={card.kind} size={12} /></div>
        <button className="raft-content" onDoubleClick={() => onRestore(card.id)} aria-label={`恢复${card.preview}`}>
          {card.kind === "image" && <div className="image-preview"><span className="sun" /><span className="mountain mountain-back" /><span className="mountain mountain-front" /><span className="lake-line" /></div>}
          {card.kind === "file" && <div className="file-preview"><span className="file-tab" /><span className="zip-mark">ZIP</span></div>}
          <div className="paper">
            <strong>{card.preview}</strong>
            <span>{card.detail}</span>
            <small>{readTime(card.copiedAt)}</small>
          </div>
        </button>
        <div className="raft-actions">
          <button onClick={() => onRestore(card.id)} aria-label="恢复内容" title="恢复"><Icon name="restore" size={11} /></button>
          <button onClick={() => onDelete(card.id)} aria-label="删除卡片" title="移除"><Icon name="close" size={11} /></button>
        </div>
      </article>
    </div>
  );
}

function App() {
  const [cards, setCards] = useState<ClipCard[]>(sampleCards);
  const [query, setQuery] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("复制内容会在这里顺流靠岸");
  const [autoPaste, setAutoPaste] = useState(true);
  const refs = useRef(new Map<string, HTMLDivElement>());

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<ClipCard[]>("history_list");
      setCards(next);
    } catch {
      // Browser preview intentionally keeps the visual comp usable without Tauri.
    }
  }, []);

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    void listen<ClipCard>("clipboard://updated", (event) => {
      setCards((current) => [event.payload, ...current.filter((card) => card.id !== event.payload.id)].slice(0, 200));
      setNotice("新木筏已顺流靠岸");
    }).then((cleanup) => { unlisten = cleanup; }).catch(() => undefined);
    return () => unlisten?.();
  }, [refresh]);

  useRaftMotion(cards, refs);

  const visibleCards = cards.filter((card) => `${card.preview} ${card.detail}`.toLowerCase().includes(query.toLowerCase()));

  const deleteCard = async (id: string) => {
    setRemovingId(id);
    window.setTimeout(async () => {
      setCards((current) => current.filter((card) => card.id !== id));
      setRemovingId(null);
      try { await invoke("delete_clip", { id }); } catch { /* browser preview */ }
      setNotice("木筏已离岸，下面的卡片正在向上游补位");
    }, 170);
  };

  const restoreCard = async (id: string) => {
    try { await invoke("restore_clip", { id }); } catch { /* browser preview */ }
    setNotice("内容已复制到系统剪贴板");
  };

  return (
    <main className="app-shell">
      <div className="creek-world" aria-label="ClipRaft 剪贴板面板">
        <FlowBackdrop />
        <div className="water-highlight highlight-one" />
        <div className="water-highlight highlight-two" />
        <div className="bank-stone stone-one" />
        <div className="bank-stone stone-two" />

        <header className="upstream-header">
          <div className="title-stone"><span>ClipRaft</span><small>剪贴流</small></div>
          <label className="search-stone">
            <Icon name="search" size={20} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索剪贴卡片" />
          </label>
        </header>

        <section className="history-stream" aria-live="polite">
          {visibleCards.length ? visibleCards.map((card, index) => (
            <RaftCard key={card.id} card={card} index={index} removing={removingId === card.id} onDelete={deleteCard} onRestore={restoreCard} setRef={(element) => { if (element) refs.current.set(card.id, element); else refs.current.delete(card.id); }} />
          )) : <div className="empty-water">水面很安静<br /><span>复制一点内容，让木筏靠岸</span></div>}
        </section>

        <div className="detached-dock">
          <button aria-label="筛选卡片" onClick={() => setNotice("筛选功能将在下一条纵切片接入")}><Icon name="search" /></button>
          <button aria-label="固定卡片" onClick={() => setNotice("选中木筏后可固定")}><Icon name="pin" /></button>
          <button aria-label="设置" onClick={() => setNotice("设置码头正在准备")}><Icon name="settings" /></button>
        </div>
        <div className="status-strip">
          <span className="status-dot" />
          <span>{notice}</span>
          <button className={`auto-paste ${autoPaste ? "is-on" : ""}`} onClick={() => { setAutoPaste((value) => !value); setNotice("自动粘贴将在下一阶段接入"); }}>{autoPaste ? "自动粘贴" : "仅复制"}</button>
        </div>
      </div>
    </main>
  );
}

export default App;
