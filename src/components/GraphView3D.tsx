import React, { useEffect, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { GraphNode, GraphLink, NoteFile } from '../types';
import { Network, Home, Orbit } from 'lucide-react';

interface GraphView3DProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
  /** Extra toolbar controls injected by the container (2D/3D mode toggle). */
  toolbarExtra?: React.ReactNode;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  linksCount: number;
  exists: boolean;
}

// Dark-tech palette (matches the 2D graph's legend): active note bright
// orange, existing notes warm orange, uncreated wiki-link targets slate.
const COLOR_ACTIVE = '#f97316'; // orange-500
const COLOR_EXISTS = '#fb923c'; // orange-400
const COLOR_MISSING = '#475569'; // slate-600
const COLOR_HOVER = '#fdba74'; // orange-300
const LINK_COLOR = 'rgba(255, 255, 255, 0.15)';

// Node spheres are scaled by backlink/connection count so hubs read at a
// glance: 1.4..9 world units.
const nodeRadius = (linksCount: number) => Math.max(1.4, Math.min(9, 1.4 + linksCount * 0.55));

// Height (world units) of the always-visible 3D text label above each node.
const LABEL_HEIGHT = 6;

// Force simulation tuning: repulsion, link distance and centering are set once
// per data change (the library re-heats the same force layout on every
// graphData update, so re-applying here keeps them from drifting back to the
// library defaults). Stronger charge + longer link distance prevent the tight
// clumping you get with the default -30 charge / 30 link distance in 3D.
const applyForceTuning = (g: any) => {
  g.d3Force?.('charge')?.strength?.(-180); // push nodes apart in 3D space
  g.d3Force?.('link')?.distance?.(70); // keep connected notes readable
  g.d3Force?.('center')?.strength?.(0.8); // gentle pull toward the origin
  g.numDimensions?.(3);
};

