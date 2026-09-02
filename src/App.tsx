import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { mountFluidSurface, type FluidRaft } from "./flow/WebGLFluidBackdrop";

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

function RaftCard({ card, index, removing, onDelete, onRestore, onDragStart, onDragEnd, setRef }: {
  card: ClipCard;
  index: number;
  removing: boolean;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  setRef: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div className="raft-motion" ref={setRef}>
      <div className={`raft-wake wake-${index % 3}`} aria-hidden="true"><span /><span /><span /></div>
      <article
        className={`raft-card raft-${card.kind} raft-tilt-${index % 3} ${removing ? "is-removing" : ""}`}
        draggable={!removing}
        onDragStart={() => onDragStart(card.id)}
        onDragEnd={onDragEnd}
      >
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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingOverTrash, setDraggingOverTrash] = useState(false);
  const [undoableId, setUndoableId] = useState<string | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const worldRef = useRef<HTMLDivElement>(null);
  const [raftAnchors, setRaftAnchors] = useState<FluidRaft[]>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<ClipCard[]>("history_list");
      setCards(next);
    } catch {
      // Browser preview intentionally keeps the visual comp usable without Tauri.
    }
  }, []);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;
    void listen<ClipCard>("clipboard://updated", (event) => {
      setCards((current) => [event.payload, ...current.filter((card) => card.id !== event.payload.id)].slice(0, 200));
      setNotice("新木筏已顺流靠岸");
    }).then((cleanup) => { unlisten = cleanup; }).catch(() => undefined);
    void getCurrentWebview().onDragDropEvent((event) => {
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
    return () => { unlisten?.(); unlistenDrop?.(); };
  }, [refresh]);

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

  const deleteCard = async (id: string) => {
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
    try { await invoke("restore_clip", { id }); } catch { /* browser preview */ }
    setNotice("内容已复制到系统剪贴板");
  };

  const handleDragStart = (id: string) => {
    setDraggingId(id);
    setDraggingOverTrash(false);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDraggingOverTrash(false);
  };

  const handleTrashDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (draggingId) void deleteCard(draggingId);
  };

  return (
    <main className="app-shell">
      <div ref={worldRef} className="creek-world" aria-label="ClipRaft 剪贴板面板">
        <FlowBackdrop rafts={raftAnchors} />
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
            <RaftCard key={card.id} card={card} index={index} removing={removingId === card.id} onDelete={deleteCard} onRestore={restoreCard} onDragStart={handleDragStart} onDragEnd={handleDragEnd} setRef={(element) => { if (element) refs.current.set(card.id, element); else refs.current.delete(card.id); }} />
          )) : <div className="empty-water">水面很安静<br /><span>复制一点内容，让木筏靠岸</span></div>}
        </section>

        {draggingId && <button
          className={`trash-bay ${draggingOverTrash ? "is-hovered" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDraggingOverTrash(true); }}
          onDragLeave={() => setDraggingOverTrash(false)}
          onDrop={handleTrashDrop}
          aria-label="拖到这里删除卡片"
        ><Icon name="trash" size={18} /><span>{draggingOverTrash ? "松开删除" : "拖到这里删除"}</span></button>}

        <div className="detached-dock">
          <button aria-label="筛选卡片" onClick={() => setNotice("筛选功能将在下一条纵切片接入")}><Icon name="search" /></button>
          <button aria-label="固定卡片" onClick={() => setNotice("选中木筏后可固定")}><Icon name="pin" /></button>
          <button aria-label="设置" onClick={() => setNotice("设置码头正在准备")}><Icon name="settings" /></button>
        </div>
        <div className="status-strip">
          <span className="status-dot" />
          <span>{notice}</span>
          {undoableId && <button className="undo-action" onClick={() => void undoDelete()}>撤销</button>}
          <button className={`auto-paste ${autoPaste ? "is-on" : ""}`} onClick={() => { setAutoPaste((value) => !value); setNotice("自动粘贴将在下一阶段接入"); }}>{autoPaste ? "自动粘贴" : "仅复制"}</button>
        </div>
      </div>
    </main>
  );
}

export default App;
