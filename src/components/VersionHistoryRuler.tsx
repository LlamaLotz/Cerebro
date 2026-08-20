import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, RotateCcw, History as HistoryIcon } from 'lucide-react';
import { ReconstructedVersion } from '../types';

interface VersionHistoryRulerProps {
  noteTitle: string;
  /** Versions oldest → newest; versions[0] is the original base snapshot. */
  versions: ReconstructedVersion[];
  loading: boolean;
  error: string | null;
  restoring: boolean;
  onRestore: (version: ReconstructedVersion) => void;
  onClose: () => void;
}

// Fixed width of each tick slot (px). With padding of `calc(50% - 20px)` on
// the track, tick `i` is dead-center at scrollLeft = i * TICK_SLOT_WIDTH.
const TICK_SLOT_WIDTH = 40;
// Preview cap — a huge historical version shouldn't jank the scrub.
const PREVIEW_MAX_CHARS = 50000;

// The scrubbed-content preview is the heaviest subtree in the modal (up to
// 50k chars of laid-out text). Memoized so a re-render that doesn't change the
// content (e.g. the same version re-scrolled) skips rebuilding it entirely.
const VersionPreview = React.memo(function VersionPreview({ content }: { content: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-300">
      {content.length > PREVIEW_MAX_CHARS
        ? content.slice(0, PREVIEW_MAX_CHARS) + '\n… (preview truncated)'
        : content}
    </pre>
  );
});

