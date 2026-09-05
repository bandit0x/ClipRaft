import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { mountFluidSurface, type FluidRaft } from "./flow/WebGLFluidBackdrop";

// 惰性判定：模块加载瞬间 __TAURI_INTERNALS__ 可能尚未注入（时序竞态），
// 挂载后由 effect 校正一次。
function isTauriEnv() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// macOS 拖出走原生 NSDraggingSession，F9 走恢复+粘贴而非拖拽会话
const isMacPlatform = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

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

const iconPaths: Record<string, string> = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm6-2 4 4",
  pin: "m12 3 3 3-2 2 4 4-3 3 1 5-3-3-3 3 1-5-3-3 4-4-2-2 3-3Z",
  settings: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm0-12v2m0 13.6v2M3.5 7l1.7 1m13.6 8 1.7 1M3.5 17l1.7-1m13.6-8 1.7-1M2 12h2m16 0h2",
  text: "M5 5h14M8 9h8M7 13h10M5 17h14",
  image: "M4 5h16v14H4zM7 15l3-3 2 2 2-3 3 4M8 9h.01",
  file: "M7 3h7l4 4v14H7zM14 3v5h5M10 12h5M10 16h5",
  restore: "M4 12a8 8 0 1 0 2.34-5.66L4 8.7M4 4v4.7h4.7",
  close: "M6 6l12 12M18 6 6 18",
  trash: "M5 7h14m-9 0v10m4-10v10M9 4h6l1 3H8l1-3Zm-4 3 1 14h12l1-14",
};

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={iconPaths[name]} />
    </svg>
  );
}