export const GraphView3D: React.FC<GraphView3DProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
  toolbarExtra,
}) => {
  const graphRef = useRef<any>(null);
  // Explicit canvas sizing: react-force-graph-3d measures its container once at
  // mount, so any later flex re-layout (mode switch, pane resize, split view)
  // leaves the canvas smaller than the pane — black empty space on the right.
  // Track the container with a ResizeObserver and feed real dimensions to
  // <ForceGraph3D /> so the canvas always fills the pane.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  // One shared sphere geometry + a per-color material cache: nodes reuse
  // buffers instead of allocating a geometry/material pair per node.
  const sphereGeoRef = useRef<THREE.SphereGeometry | null>(null);
  if (!sphereGeoRef.current) sphereGeoRef.current = new THREE.SphereGeometry(1, 24, 24);
  const matCacheRef = useRef<Map<string, THREE.MeshStandardMaterial>>(new Map());
  const hoverMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  // id -> sphere mesh, so hover highlight / restore can mutate the right node
  // (labels are siblings in the node group and are never touched).
  const nodeMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  // title -> label sprite (reused across node rebuilds via refresh()).
  const labelCacheRef = useRef<Map<string, THREE.Sprite>>(new Map());

  const [autoRotate, setAutoRotate] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set when the camera should re-frame as soon as the force simulation
  // settles (new nodes arrived / first layout), so the fit uses real positions
  // instead of the initial clump at the origin.
  const pendingFrameRef = useRef(false);
  const lastNodeCountRef = useRef(-1);

  const activeTitle = activeNote?.title?.toLowerCase();

  const materialFor = (color: string) => {
    let m = matCacheRef.current.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.35,
        roughness: 0.45,
        metalness: 0.2,
      });
      matCacheRef.current.set(color, m);
    }
    return m;
  };
  if (!hoverMatRef.current) {
    hoverMatRef.current = new THREE.MeshStandardMaterial({
      color: COLOR_HOVER,
      emissive: COLOR_HOVER,
      emissiveIntensity: 0.7,
      roughness: 0.3,
      metalness: 0.15,
    });
  }

  const nodeColor = (node: any) => {
    if (activeTitle && node.title?.toLowerCase() === activeTitle) return COLOR_ACTIVE;
    return node.exists ? COLOR_EXISTS : COLOR_MISSING;
  };

  // Always-visible 3D text label: a camera-facing sprite (canvas texture) with
  // a dark rounded pill so titles stay readable over any background. Cached per
  // title — refresh() re-runs nodeThreeObject for every node and would
  // otherwise recreate + leak one canvas texture per rebuild.
  const makeLabelSprite = (text: string): THREE.Sprite => {
    const cached = labelCacheRef.current.get(text);
    if (cached) return cached;

    // Render at device-pixel-ratio (up to 2x) so the billboard text stays
    // razor-sharp when the camera moves in close — a 1x canvas turns visibly
    // soft the moment it's magnified.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const logicalW = 640;
    const logicalH = 192;
    const fontPx = 58;
    const padX = 26;
    const maxTextW = logicalW - padX * 2;
    const pillH = 132;
    const pillY = (logicalH - pillH) / 2;
    const radius = 30;

    const canvas = document.createElement('canvas');
    canvas.width = logicalW * dpr;
    canvas.height = logicalH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Modern UI typography (medium-weight system sans + light letter-spacing)
    // instead of the old mono stack.
    ctx.font = `600 ${fontPx}px Inter, 'Segoe UI', system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';

    // Over-long titles get an ellipsis so a huge heading never becomes a
    // giant billboard.
    let label = text;
    if (ctx.measureText(label).width > maxTextW) {
      let lo = 0;
      let hi = label.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(label.slice(0, mid) + '…').width <= maxTextW) lo = mid;
        else hi = mid - 1;
      }
      label = label.slice(0, lo).trimEnd() + '…';
    }

    const textW = Math.min(ctx.measureText(label).width, maxTextW);
    const w = textW + padX * 2;

    ctx.clearRect(0, 0, logicalW, logicalH);

    // Pill: subtle top-to-bottom gradient + hairline border for a polished,
    // depth-y look instead of a flat slab.
    const grad = ctx.createLinearGradient(0, pillY, 0, pillY + pillH);
    grad.addColorStop(0, 'rgba(16, 21, 38, 0.88)');
    grad.addColorStop(1, 'rgba(4, 7, 16, 0.78)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect((logicalW - w) / 2, pillY, w, pillH, radius);
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect((logicalW - w) / 2 + 1, pillY + 1, w - 2, pillH - 2, radius - 1);
    ctx.stroke();

    // Text: near-white with a soft drop shadow so titles stay legible even
    // against bright content behind them.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'center';
    ctx.fillText(label, logicalW / 2, pillY + pillH / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    // Correct sRGB output (without this the canvas colors render washed out)
    // and clamp texture anisotropy to the GPU's max for crisper oblique views.
    texture.colorSpace = THREE.SRGBColorSpace;
    try {
      const renderer = graphRef.current?.renderer?.();
      const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
      texture.anisotropy = Math.min(maxAniso, 8);
    } catch {
      // Renderer not ready yet — default filtering is fine.
    }

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
    );
    // Width proportional to the actual text (fixed label height).
    sprite.scale.set((LABEL_HEIGHT * w) / logicalH, LABEL_HEIGHT, 1);
    sprite.userData.texture = texture;
    labelCacheRef.current.set(text, sprite);
    return sprite;
  };

  // Render each node as a group: sphere (scaled by connection count) + text
  // label floating above it. The sphere keeps `userData.baseScale` so the
  // hover highlight restores it exactly.
  const nodeThreeObject = (node: any) => {
    const mesh = new THREE.Mesh(sphereGeoRef.current!, materialFor(nodeColor(node)));
    const r = nodeRadius(node.linksCount ?? 0);
    mesh.scale.set(r, r, r);
    mesh.userData.baseScale = r;
    nodeMeshesRef.current.set(node.id, mesh);

    const label = makeLabelSprite(node.title ?? node.id);
    label.position.set(0, r + LABEL_HEIGHT / 2 + 1.5, 0);

    const group = new THREE.Group();
    group.add(mesh);
    group.add(label);
    return group;
  };

  // Hover: bump the sphere's scale + material; restore on unhover (labels
  // keep their size — they're siblings of the sphere in the node group).
  const applyHover = (node: any | null) => {
    for (const [id, mesh] of nodeMeshesRef.current) {
      mesh.scale.set(mesh.userData.baseScale, mesh.userData.baseScale, mesh.userData.baseScale);
      mesh.material = materialFor(nodeColor({ id, title: id }));
    }
    if (node) {
      const mesh = nodeMeshesRef.current.get(node.id);
      if (mesh) {
        const s = mesh.userData.baseScale * 1.3;
        mesh.scale.set(s, s, s);
        mesh.material = hoverMatRef.current!;
      }
    }
  };

  // Keep the floating tooltip glued to the node while the camera moves
  // (drag, zoom, auto-rotate): poll its screen position a few times a second.
  const updateTooltip = (node: any) => {
    const g = graphRef.current;
    if (!g || typeof g.graph2ScreenCoords !== 'function') return;
    try {
      const { x, y } = g.graph2ScreenCoords(node.x, node.y, node.z);
      setTooltip({
        x,
        y,
        title: node.title ?? node.id,
        linksCount: node.linksCount ?? 0,
        exists: !!node.exists,
      });
    } catch {
      // Node out of view / camera not ready — keep last position.
    }
  };
  const startTooltipPoll = (node: any) => {
    if (tooltipTimerRef.current) clearInterval(tooltipTimerRef.current);
    tooltipTimerRef.current = setInterval(() => updateTooltip(node), 120);
  };
  const stopTooltipPoll = () => {
    if (tooltipTimerRef.current) {
      clearInterval(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  };

  const handleNodeHover = (node: any | null) => {
    applyHover(node ?? null);
    if (!node) {
      stopTooltipPoll();
      setTooltip(null);
      return;
    }
    updateTooltip(node);
    startTooltipPoll(node);
  };

  // Frame the camera over the graph's real node positions (not the label
  // sprites, whose bboxes would inflate the fit). Positions come from the
  // live simulation so this only runs once nodes have actually spread out.
  // Camera: fixed isometric 3/4 angle above + to the side — depth reads
  // clearly in 3D, and the fit never depends on wherever the camera was left.
  const frameCamera = (duration: number) => {
    const g = graphRef.current;
    if (!g) return;
    const nodes: any[] = g.graphData?.()?.nodes ?? graphData.nodes;
    if (!nodes.length) return;

    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x)) continue; // node not positioned yet
      const x = n.x ?? 0,
        y = n.y ?? 0,
        z = n.z ?? 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (minX === Infinity) return; // no positioned nodes yet

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const maxSide = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    // Headroom for the labels floating above their nodes.
    const size = maxSide + LABEL_HEIGHT * 2.5;
    const fov = ((g.camera?.()?.fov ?? 50) * Math.PI) / 180;
    // Fit the bounding sphere into the vertical fov, +25% breathing room.
    const dist = (size / 2 / Math.tan(fov / 2)) * 1.25;

    const dir = new THREE.Vector3(0.55, 0.8, 0.95).normalize();
    const pos = new THREE.Vector3(cx, cy, cz).addScaledVector(dir, dist);
    g.cameraPosition?.({ x: pos.x, y: pos.y, z: pos.z }, { x: cx, y: cy, z: cz }, duration);
  };

  // Tune the 3D force simulation on every data change (new notes / edits) —
  // the library re-heats the same layout, so re-applying strengths keeps the
  // spread, and reheating the simulation lets the new nodes find their place.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    applyForceTuning(g);
    g.alpha?.(1)?.restart?.();
  }, [graphData]);

  // When the node SET changes (new notes), queue a re-frame; it fires once the
  // simulation settles (onEngineStop) so the fit uses the spread-out layout.
  useEffect(() => {
    if (graphData.nodes.length === lastNodeCountRef.current) return;
    lastNodeCountRef.current = graphData.nodes.length;
    if (graphData.nodes.length === 0) return;
    pendingFrameRef.current = true;
  }, [graphData.nodes.length]);

  // Re-color nodes when the active note changes (the library only builds the
  // custom node objects once per node id, so refresh() re-runs nodeThreeObject
  // to move the active highlight).
  useEffect(() => {
    graphRef.current?.refresh?.();
  }, [activeNote?.title]);

  // Auto-rotate toggle: drives the underlying OrbitControls' autoRotate flag.
  useEffect(() => {
    const g = graphRef.current;
    const controls = g?.controls?.();
    if (!controls) return;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = autoRotate ? 0.8 : 0;
  }, [autoRotate]);

  // Cleanup: dispose the shared GPU resources + tooltip poll on unmount.
  useEffect(() => {
    return () => {
      stopTooltipPoll();
      if (graphRef.current) {
        const controls = graphRef.current.controls?.();
        if (controls) controls.dispose?.();
      }
      sphereGeoRef.current?.dispose();
      for (const m of matCacheRef.current.values()) m.dispose();
      hoverMatRef.current?.dispose();
      for (const sprite of labelCacheRef.current.values()) {
        sprite.userData.texture?.dispose?.();
        sprite.material?.dispose?.();
      }
      nodeMeshesRef.current.clear();
    };
  }, []);

  const handleResetCamera = () => {
    frameCamera(600);
  };

  // Keep the WebGL canvas sized to its container (see containerRef above).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      data-region="graph"
      className="flex-1 bg-neutral-950/20 border-r border-slate-900/60 flex flex-col h-full relative select-none"
    >
      {/* Header bar */}
      <div className="px-6 py-3.5 border-b border-slate-900/60 bg-slate-950/20 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-orange-400" />
          <h2 className="text-sm font-semibold text-slate-100">Knowledge Network</h2>
        </div>
        <div className="text-[10px] text-slate-500 font-medium flex items-center gap-2">
          {toolbarExtra}
          <span className="hidden lg:block">Drag to rotate • Scroll to zoom • Right-drag to pan</span>
          <button
            onClick={() => setAutoRotate((v) => !v)}
            title="Slowly rotate the camera around the graph"
            className={`p-1.5 rounded-md border transition-colors flex items-center gap-1 ${
              autoRotate
                ? 'bg-orange-500/20 border-orange-500/50 text-orange-400'
                : 'bg-slate-900/60 border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50'
            }`}
          >
            <Orbit className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResetCamera}
            title="Reset camera to fit all nodes in view"
            className="p-1.5 rounded-md bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50 transition-colors flex items-center gap-1"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* WebGL container */}
      <div ref={containerRef} className="flex-1 overflow-hidden relative bg-black">
        <ForceGraph3D
          ref={graphRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          backgroundColor="#000000"
          nodeThreeObject={nodeThreeObject}
          linkColor={() => LINK_COLOR}
          linkWidth={0.8}
          linkDirectionalParticles={2}
          linkDirectionalParticleSpeed={0.005}
          linkDirectionalParticleWidth={1.5}
          linkDirectionalParticleColor={() => 'rgba(251, 146, 60, 0.7)'}
          onNodeClick={(node: any) => onSelectNoteByTitle(node.title ?? node.id)}
          onNodeHover={handleNodeHover}
          onEngineStop={() => {
            if (!pendingFrameRef.current) return;
            pendingFrameRef.current = false;
            frameCamera(400);
          }}
          cooldownTime={3000}
        />

        {/* Floating dark-mode tooltip (title + backlink count) */}
        {tooltip && (
          <div
            className="absolute z-10 pointer-events-none bg-slate-900/95 border border-slate-700/80 rounded-lg px-3 py-2 shadow-2xl backdrop-blur-sm"
            style={{
              left: tooltip.x + 14,
              top: tooltip.y - 8,
              transform: 'translateY(-100%)',
            }}
          >
            <div className="text-[11px] font-semibold text-slate-100 max-w-[220px] truncate">
              {tooltip.title}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  tooltip.exists ? (tooltip.title.toLowerCase() === activeTitle ? 'bg-orange-500' : 'bg-orange-400') : 'bg-slate-600'
                }`}
              />
              {tooltip.linksCount} connection{tooltip.linksCount === 1 ? '' : 's'}
              {!tooltip.exists && ' • uncreated'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