// SQLite CURRENT_TIMESTAMP stores UTC as "YYYY-MM-DD HH:MM:SS"; the space
// form parses as local time in most engines, so normalize to ISO + Z (UTC).
const parseCreated = (iso: string): Date | null => {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmtTime = (iso: string): string => {
  const d = parseCreated(iso);
  return d
    ? d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Unknown time';
};

const sameDay = (a: string, b: string): boolean => {
  const da = parseCreated(a);
  const db = parseCreated(b);
  return !!da && !!db && da.toDateString() === db.toDateString();
};

// Lightweight Set-based line diff for the "+N / -M" badge between the
// selected version and the one before it.
const diffStats = (older: string, newer: string): { added: number; removed: number } => {
  const la = new Set(older.split('\n'));
  const lb = new Set(newer.split('\n'));
  let added = 0;
  let removed = 0;
  for (const l of lb) if (!la.has(l)) added++;
  for (const l of la) if (!lb.has(l)) removed++;
  return { added, removed };
};

/**
 * iOS Timer-style horizontal version-history scrubber. A scrollable ruler of
 * tick marks sits under a fixed center pointer; scrolling (or arrow keys)
 * aligns a version under the marker, the preview below updates live, and
 * [ Restore Version ] commits the scrubbed state. The versions already carry
 * full reconstructed content (from get_all_reconstructed_versions), so
 * scrubbing previews instantly without per-scrub IPC.
 */
export const VersionHistoryRuler: React.FC<VersionHistoryRulerProps> = ({
  noteTitle,
  versions,
  loading,
  error,
  restoring,
  onRestore,
  onClose,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const centeredRef = useRef(false);
  // Selection lives here, not in the Editor: scrubbing used to call
  // `setSelectedVersion` in the parent, which re-rendered the ENTIRE editor
  // tree (CodeMirror, LinkHub, preview) on every scrub step — that was the
  // scrollbar jank. The ruler is the only consumer, so it owns the state.
  // The modal remounts per open, so this starts fresh (base version selected
  // once versions load below).
  const [selected, setSelected] = useState<ReconstructedVersion | null>(null);
  // Latest selection mirrored for the rAF scrub callback (runs after render).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // Even-pixel card width: the ruler's `calc(50% - 20px)` padding and the
  // left-1/2 pointer both need an even container so 50% never lands on a
  // .5px fraction (which pushes the 1px stem/ticks onto a half-pixel grid and
  // reads as a 1px offset). The overlay wrapper is measured (it resizes with
  // the window); the card is clamped to its 768px cap, minus the overlay's
  // px-6 padding (48px), then floored to the nearest even px.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [cardWidth, setCardWidth] = useState(800);
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const raw = entries[0].contentRect.width;
      if (raw <= 0) return;
      const target = Math.min(raw - 48, 768);
      const even = Math.max(320, Math.floor(target / 2) * 2);
      setCardWidth((w) => (w === even ? w : even));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Active drag state (pointer-drag scrubbing): start position + scrollLeft at
  // grab time. Any mouse button scrubs, including middle-button drags.
  const dragRef = useRef<{ startX: number; startScroll: number; active: boolean } | null>(null);
  // Set when a drag actually moved the track, so the click that follows the
  // pointer-up doesn't re-center on a tick (standard drag-vs-click guard).
  const suppressClickRef = useRef(false);

  const sel = selected ?? versions[0] ?? null;
  // Once versions arrive, anchor the selection on the base snapshot (matches
  // the old Editor-owned default of versions[0]).
  const prevVersionLenRef = useRef(0);
  if (selected === null && versions.length > 0 && prevVersionLenRef.current === 0) {
    prevVersionLenRef.current = versions.length;
    setSelected(versions[0]);
  }

  const selIdx = useMemo(() => {
    const selId = sel?.version_id ?? null;
    if (selId === null) return versions.findIndex((v) => v.version_id === null);
    return versions.findIndex((v) => v.version_id === selId);
  }, [versions, sel]);
  const boundedSelIdx = Math.max(0, selIdx);

  // Snap the track so tick `index` sits dead-center under the pointer. With
  // the fixed slot width and `calc(50% - 20px)` edge padding, the exact
  // scrollLeft is simply index * TICK_SLOT_WIDTH — no DOM measurement needed.
  const scrollToVersion = (index: number, animate = true) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({
      left: Math.max(0, index * TICK_SLOT_WIDTH),
      behavior: animate ? 'smooth' : 'auto',
    });
  };

  // Center the initially selected version once the list has loaded (the
  // scroll position is user-controlled afterwards — no fighting the drag).
  useEffect(() => {
    if (!trackRef.current || versions.length === 0 || centeredRef.current) return;
    centeredRef.current = true;
    scrollToVersion(selIdx, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions]);

  // Mouse-wheel scrubbing: a plain vertical wheel does nothing on a
  // horizontal overflow strip, so map wheel deltas onto the track's
  // scrollLeft. Each standard mouse notch moves exactly ONE tick: deltas are
  // accumulated in a ref and a full step (~one notch, whether the OS reports
  // it in pixels or lines) advances the track by TICK_SLOT_WIDTH — so the ruler
  // never free-runs from a fast wheel or a high-resolution trackpad.
  // Native listener with passive:false so preventDefault reliably stops the
  // page from scrolling instead. The track is conditionally rendered (only
  // once versions load), so attach per-versions-load — a mount-time attach
  // would find no element and never fire.
  const wheelAccRef = useRef(0);
  const WHEEL_STEP = 100; // ~one standard mouse wheel notch (px-equivalent)
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Normalize deltaMode: 0 = pixels, 1 = lines (~33px each), 2 = pages.
      const d =
        e.deltaMode === 1 ? e.deltaY * 33 + e.deltaX * 33 : e.deltaMode === 2 ? e.deltaY * 200 : e.deltaY + e.deltaX;
      wheelAccRef.current += d;
      const steps = Math.trunc(wheelAccRef.current / WHEEL_STEP);
      if (steps !== 0) {
        wheelAccRef.current -= steps * WHEEL_STEP;
        el.scrollLeft += steps * TICK_SLOT_WIDTH;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [versions]);

  // Scrub: the slot under the center pointer is exactly
  // round(scrollLeft / TICK_SLOT_WIDTH). Scroll events fire many times per
  // frame (smooth scrolling, trackpads), so buffer the latest slot and report
  // it at most once per animation frame — a scrub previously triggered a full
  // modal re-render (diff + preview) for EVERY intermediate scroll event.
  const scrubPendingRef = useRef<number | null>(null);
  const scrubRafRef = useRef<number | null>(null);
  const handleTrackScroll = () => {
    const el = trackRef.current;
    if (!el || versions.length === 0) return;
    const activeIndex = Math.round(el.scrollLeft / TICK_SLOT_WIDTH);
    const bounded = Math.max(0, Math.min(versions.length - 1, activeIndex));
    scrubPendingRef.current = bounded;
    if (scrubRafRef.current !== null) return;
    scrubRafRef.current = requestAnimationFrame(() => {
      scrubRafRef.current = null;
      const idx = scrubPendingRef.current;
      scrubPendingRef.current = null;
      if (idx === null) return;
      const v = versions[idx];
      // Same-reference setState bails out in React; the ref keeps the guard
      // correct even though the rAF fires after the render.
      if (v && v !== selectedRef.current) setSelected(v);
    });
  };
  // Cancel any pending scrub on unmount (modal close mid-scrub).
  useEffect(() => {
    return () => {
      if (scrubRafRef.current !== null) cancelAnimationFrame(scrubRafRef.current);
    };
  }, []);

  const centerOn = (idx: number) => {
    if (suppressClickRef.current) {
      // A drag just ended on this tick — don't treat the release as a click.
      suppressClickRef.current = false;
      return;
    }
    scrollToVersion(idx, true);
    // The smooth scroll fires scroll events (handleTrackScroll), but a click
    // on the tick already under the marker wouldn't move — report it
    // explicitly.
    handleTrackScroll();
  };

  // Pointer-drag scrubbing: grab anywhere on the track (left or middle mouse
  // button) and drag horizontally — the track follows the pointer. Pointer
  // capture keeps the drag alive even when the cursor leaves the track.
  const handlePointerDown = (e: React.PointerEvent) => {
    const el = trackRef.current;
    if (!el) return;
    // Middle button: stop the browser's autoscroll behavior and drag instead.
    if (e.button === 1) e.preventDefault();
    dragRef.current = { startX: e.clientX, startScroll: el.scrollLeft, active: true };
    suppressClickRef.current = false;
    // Disable mandatory snapping while dragging — otherwise the browser
    // re-snaps to the nearest slot after every pointermove and the track
    // fights the drag. Restored on pointer-up.
    el.style.scrollSnapType = 'none';
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture unsupported — drag still works while the cursor stays
      // over the track.
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = trackRef.current;
    if (!d?.active || !el) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 3) suppressClickRef.current = true;
    el.scrollLeft = d.startScroll - dx;
  };

  const handlePointerEnd = () => {
    dragRef.current = null;
    // Re-enable snapping so the track settles dead-center on the slot under
    // the pointer (also lets the initial centering scroll snap cleanly).
    if (trackRef.current) trackRef.current.style.scrollSnapType = 'x mandatory';
  };

  const handleKey = (e: React.KeyboardEvent) => {
    const el = trackRef.current;
    if (!el) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      el.scrollBy({ left: -TICK_SLOT_WIDTH, behavior: 'smooth' });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      el.scrollBy({ left: TICK_SLOT_WIDTH, behavior: 'smooth' });
    }
  };

  // Major ticks: the current selection, the base + newest versions, every 5th
  // version, and any version that starts a new day.
  const isMajor = (i: number) =>
    i === boundedSelIdx ||
    i === 0 ||
    i === versions.length - 1 ||
    i % 5 === 0 ||
    (i > 0 && !sameDay(versions[i - 1].created_at, versions[i].created_at));

  const isBase = !!sel && sel.version_id === null;
  // The +N/-M badge splits two full version bodies into line sets — only
  // recompute when the selection (or the version list) actually changes, not
  // on every parent re-render.
  const diff = useMemo(() => {
    if (!sel) return { added: 0, removed: 0 };
    return diffStats(versions[boundedSelIdx - 1]?.content ?? '', sel.content);
  }, [sel, boundedSelIdx, versions]);

  return (
    <div ref={overlayRef} className="absolute inset-0 z-30 flex items-center justify-center px-6 pointer-events-none">
      <div
        className="pointer-events-auto w-full max-w-3xl bg-surface border border-border backdrop-blur-xl rounded-2xl p-4 shadow-2xl select-none"
        style={{ width: cardWidth }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1 bg-brand-500/10 border border-brand-500/20 rounded-md text-brand-400 shrink-0">
              <HistoryIcon className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-slate-100 truncate">Time Machine — {noteTitle}</h3>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="p-1 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded-md transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-slate-500">Loading versions…</div>
        ) : error ? (
          <div className="py-10 text-center text-xs text-red-400">Failed to load version history: {error}</div>
        ) : versions.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500 px-6">
            No saved versions yet. Versions are snapshotted on explicit save (Ctrl/Cmd+S), when you switch notes,
            and after quiet editing pauses — the original file is always kept as the base.
          </div>
        ) : (
          <>
            {/* Ruler track + fixed center pointer */}
            <div className="relative">
              {/* 1px crisp pointer: centered with flexbox (inset-x-0 + justify)
                  instead of left-1/2 + translate-x-1/2, so no .5px transform
                  offset lands on the 1px stem/ticks. shapeRendering crispEdges
                  keeps the triangle + stem on hard pixel boundaries. */}
              <div className="absolute top-0 inset-x-0 flex justify-center z-30 pointer-events-none">
                <svg
                  width="11"
                  height="16"
                  viewBox="0 0 11 16"
                  fill="none"
                  className="block drop-shadow-[0_0_6px_rgba(90,122,205,0.8)]"
                  shapeRendering="crispEdges"
                >
                  <polygon points="0,0 11,0 5.5,6" fill="#FEB05D" />
                  <line x1="5.5" y1="6" x2="5.5" y2="16" stroke="#FEB05D" strokeWidth="1" />
                </svg>
              </div>
              <div
                ref={trackRef}
                onScroll={handleTrackScroll}
                onKeyDown={handleKey}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
                tabIndex={0}
                title="Drag, wheel, or middle-mouse to scrub versions (← / → to step)"
                // calc(50% - TICK_SLOT_WIDTH/2) edge padding: tick `i` is
                // dead-center at scrollLeft = i * TICK_SLOT_WIDTH (iOS timer
                // style) — the first and last ticks align exactly too.
                // Native mandatory snapping (aligned center, scroll-padding
                // matching the edge padding) settles the track exactly on a
                // slot after wheel/drag/scroll so ticks never drift off the
                // center pointer.
                style={{
                  scrollSnapType: 'x mandatory',
                  scrollPaddingInline: `calc(50% - ${TICK_SLOT_WIDTH / 2}px)`,
                  paddingLeft: `calc(50% - ${TICK_SLOT_WIDTH / 2}px)`,
                  paddingRight: `calc(50% - ${TICK_SLOT_WIDTH / 2}px)`,
                }}
                className="no-scrollbar overflow-x-auto cursor-grab active:cursor-grabbing touch-pan-y outline-none h-14 flex items-end bg-surface-hover border border-border rounded-xl select-none"
              >
                {versions.map((v, i) => {
                  const selected = i === boundedSelIdx;
                  const major = isMajor(i);
                  return (
                    <button
                      key={v.version_id ?? 'base'}
                      onClick={() => centerOn(i)}
                      title={fmtTime(v.created_at)}
                      className="shrink-0 flex items-end justify-center h-full outline-none"
                      style={{
                        width: TICK_SLOT_WIDTH,
                        scrollSnapAlign: 'center',
                        scrollSnapStop: 'always',
                      }}
                    >
                      {/* Wider 3px tick line centered in the 40px slot, in the
                          same column as the 1px SVG needle above (the needle
                          drops into the tick's center pixel) */}
                      <div
                        className={`w-[3px] rounded-none transition-all duration-150 ${
                          selected
                            ? 'h-8 bg-brand-500 shadow-[0_0_10px_rgba(254,176,93,0.9)]'
                            : major
                              ? 'h-5 bg-brand-400/80'
                              : 'h-3 bg-slate-700 hover:bg-slate-500'
                        }`}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Restore + info row */}
            <div className="flex items-center justify-between gap-3 mt-3">
              <button
                onClick={() => sel && onRestore(sel)}
                disabled={!sel || restoring}
                title={
                  isBase
                    ? 'Restore the original snapshot (current content is snapshotted first)'
                    : 'Restore this version (current content is snapshotted first)'
                }
                className="flex items-center gap-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:hover:bg-brand-500 shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {restoring ? 'Restoring…' : 'Restore Version'}
              </button>
              <div className="flex items-center gap-2 min-w-0 justify-end">
                <span className="text-[10px] text-slate-500 shrink-0">
                  {isBase ? 'Original snapshot' : `Version ${versions.length - selIdx} of ${versions.length}`}
                </span>
                {!isBase && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 tabular-nums shrink-0">
                    <span className="text-emerald-400">+{diff.added}</span> / <span className="text-red-400">-{diff.removed}</span>
                  </span>
                )}
                <div className="text-lg font-bold text-white font-mono truncate">
                  {sel ? fmtTime(sel.created_at) : '—'}
                </div>
              </div>
            </div>

            {/* Live scrubbed-content preview */}
            <div className="mt-3 max-h-44 overflow-y-auto rounded-lg bg-surface/70 border border-border/60 px-3 py-2">
              <VersionPreview content={sel ? sel.content : ''} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