function FlowBackdrop({ rafts }: { rafts: FluidRaft[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<ReturnType<typeof mountFluidSurface> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = mountFluidSurface(canvas);
    controllerRef.current = controller;
    if (!controller.active) console.warn("[ClipRaft] 流体画布未激活，回退到静态水材质");
    return () => {
      controller.cleanup();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setRafts(rafts);
  }, [rafts]);

  return <canvas ref={canvasRef} className="flow-backdrop" aria-hidden="true" />;
}

const browserPreviewCards: ClipCard[] = [
  { id: "preview-text-1", kind: "text", preview: "视觉瓶先行", detail: "文本 · 12 字", copiedAt: "10:21", useCount: 3, pinned: false },
  { id: "preview-image-1", kind: "image", preview: "湖畔远足.png", detail: "PNG · 1920×1080", copiedAt: "10:22", useCount: 1, pinned: true },
  { id: "preview-file-1", kind: "file", preview: "考古.zip", detail: "ZIP · 34.4 MB", copiedAt: "10:24", useCount: 0, pinned: false },
  { id: "preview-text-2", kind: "text", preview: "会议纪要：下游排期对齐", detail: "文本 · 236 字", copiedAt: "09:58", useCount: 2, pinned: false },
];

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

function RaftCard({ card, imageSrc, index, removing, selected, isTauri, onNativeDrag, onSelect, onDelete, onRestore, onTogglePin, onDragStart, onDragEnd, setRef }: {
  card: ClipCard;
  imageSrc?: string;
  index: number;
  removing: boolean;
  selected: boolean;
  isTauri: boolean;
  onNativeDrag: (card: ClipCard, origin: { x: number; y: number }) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDragStart: (event: DragEvent<HTMLElement>, card: ClipCard, imageSrc?: string) => void;
  onDragEnd: () => void;
  setRef: (element: HTMLDivElement | null) => void;
}) {
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    dragOriginRef.current = { x: event.clientX, y: event.clientY };
    // 捕获指针：光标移出木筏后 pointermove 仍回传本元素，否则拖动阈值无法跨过
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 某些指针类型不支持捕获，忽略 */
    }
    const badge = event.currentTarget.ownerDocument.querySelector(".status-strip > span:nth-child(2)");
    if (badge) badge.textContent = "①已按下木筏";
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    const badge = event.currentTarget.ownerDocument.querySelector(".status-strip > span:nth-child(2)");
    if (badge) badge.textContent = "②拖动中 " + Math.round(Math.hypot(event.clientX - origin.x, event.clientY - origin.y)) + "px";
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) {
      dragOriginRef.current = null;
      onNativeDrag(card, origin);
    }
  };
  return (
    <div className="raft-motion" ref={setRef}>
      <article
        className={`raft-card raft-${card.kind} raft-tilt-${index % 3} ${selected ? "is-selected" : ""} ${card.pinned ? "is-pinned" : ""} ${removing ? "is-removing" : ""}`}
        tabIndex={0}
        aria-selected={selected}
        draggable={!removing && !isTauri}
        onClick={(event) => { if (!(event.target as HTMLElement).closest("button")) onSelect(card.id); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onRestore(card.id); } }}
        onPointerDown={isTauri ? onPointerDown : undefined}
        onPointerMove={isTauri ? onPointerMove : undefined}
        onPointerUp={() => { dragOriginRef.current = null; }}
        onPointerCancel={() => { dragOriginRef.current = null; }}
        onDragStart={(event) => onDragStart(event, card, imageSrc)}
        onDragEnd={onDragEnd}
      >
        <div className="raft-rope rope-top" />
        <div className="raft-rope rope-bottom" />
        <div className="raft-rails" aria-hidden="true" />
        <div className={`modality-badge badge-${card.kind}`}><Icon name={card.kind} size={14} /></div>
        <button className="raft-content" draggable={!removing && !isTauri} onClick={() => onSelect(card.id)} onDoubleClick={() => onRestore(card.id)} aria-label={`恢复${card.preview}`}>
          {card.kind === "image" && <div className="image-preview">{imageSrc ? <img src={imageSrc} alt="" draggable={false} /> : <><span className="sun" /><span className="mountain mountain-back" /><span className="mountain mountain-front" /><span className="lake-line" /></>}</div>}
          {card.kind === "file" && <div className="file-preview"><span className="file-tab" /><span className="zip-mark">ZIP</span></div>}
          <div className="paper">
            <strong>{card.preview}</strong>
            <span>{card.detail}</span>
            <small>{readTime(card.copiedAt)}</small>
          </div>
        </button>
        <div className="raft-actions">
          <button onClick={() => onRestore(card.id)} aria-label="恢复内容" title="恢复"><Icon name="restore" size={11} /></button>
          <button className={card.pinned ? "is-active" : ""} onClick={() => onTogglePin(card.id)} aria-label={card.pinned ? "取消固定卡片" : "固定卡片"} title={card.pinned ? "取消固定" : "固定"}><Icon name="pin" size={11} /></button>
          <button onClick={() => onDelete(card.id)} aria-label="删除卡片" title="移除"><Icon name="close" size={11} /></button>
        </div>
      </article>
    </div>
  );
}

function App() {
  // 先按模块期判定渲染，挂载后用 effect 校正一次（防注入时序竞态）
  const [isTauri, setIsTauri] = useState(isTauriEnv());
  useEffect(() => {
    const tauri = isTauriEnv();
    setIsTauri(tauri);
    // 桌面模式若因竞态被误判为浏览器预览，会以展开态启动；校正回收起态
    if (tauri) setExpanded(false);
  }, []);
  const [cards, setCards] = useState<ClipCard[]>([]);
  const [query, setQuery] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState(
    isTauri ? "桌面模式：按住木筏拖到目标窗口" : "浏览器预览：拖出功能需桌面应用",
  );
  const [autoPaste, setAutoPaste] = useState(true);
  const [historyPersistence, setHistoryPersistence] = useState(true);
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingOverTrash, setDraggingOverTrash] = useState(false);
  const [undoableId, setUndoableId] = useState<string | null>(null);
  // macOS 原生拖拽期间的状态：用于显示垃圾区并抑制自拖入
  const [nativeDraggingId, setNativeDraggingId] = useState<string | null>(null);
  const nativeDraggingIdRef = useRef<string | null>(null);
  const nativeDraggingRef = useRef(false);
  // 浏览器预览（无 Tauri）直接以展开态打开，方便查看 UI；桌面窗口保持收起启动
  const [expanded, setExpanded] = useState(!isTauriEnv());
  // 临时诊断：测试模式下在 document 层记录指针事件（验证后移除）
  useEffect(() => {
    if (!isTauri) return;
    let cleanup = () => {};
    void invoke<boolean>("test_mode")
      .then((enabled) => {
        if (!enabled) return;
        let count = 0;
        const log = (e: Event) => {
          count += 1;
          if (count > 40) return;
          const pe = e as PointerEvent;
          const target = (e.target as HTMLElement)?.className;
          void invoke("test_log", {
            payload: `[doc] ${e.type} #${count} at ${Math.round(pe.clientX)},${Math.round(pe.clientY)} target=${typeof target === "string" ? target.slice(0, 24) : "?"}`,
          }).catch(() => undefined);
        };
        const types = ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup"];
        types.forEach((t) => document.addEventListener(t, log, true));
        cleanup = () => types.forEach((t) => document.removeEventListener(t, log, true));
      })
      .catch(() => undefined);
    return () => cleanup();
  }, [isTauri]);
  const undoTimerRef = useRef<number | null>(null);
  const autoCollapseTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const ghostActiveRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const trashBayRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const worldRef = useRef<HTMLDivElement>(null);
  const [raftAnchors, setRaftAnchors] = useState<FluidRaft[]>([]);
  const [ghost, setGhost] = useState<{ label: string; x: number; y: number; card: ClipCard } | null>(null);

  const clearAutoCollapse = useCallback(() => {
    if (autoCollapseTimerRef.current) window.clearTimeout(autoCollapseTimerRef.current);
    autoCollapseTimerRef.current = null;
  }, []);

  const collapsePanel = useCallback(() => {
    setExpanded(false);
    void invoke("set_panel_expanded", { expanded: false }).catch(() => undefined);
  }, []);

  // 展开态鼠标离开面板：延迟自动收起（幽灵拖拽期间不打断）
  const scheduleCollapse = useCallback(() => {
    if (collapseTimerRef.current) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = window.setTimeout(() => collapsePanel(), 1400);
  }, [collapsePanel]);
  const cancelCollapse = useCallback(() => {
    if (collapseTimerRef.current) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }, []);

  const openPanel = useCallback((peek = false) => {
    clearAutoCollapse();
    setExpanded(true);
    void invoke("set_panel_expanded", { expanded: true });
    // 点击把手是显式交互：恢复面板可聚焦（macOS 复制预览期间不可聚焦）
    if (!peek) void invoke("focus_panel").catch(() => undefined);
    if (peek) {
      autoCollapseTimerRef.current = window.setTimeout(() => {
        setExpanded(false);
        void invoke("set_panel_expanded", { expanded: false });
      }, 2600);
    }
  }, [clearAutoCollapse]);

  const holdPanelOpen = useCallback(() => {
    clearAutoCollapse();
    setExpanded(true);
    void invoke("set_panel_expanded", { expanded: true });
    // 悬停属于 ADR-0002 允许取得焦点的显式交互
    void invoke("focus_panel").catch(() => undefined);
  }, [clearAutoCollapse]);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<ClipCard[]>("history_list");
      setCards(next);
    } catch {
      // Browser preview intentionally keeps the visual comp usable without Tauri.
      if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) setCards(browserPreviewCards);
    }
  }, []);

  useEffect(() => {
    void invoke<boolean>("get_history_persistence")
      .then(setHistoryPersistence)
      .catch(() => undefined);
    void invoke<boolean>("get_auto_paste")
      .then(setAutoPaste)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const imageCards = cards.filter((card) => card.kind === "image");
    void Promise.all(imageCards.map(async (card) => {
      try {
        const dataUrl = await invoke<string | null>("image_preview_data_url", { id: card.id });
        return dataUrl ? [card.id, dataUrl] as const : null;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (!active) return;
      setImagePreviews(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    });
    return () => { active = false; };
  }, [cards]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      clearAutoCollapse();
    };
  }, [clearAutoCollapse]);

  useEffect(() => {
    refresh();
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;
    let unlistenPanel: (() => void) | undefined;
    let unlistenPaste: (() => void) | undefined;
    let unlistenDrag: (() => void) | undefined;
    let permissionPrompted = false;
    void listen("panel://opened", () => holdPanelOpen())
      .then((cleanup) => { unlistenPanel = cleanup; })
      .catch(() => undefined);
    void listen<string>("paste://degraded", (event) => {
      setNotice(`自动粘贴未执行（${event.payload}），内容已复制到剪贴板`);
      // 首次降级时唤起系统引导（系统设置 → 辅助功能），之后只提示
      if (!permissionPrompted) {
        permissionPrompted = true;
        void invoke<boolean>("request_paste_permission").catch(() => undefined);
      }
    }).then((cleanup) => { unlistenPaste = cleanup; }).catch(() => undefined);
    void listen<ClipCard>("clipboard://updated", (event) => {
      openPanel(true);
      setCards((current) => [event.payload, ...current.filter((card) => card.id !== event.payload.id)].slice(0, 200));
      setNotice("新木筏已顺流靠岸");
    }).then((cleanup) => { unlisten = cleanup; }).catch(() => undefined);
    void listen<{ id: string; x: number; y: number; dropped: boolean }>("drag://ended", async (event) => {
      if (!isMacPlatform) return;
      nativeDraggingRef.current = false;
      setNativeDraggingId(null);
      if (!event.payload.id) return;
      // 垃圾区判定：落点为屏幕逻辑点（左上原点），垃圾区矩形换算为屏幕物理像素
      const bay = trashBayRef.current;
      if (!bay) return;
      const rect = bay.getBoundingClientRect();
      try {
        const [scaleFactor, position] = await Promise.all([
          getCurrentWebviewWindow().scaleFactor(),
          getCurrentWebviewWindow().outerPosition(),
        ]);
        const px = event.payload.x * scaleFactor;
        const py = event.payload.y * scaleFactor;
        const left = position.x + rect.left * scaleFactor;
        const top = position.y + rect.top * scaleFactor;
        if (px >= left && px <= left + rect.width * scaleFactor && py >= top && py <= top + rect.height * scaleFactor) {
          deleteCardRef.current(event.payload.id);
          setNotice("木筏已拖入漩涡删除");
        }
      } catch {
        // 窗口信息不可用时跳过垃圾区判定
      }
    }).then((cleanup) => { unlistenDrag = cleanup; }).catch(() => undefined);
    void getCurrentWebview().onDragDropEvent((event) => {
      // macOS 原生拖出经过本窗口：松手落在垃圾区则删除原卡片，其余忽略（防自拖入建卡）。
      // 原生会话接管后 WebView 指针事件停流，drop 事件是文件卡拖回面板删除的可靠通道。
      if (nativeDraggingRef.current) {
        if (event.payload.type === "drop") {
          const draggedId = nativeDraggingIdRef.current;
          const bay = trashBayRef.current;
          if (draggedId && bay) {
            const r = bay.getBoundingClientRect();
            void getCurrentWebviewWindow()
              .scaleFactor()
              .then((s) => {
                const px = event.payload.type === "drop" ? event.payload.position.x : 0;
                const py = event.payload.type === "drop" ? event.payload.position.y : 0;
                const hit =
                  px >= r.left * s &&
                  px <= (r.left + r.width) * s &&
                  py >= r.top * s &&
                  py <= (r.top + r.height) * s;
                void invoke("test_log", {
                  payload: `[drop] at ${Math.round(px)},${Math.round(py)} bay ${Math.round(r.left * s)},${Math.round(r.top * s)} ${Math.round(r.width * s)}x${Math.round(r.height * s)} hit=${hit}`,
                }).catch(() => undefined);
                if (hit) {
                  deleteCardRef.current(draggedId);
                  setNotice("木筏已拖入漩涡删除");
                }
                // drop 即会话结束：复位原生拖拽状态
                nativeDraggingRef.current = false;
                nativeDraggingIdRef.current = null;
                setNativeDraggingId(null);
              })
              .catch(() => undefined);
          }
        }
        return;
      }
      if (event.payload.type === "enter") {
        setNotice("把文件放到水面上，让它靠岸");
        return;
      }
      if (event.payload.type !== "drop") return;
      const filePaths = event.payload.paths.filter((path) => path.trim().length > 0);
      if (!filePaths.length) return;
      setNotice("文件正在水面靠岸…");
      void invoke<ClipCard>("ingest_paths", { paths: filePaths })
        .then((card) => {
          setCards((current) => [card, ...current.filter((item) => item.id !== card.id)].slice(0, 200));
          setNotice("文件木筏已靠岸");
        })
        .catch(() => setNotice("文件没有成功靠岸"));
    }).then((cleanup) => { unlistenDrop = cleanup; }).catch(() => undefined);
    return () => { unlisten?.(); unlistenDrop?.(); unlistenPanel?.(); unlistenPaste?.(); unlistenDrag?.(); };
  }, [holdPanelOpen, openPanel, refresh]);
  useRaftMotion(cards, refs);

  const visibleCards = cards.filter((card) => `${card.preview} ${card.detail}`.toLowerCase().includes(query.toLowerCase()));

  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const worldRect = world.getBoundingClientRect();
    if (!worldRect.width || !worldRect.height) return;
    const next = visibleCards.flatMap((card, index) => {
      const motion = refs.current.get(card.id);
      const raft = motion?.querySelector<HTMLElement>(".raft-card");
      if (!raft) return [];
      const rect = raft.getBoundingClientRect();
      return [{
        x: (rect.left + rect.width / 2 - worldRect.left) / worldRect.width,
        y: 1 - (rect.top + rect.height / 2 - worldRect.top) / worldRect.height,
        strength: Math.max(0.48, 0.82 - index * 0.08),
      }];
    });
    setRaftAnchors(next);
  }, [cards, query, visibleCards.length]);

  // drag://ended 事件监听在组件树外注册一次，需要稳定的 deleteCard 引用
  const deleteCardRef = useRef<(id: string) => Promise<void>>(async () => undefined);

  const deleteCard = async (id: string) => {
    const card = cards.find((item) => item.id === id);
    if (card?.pinned && !window.confirm("这张木筏已固定，确认要将它移出历史吗？")) return;
    setRemovingId(id);
    setDraggingId(null);
    setDraggingOverTrash(false);
    window.setTimeout(async () => {
      setCards((current) => current.filter((card) => card.id !== id));
      setRemovingId(null);
      try { await invoke("delete_clip", { id }); } catch { /* browser preview */ }
      setUndoableId(id);
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(() => setUndoableId(null), 5000);
      setNotice("木筏已离岸，下面的卡片正在向上游补位");
    }, 170);
  };
  deleteCardRef.current = deleteCard;

  const undoDelete = async () => {
    if (!undoableId) return;
    const id = undoableId;
    setUndoableId(null);
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    try {
      await invoke("undo_delete", { id });
      await refresh();
      setNotice("木筏已回到水面");
    } catch {
      setNotice("撤销失败，木筏仍在下游");
    }
  };

  const restoreCard = async (id: string) => {
    setSelectedId(id);
    try { await invoke("restore_clip", { id, autoPaste }); } catch { /* browser preview */ }
    setNotice(autoPaste ? "内容已复制并尝试粘贴到上个应用" : "内容已复制到系统剪贴板");
  };

  const toggleHistoryPersistence = async () => {
    const next = !historyPersistence;
    try {
      await invoke("set_history_persistence", { enabled: next });
      setHistoryPersistence(next);
      await refresh();
      setNotice(next ? "历史保留已开启" : "仅保留本次会话内容");
    } catch {
      setNotice("历史保留设置未能更新");
    }
  };

  const togglePinned = async (id: string) => {
    const card = cards.find((item) => item.id === id);
    if (!card) return;
    const pinned = !card.pinned;
    try {
      const updated = await invoke<ClipCard>("set_clip_pinned", { id, pinned });
      setCards((current) => current.map((item) => item.id === id ? updated : item));
      setSelectedId(id);
      setNotice(pinned ? "木筏已固定在水面" : "木筏已恢复顺流排序");
    } catch {
      setNotice("固定状态更新失败");
    }
  };

  const toggleAutoPaste = async () => {
    const next = !autoPaste;
    try {
      await invoke("set_auto_paste", { enabled: next });
    } catch {
      // Browser preview has no native settings store.
    }
    setAutoPaste(next);
    setNotice(next ? "已开启自动粘贴" : "已关闭自动粘贴，仅复制");
  };

  const handleDragStart = (event: DragEvent<HTMLElement>, card: ClipCard, imageSrc?: string) => {
    event.dataTransfer.clearData();
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("application/x-clipraft-id", card.id);
    if (card.kind === "image" && imageSrc) {
      event.dataTransfer.setData("text/html", `<img src="${imageSrc}" alt="${card.preview}">`);
      event.dataTransfer.setData("DownloadURL", `image/png:clipraft-${card.id}.png:${imageSrc}`);
    }
    event.dataTransfer.setData("text/plain", card.preview);
    setDraggingId(card.id);
    setDraggingOverTrash(false);
    void invoke("restore_clip", { id: card.id, autoPaste: false })
      .catch(() => setNotice("拖出内容准备失败"));
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDraggingOverTrash(false);
  };

  /** 拖出：文件/图片卡在 macOS 走原生 NSDraggingSession（AppKit 绘制预览，
      落点经 drag://ended 回传）；文本卡与 Windows 全部走影子跟手 + 松手粘贴
      （聊天框等目标不接受文本拖入，只能以"点击落点 + 粘贴"语义进输入框） */
  const startNativeDrag = useCallback(
    (card: ClipCard, origin: { x: number; y: number }) => {
      const tlog = (msg: string) => {
        void invoke("test_log", { payload: msg }).catch(() => undefined);
      };
      tlog(`[fe] startNativeDrag kind=${card.kind} mac=${isMacPlatform}`);
      if (isMacPlatform && card.kind !== "text") {
        setNotice("拖动中：松手把内容交给目标窗口；拖回漩涡可删除");
        nativeDraggingRef.current = true;
        nativeDraggingIdRef.current = card.id;
        setNativeDraggingId(card.id);
        void invoke("start_clip_drag_monitor", { id: card.id }).catch((error) => {
          tlog(`[fe] native invoke failed: ${error}`);
          nativeDraggingRef.current = false;
          nativeDraggingIdRef.current = null;
          setNativeDraggingId(null);
          setNotice("拖出失败：" + String(error));
        });
        return;
      }
      setNotice("拖动中：松手粘贴到光标下的窗口；拖回漩涡可删除");
      ghostActiveRef.current = true;
      setGhost({ label: card.preview.slice(0, 26), x: origin.x, y: origin.y, card });
      const pointerOverTrash = (event: PointerEvent) => {
        const bay = trashBayRef.current;
        if (!bay) return false;
        const r = bay.getBoundingClientRect();
        return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      };
      let moveCount = 0;
      const move = (event: PointerEvent) => {
        moveCount += 1;
        if (moveCount === 1 || moveCount % 20 === 0) tlog(`[fe] move #${moveCount} at ${Math.round(event.clientX)},${Math.round(event.clientY)}`);
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
        setGhost((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current));
        setDraggingOverTrash(pointerOverTrash(event));
      };
      const done = () => {
        window.removeEventListener("pointermove", move);
        ghostActiveRef.current = false;
        setGhost(null);
        setDraggingOverTrash(false);
        tlog(`[fe] done fired, moves=${moveCount}, pointer=${JSON.stringify(lastPointerRef.current)}`);
        // 松手在面板内：若落在删除区（漩涡）则删除该卡
        const p = lastPointerRef.current;
        const bay = trashBayRef.current;
        if (p && bay) {
          const r = bay.getBoundingClientRect();
          tlog(`[fe] trash check pointer=(${Math.round(p.x)},${Math.round(p.y)}) rect=(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)}`);
          if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
            void deleteCard(card.id);
            setNotice("木筏已拖入漩涡删除");
            return;
          }
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", done, { once: true });
      void invoke("start_clip_drag_monitor", { id: card.id }).catch((error) => {
        setNotice("拖出失败：" + String(error));
        done();
      });
    },
    [deleteCard],
  );

  // F9：把最新木筏直接粘贴到前台窗口（免拖动）；macOS 无拖拽会话可借力，直接恢复+粘贴
  useEffect(() => {
    if (!isTauri) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F9" && cards.length) {
        if (isMacPlatform) {
          void invoke("restore_clip", { id: cards[0].id, autoPaste: true }).catch((error) => {
            setNotice("粘贴失败：" + String(error));
          });
        } else {
          void invoke("start_clip_drag_monitor", { id: cards[0].id }).catch((error) => {
            setNotice("拖出失败：" + String(error));
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards]);

  const handleTrashDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (draggingId) void deleteCard(draggingId);
  };

  return (
    <main className={`app-shell${isTauri ? "" : " browser-preview"}${isMacPlatform ? " mac" : ""}`}>
      <div ref={worldRef} className={`creek-world ${expanded ? "" : "is-collapsed"}`} aria-label="ClipRaft 剪贴板面板" onMouseEnter={() => { cancelCollapse(); holdPanelOpen(); }} onMouseLeave={() => { if (expanded && !ghostActiveRef.current) scheduleCollapse(); }}>
        {!expanded && <button className="edge-handle" onClick={() => openPanel()} aria-label="打开 ClipRaft"><span /></button>}
        {expanded && <FlowBackdrop rafts={raftAnchors} />}
        <div className="water-photo-material" aria-hidden="true" />
        <div className="bank-stone stone-one" />
        <div className="bank-stone stone-two" />

        <header className="upstream-header">
          <div className="title-stone"><span>ClipRaft</span><small>剪贴流</small></div>
          <label className="search-stone">
            <Icon name="search" size={20} />
            <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索剪贴卡片" />
          </label>
        </header>

        <section className="history-stream" aria-live="polite">
          {visibleCards.length ? visibleCards.map((card, index) => (
            <RaftCard key={card.id} card={card} imageSrc={imagePreviews[card.id]} index={index} removing={removingId === card.id} selected={selectedId === card.id} isTauri={isTauri} onNativeDrag={(target, origin) => void startNativeDrag(target, origin)} onSelect={setSelectedId} onDelete={deleteCard} onRestore={restoreCard} onTogglePin={(id) => void togglePinned(id)} onDragStart={handleDragStart} onDragEnd={handleDragEnd} setRef={(element) => { if (element) refs.current.set(card.id, element); else refs.current.delete(card.id); }} />
          )) : <div className="empty-water">水面很安静<br /><span>复制一点内容，让木筏靠岸</span></div>}
        </section>

        {(draggingId || ghost || nativeDraggingId) && <button
          ref={trashBayRef}
          className={`trash-bay ${draggingOverTrash ? "is-hovered" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDraggingOverTrash(true); }}
          onDragLeave={() => setDraggingOverTrash(false)}
          onDrop={handleTrashDrop}
          aria-label="拖到这里删除卡片"
        ><Icon name="trash" size={18} /><span>{draggingOverTrash ? "松开删除" : "拖到这里删除"}</span></button>}

        <div className="detached-dock">
          <button aria-label="搜索卡片" onClick={() => searchInputRef.current?.focus()}><Icon name="search" /></button>
          <button aria-label={selectedId ? (cards.find((card) => card.id === selectedId)?.pinned ? "取消固定卡片" : "固定卡片") : "先选择卡片"} disabled={!selectedId} onClick={() => { if (selectedId) void togglePinned(selectedId); }}><Icon name="pin" /></button>
          <button aria-label={historyPersistence ? "关闭跨重启历史保留" : "开启跨重启历史保留"} title={historyPersistence ? "关闭历史保留" : "开启历史保留"} onClick={() => void toggleHistoryPersistence()}><Icon name="settings" /></button>
        </div>
        <div className="status-strip">
          <span className="status-dot" />
          <span>{notice}</span>
          {undoableId && <button className="undo-action" onClick={() => void undoDelete()}>撤销</button>}
          <button className={`auto-paste ${autoPaste ? "is-on" : ""}`} aria-pressed={autoPaste} onClick={() => void toggleAutoPaste()}>{autoPaste ? "自动粘贴" : "仅复制"}</button>
        </div>
        {ghost && <div className="drag-ghost" style={{ left: ghost.x + 14, top: ghost.y + 12 }}>{ghost.label}</div>}
      </div>
    </main>
  );
}

export default App;
