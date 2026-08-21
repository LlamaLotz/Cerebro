import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { GraphNode, GraphLink, NoteFile } from '../types';
import { Network, Home, Orbit } from 'lucide-react';
import { mixHex, hexToRgba } from '../utils/accentColor';

interface GraphView3DProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
  /** Extra toolbar controls injected by the container (2D/3D mode toggle). */
  toolbarExtra?: React.ReactNode;
  /** Appearance setting: grid / mesh / solid backdrop behind the graph. */
  backgroundPattern?: 'grid' | 'mesh' | 'solid';
  /** Appearance settings: start auto-rotating the camera on load + its speed. */
  autoRotateOnLoad?: boolean;
  autoRotateSpeed?: number;
  /** Appearance setting: 'high' renders label billboards at up to 3x DPI
   *  (crisper when zoomed, slightly more GPU); 'standard' caps at 1x. */
  labelQuality?: 'standard' | 'high';
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  linksCount: number;
  exists: boolean;
}

// Prism palette (matches the 2D graph's legend): active note primary amber,
// existing notes lighter amber, uncreated wiki-link targets slate-grey.
// Mutable so the Appearance "Graph node color" setting re-themes the nodes.
let COLOR_ACTIVE = '#FEB05D'; // brand-500
let COLOR_EXISTS = '#ffc069'; // brand-400
const COLOR_MISSING = '#3c3b39'; // slate-grey
let COLOR_HOVER = '#ffcb85'; // brand-300
const LINK_COLOR = 'rgba(245, 242, 242, 0.08)'; // off-white, faint

/** Re-derives the 3D node palette from a user-picked base color. */
export function setGraphPalette(nodeColor: string): void {
  const base = /^#[0-9a-f]{6}$/i.test(nodeColor) ? nodeColor.toLowerCase() : '#FEB05D';
  COLOR_ACTIVE = base;
  COLOR_EXISTS = mixHex(base, '#ffffff', 0.22); // lighter "exists" shade
  COLOR_HOVER = mixHex(base, '#ffffff', 0.35); // light hover shade
}

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
  backgroundPattern = 'grid',
  autoRotateOnLoad = false,
  autoRotateSpeed = 0.67,
  labelQuality = 'high',
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
  // title -> label sprite (reused across node rebuilds via refresh()). The
  // cache is evicted below when a title leaves the graph, so its GPU textures
  // stay bounded to the current graph instead of growing with every distinct
  // title ever shown (on a big vault, unbounded 3x-DPR pill textures were the
  // WebGL memory balloon).
  const labelCacheRef = useRef<Map<string, THREE.Sprite>>(new Map());
  // Every node group created by nodeThreeObject, so unmount can dispose their
  // GPU resources explicitly (three-forcegraph does NOT dispose custom node
  // objects when nodes leave the graph — it just drops them for GC).
  const nodeGroupsRef = useRef<Set<THREE.Group>>(new Set());

  const [autoRotate, setAutoRotate] = useState(autoRotateOnLoad);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTitle = activeNote?.title?.toLowerCase();
  // Snapshot of the last tooltip we actually rendered, so the hover poll can
  // skip setTooltip when the camera + node are static (no React re-render).
  const lastTooltipRef = useRef('');
  // Live copies for the memoized graph callbacks below: react-force-graph-3d
  // re-applies any prop whose reference changed between renders, and
  // three-forcegraph treats a new nodeThreeObject reference as "clear +
  // rebuild every node object". These refs let the stable callbacks read
  // current values without being recreated on every render.
  const activeTitleRef = useRef(activeTitle);
  activeTitleRef.current = activeTitle;
  const onSelectNoteByTitleRef = useRef(onSelectNoteByTitle);
  onSelectNoteByTitleRef.current = onSelectNoteByTitle;
  const graphDataRef = useRef(graphData);
  graphDataRef.current = graphData;
  // Set when the camera should re-frame as soon as the force simulation
  // settles (new nodes arrived / first layout), so the fit uses real positions
  // instead of the initial clump at the origin.
  const pendingFrameRef = useRef(false);
  const lastNodeCountRef = useRef(-1);

  // Hand the library a stable copy of graphData instead of the raw prop.
  // three-forcegraph mutates the nodes/links it's given (it adds x/y/z and
  // swaps link endpoints for node object references) and re-feeds the array to
  // d3-force on every graphData change — brand-new node objects get re-seeded
  // from the origin, so even adding ONE new note made the whole graph re-clump
  // and re-spread (reads as a full "refresh", and on big graphs grinds through
  // a full O(n^2) charge re-layout = the freeze). Here existing nodes carry
  // their x/y/z (and fx/fy/fz drag pins) across updates and brand-new nodes
  // are seeded at their linked neighbors' centroid, so updates are incremental:
  // the new note slides into place and everything else holds still. It also
  // keeps App's graphData pristine for the 2D view (no object-endpoint
  // mutation leaking between views).
  const stableGraphRef = useRef<{ nodes: any[]; links: any[] } | null>(null);
  const positionsCarriedRef = useRef(false);
  const stableData = useMemo(() => {
    const normalize = (id: any) => String(id ?? '').toLowerCase();
    const endpointId = (e: any) => (typeof e === 'object' && e !== null ? e.id ?? e.title ?? '' : e);

    const nodes: any[] = graphData.nodes.map((n) => ({ ...n }));
    const links: any[] = graphData.links.map((l) => ({
      ...l,
      source: endpointId(l.source),
      target: endpointId(l.target),
    }));
    positionsCarriedRef.current = false;

    const prev = stableGraphRef.current;
    if (prev && prev.nodes.length) {
      // Carry existing positions over so unchanged nodes don't move.
      const prevById = new Map<string, any>();
      for (const p of prev.nodes) prevById.set(normalize(p.id), p);
      for (const n of nodes) {
        const old = prevById.get(normalize(n.id));
        if (old && Number.isFinite(old.x)) {
          n.x = old.x;
          n.y = old.y;
          n.z = old.z;
          if (Number.isFinite(old.fx)) n.fx = old.fx;
          if (Number.isFinite(old.fy)) n.fy = old.fy;
          if (Number.isFinite(old.fz)) n.fz = old.fz;
          positionsCarriedRef.current = true;
        }
      }

      // Seed brand-new nodes at their linked neighbors' centroid (fallback:
      // no position — d3 places them) so they appear in place instead of at
      // the origin and dragging the layout around.
      const nextById = new Map<string, any>();
      for (const n of nodes) nextById.set(normalize(n.id), n);
      const sums = new Map<string, { x: number; y: number; z: number; c: number }>();
      const accumulate = (id: string, from: any) => {
        const s = sums.get(id) ?? { x: 0, y: 0, z: 0, c: 0 };
        s.x += from.x;
        s.y += from.y;
        s.z += from.z;
        s.c += 1;
        sums.set(id, s);
      };
      for (const l of links) {
        const sId = normalize(endpointId(l.source));
        const tId = normalize(endpointId(l.target));
        const sn = nextById.get(sId);
        const tn = nextById.get(tId);
        if (!sn || !tn) continue;
        if (!Number.isFinite(sn.x) && Number.isFinite(tn.x)) accumulate(sId, tn);
        if (!Number.isFinite(tn.x) && Number.isFinite(sn.x)) accumulate(tId, sn);
      }
      for (const n of nodes) {
        if (Number.isFinite(n.x)) continue;
        const s = sums.get(normalize(n.id));
        if (s && s.c > 0) {
          n.x = s.x / s.c;
          n.y = s.y / s.c;
          n.z = s.z / s.c;
        }
      }
    }

    stableGraphRef.current = { nodes, links };
    return { nodes, links };
  }, [graphData]);

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

  // --- World-space backdrop (grid / mesh floor) ---
  // The old screen-space CSS overlay stayed frozen on the screen while the
  // graph rotated underneath it — the mismatch read as motion sickness when
  // orbiting/zooming. The pattern now lives on a large plane in the Three.js
  // scene, just below the lowest node, so it rotates and zooms WITH the graph
  // like a floor under the network. `solid` keeps the plain black canvas.
  const bgObjectRef = useRef<THREE.Mesh | null>(null);
  const BG_CELLS = 32;

  const createBackgroundTexture = (pattern: 'grid' | 'mesh') => {
    const px = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    if (pattern === 'grid') {
      ctx.strokeStyle = 'rgba(254, 176, 93, 0.12)';
      ctx.lineWidth = 1;
      const step = px / BG_CELLS;
      for (let i = 0; i <= BG_CELLS; i++) {
        const p = Math.round(i * step);
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, px);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, p);
        ctx.lineTo(px, p);
        ctx.stroke();
      }
    } else {
      const step = px / 24;
      ctx.fillStyle = 'rgba(254, 176, 93, 0.22)';
      for (let x = step / 2; x < px; x += step) {
        for (let y = step / 2; y < px; y += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };

  const createBackgroundObject = (pattern: 'grid' | 'mesh') => {
    const texture = createBackgroundTexture(pattern);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
    );
    // Lay the plane flat (XZ) so it reads as a floor under the graph.
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.texture = texture;
    return mesh;
  };

  const disposeBackground = (mesh: THREE.Mesh) => {
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  };

  // Size + place the floor to the graph's current footprint: centered under
  // the nodes and a little below the lowest one, scaled to ~3x the horizontal
  // span so it reads as an open backdrop instead of a tight platform.
  const updateBackground = () => {
    const bg = bgObjectRef.current;
    if (!bg) return;
    const nodes: any[] = stableGraphRef.current?.nodes ?? graphDataRef.current.nodes;
    if (!nodes.length) return;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x)) continue;
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
      minZ = Math.min(minZ, n.z);
      maxZ = Math.max(maxZ, n.z);
    }
    if (minX === Infinity) return;
    const span = Math.max(maxX - minX, maxZ - minZ, 100);
    const size = span * 3;
    bg.scale.set(size, size, 1);
    bg.position.set((minX + maxX) / 2, minY - span * 0.2, (minZ + maxZ) / 2);
  };

  const nodeColor = (node: any) => {
    if (activeTitleRef.current && node.title?.toLowerCase() === activeTitleRef.current) return COLOR_ACTIVE;
    return node.exists ? COLOR_EXISTS : COLOR_MISSING;
  };

  // Always-visible 3D text label: a camera-facing sprite (canvas texture) with
  // a dark rounded pill so titles stay readable over any background. Cached per
  // title — refresh() re-runs nodeThreeObject for every node and would
  // otherwise recreate + leak one canvas texture per rebuild.
  const makeLabelSprite = (text: string): THREE.Sprite => {
    const cached = labelCacheRef.current.get(text);
    if (cached) return cached;

    // Render at device-pixel-ratio (up to 3x for 'high', 1x for 'standard') so
    // the billboard text stays razor-sharp when the camera moves in close — a
    // low-res canvas turns visibly soft the moment it's magnified.
    const dpr = Math.min(window.devicePixelRatio || 1, labelQuality === 'high' ? 3 : 1);
    const fontPx = 116;
    const padX = 52;
    const maxTextW = 1176; // ellipsize titles beyond this width
    const pillH = 264;
    const radius = 60;

    // Measure + ellipsize on a scratch canvas (fixed max width) first, then
    // size the real canvas EXACTLY to the pill (w x pillH). A fixed canvas
    // with transparent margins used to be stretched onto the sprite quad,
    // which rendered the pill at the wrong aspect ratio (short labels looked
    // squished/tall/skinny — the shorter the label, the worse) and blurred
    // badly when scaled down. A tight canvas makes the sprite quad match the
    // visible pill: always the correct aspect, and no wasted transparent
    // pixels in the texture or its mipmaps.
    const measure = document.createElement('canvas');
    measure.width = maxTextW + padX * 2;
    measure.height = pillH;
    const mctx = measure.getContext('2d')!;
    mctx.font = `600 ${fontPx}px Inter, 'Segoe UI', system-ui, -apple-system, sans-serif`;
    mctx.textBaseline = 'middle';

    // Over-long titles get an ellipsis so a huge heading never becomes a
    // giant billboard.
    let label = text;
    if (mctx.measureText(label).width > maxTextW) {
      let lo = 0;
      let hi = label.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (mctx.measureText(label.slice(0, mid) + '…').width <= maxTextW) lo = mid;
        else hi = mid - 1;
      }
      label = label.slice(0, lo).trimEnd() + '…';
    }

    const textW = Math.min(mctx.measureText(label).width, maxTextW);
    const w = textW + padX * 2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * dpr));
    canvas.height = Math.ceil(pillH * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Modern UI typography (medium-weight system sans + light letter-spacing)
    // instead of the old mono stack.
    ctx.font = `600 ${fontPx}px Inter, 'Segoe UI', system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';

    // Pill: subtle top-to-bottom gradient + hairline border for a polished,
    // depth-y look instead of a flat slab.
    const grad = ctx.createLinearGradient(0, 0, 0, pillH);
    grad.addColorStop(0, 'rgba(43, 42, 42, 0.88)');
    grad.addColorStop(1, 'rgba(13, 14, 18, 0.78)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, pillH, radius);
    ctx.fill();
    ctx.strokeStyle = 'rgba(185, 182, 179, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, pillH - 2, radius - 1);
    ctx.stroke();

    // Text: near-white with a soft drop shadow so titles stay legible even
    // against bright content behind them.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#F5F2F2';
    ctx.textAlign = 'center';
    ctx.fillText(label, w / 2, pillH / 2 + 1);

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
    // The sprite quad now matches the pill exactly (canvas == pill size), so
    // this keeps the pill's pixel aspect ratio at the fixed label height.
    sprite.scale.set((LABEL_HEIGHT * w) / pillH, LABEL_HEIGHT, 1);
    sprite.userData.texture = texture;
    labelCacheRef.current.set(text, sprite);
    return sprite;
  };

  // Render each node as a group: sphere (scaled by connection count) + text
  // label floating above it. The sphere keeps `userData.baseScale` so the
  // hover highlight restores it exactly. Memoized: see the stable-graph-props
  // note on handleNodeHover.
  // Explicitly frees every GPU resource inside a node group (sphere geometry,
  // materials, label texture). Safe on unmount/eviction where the resources
  // are being dropped from the caches; NOT called per data-change because the
  // node groups share the cached geometry/materials with still-live nodes.
  const disposeNodeGroup = (group: THREE.Group) => {
    group.traverse((child) => {
      if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
      if ((child as THREE.Mesh).material) {
        const mat = (child as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      if ((child as THREE.Sprite).material) {
        const spriteMat = (child as THREE.Sprite).material;
        if (spriteMat.map) spriteMat.map.dispose();
        spriteMat.dispose();
      }
    });
  };

  const nodeThreeObject = useCallback((node: any) => {
    const mesh = new THREE.Mesh(sphereGeoRef.current!, materialFor(nodeColor(node)));
    const r = nodeRadius(node.linksCount ?? 0);
    mesh.scale.set(r, r, r);
    mesh.userData.baseScale = r;
    // Stash identity on the mesh so recoloring (active-note switch, hover
    // reset) can swap materials directly without rebuilding node objects.
    mesh.userData.title = node.title ?? node.id;
    mesh.userData.exists = !!node.exists;
    nodeMeshesRef.current.set(node.id, mesh);

    const label = makeLabelSprite(node.title ?? node.id);
    label.position.set(0, r + LABEL_HEIGHT / 2 + 1.5, 0);

    const group = new THREE.Group();
    group.add(mesh);
    group.add(label);
    nodeGroupsRef.current.add(group);
    return group;
  }, []);

  // Color a node sphere from its stored identity: the active note glows
  // orange, existing notes warm orange, uncreated wiki-link targets slate.
  // Reads `exists`/`title` off userData so recoloring never rebuilds objects.
  const applyNodeColor = (mesh: THREE.Mesh) => {
    const title = mesh.userData.title as string | undefined;
    const isActive = activeTitleRef.current && title && title.toLowerCase() === activeTitleRef.current;
    mesh.material = materialFor(isActive ? COLOR_ACTIVE : mesh.userData.exists ? COLOR_EXISTS : COLOR_MISSING);
  };

  // Hover: bump the sphere's scale + material; restore on unhover (labels
  // keep their size — they're siblings of the sphere in the node group).
  const applyHover = (node: any | null) => {
    for (const [id, mesh] of nodeMeshesRef.current) {
      mesh.scale.set(mesh.userData.baseScale, mesh.userData.baseScale, mesh.userData.baseScale);
      applyNodeColor(mesh);
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
      const next: TooltipState = {
        x,
        y,
        title: node.title ?? node.id,
        linksCount: node.linksCount ?? 0,
        exists: !!node.exists,
      };
      const key = `${Math.round(x)}:${Math.round(y)}:${next.title}:${next.linksCount}:${next.exists}`;
      // Camera + node both static → the tooltip hasn't moved; skip the state
      // update so the component doesn't re-render (and the graph doesn't
      // rebuild) 8x/sec while just hovering.
      if (key === lastTooltipRef.current) return;
      lastTooltipRef.current = key;
      setTooltip(next);
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

  const handleNodeHover = useCallback((node: any | null) => {
    applyHover(node ?? null);
    if (!node) {
      stopTooltipPoll();
      setTooltip(null);
      return;
    }
    updateTooltip(node);
    startTooltipPoll(node);
  }, []);

  // Cursor left the graph pane entirely (e.g. clicked a node → split view
  // mounted the editor under the pointer): the canvas gets no further hover
  // events, so the poll would keep running forever. Kill it + hide the
  // tooltip here.
  const handlePointerLeave = useCallback(() => {
    stopTooltipPoll();
    setTooltip(null);
  }, []);

  // Stable graph props: memoized with empty deps so re-renders of this
  // component (hover tooltip, resize, active-note recolor) never hand the
  // library new function references — a changed nodeThreeObject/linkColor
  // reference makes three-forcegraph rebuild every node/link object.
  const linkColor = useCallback(() => LINK_COLOR, []);
  // The small spheres travelling along connections follow the node color
  // (COLOR_ACTIVE is re-derived by setGraphPalette, so these tint together).
  const particleColor = useCallback(() => hexToRgba(COLOR_ACTIVE, 0.8), []);
  const handleNodeClick = useCallback(
    (node: any) => onSelectNoteByTitleRef.current(node.title ?? node.id),
    []
  );
  const handleEngineStop = useCallback(() => {
    if (!pendingFrameRef.current) return;
    pendingFrameRef.current = false;
    updateBackground();
    frameCamera(400);
  }, []);

  // Frame the camera over the graph's real node positions (not the label
  // sprites, whose bboxes would inflate the fit). Positions come from the
  // live simulation so this only runs once nodes have actually spread out.
  // Camera: fixed isometric 3/4 angle above + to the side — depth reads
  // clearly in 3D, and the fit never depends on wherever the camera was left.
  const frameCamera = (duration: number) => {
    const g = graphRef.current;
    if (!g) return;
    // `graphData` is NOT exposed on the ForceGraph3D ref (only the methods in
    // its methodNames list are), so g.graphData?.() is always undefined. Read
    // the live node positions from stableGraphRef instead — those are the very
    // objects handed to the library, and the simulation writes their x/y/z
    // (and fx/fy/fz) in place as it runs. The raw graphDataRef nodes never get
    // positions (App's snapshot is only spread-copied into stableData), so
    // using them here made frameCamera bail out on the `minX === Infinity`
    // guard — the Home button and the engine-stop fit silently did nothing.
    const nodes: any[] = stableGraphRef.current?.nodes ?? graphDataRef.current.nodes;
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
    if (minX === Infinity) {
      // No positioned nodes yet (layout still seeding) — let the library fit
      // the rendered scene instead of bailing out silently.
      try {
        g.zoomToFit?.(duration, 40);
      } catch {
        // ignore
      }
      return;
    }

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
    updateBackground();
    g.cameraPosition?.({ x: pos.x, y: pos.y, z: pos.z }, { x: cx, y: cy, z: cz }, duration);
  };

  // Re-apply the 3D force tuning on every data change. three-forcegraph
  // already re-heats the simulation itself whenever graphData changes (it
  // re-feeds nodes/links and calls alpha(1)), so calling restart() here too
  // would double the re-heat and make the graph visibly re-clump twice.
  // When positions were carried over (an incremental update — new note,
  // edited link), damp that re-heat: existing nodes are already at force
  // equilibrium, and a full-energy re-layout just burns O(n^2) charge ticks
  // on large graphs for zero visible benefit (the freeze).
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    applyForceTuning(g);
    if (positionsCarriedRef.current) g.alpha?.(0.35);
  }, [graphData]);

  // When the node SET changes (new notes), queue a re-frame; it fires once the
  // simulation settles (onEngineStop) so the fit uses the spread-out layout.
  useEffect(() => {
    if (graphData.nodes.length === lastNodeCountRef.current) return;
    lastNodeCountRef.current = graphData.nodes.length;
    if (graphData.nodes.length === 0) return;
    pendingFrameRef.current = true;
  }, [graphData.nodes.length]);

  // Re-color nodes when the active note changes — direct material swap on the
  // existing meshes instead of refresh() (which would rebuild every node
  // object). The library builds nodeThreeObject once per node id, so without
  // this the highlight would never move.
  useEffect(() => {
    for (const [, mesh] of nodeMeshesRef.current) {
      applyNodeColor(mesh);
    }
  }, [activeTitle]);

  // Auto-rotate toggle: drives the underlying OrbitControls' autoRotate flag.
  useEffect(() => {
    const g = graphRef.current;
    const controls = g?.controls?.();
    if (!controls) return;
    // NOTE: this only works with controlType="orbit" (set on <ForceGraph3D>).
    // The default control type is TrackballControls, whose modern three.js
    // implementation has NO autoRotate property — setting it there was a
    // silent no-op, which is why the toggle never rotated the graph.
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = autoRotate ? autoRotateSpeed : 0;
  }, [autoRotate, autoRotateSpeed]);

  // Mount / pattern-change: (re)build the world-space backdrop in the scene.
  // The WebGL canvas is opaque black, so the floor's faint lines are the only
  // backdrop — and because it lives in the scene, it rotates and zooms with
  // the graph instead of staying glued to the screen.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const scene = g.scene?.();
    if (!scene) return;

    if (bgObjectRef.current) {
      scene.remove(bgObjectRef.current);
      disposeBackground(bgObjectRef.current);
      bgObjectRef.current = null;
    }
    if (backgroundPattern === 'solid') return;

    const bg = createBackgroundObject(backgroundPattern);
    scene.add(bg);
    bgObjectRef.current = bg;
    updateBackground();

    return () => {
      if (bgObjectRef.current) {
        scene.remove(bgObjectRef.current);
        disposeBackground(bgObjectRef.current);
        bgObjectRef.current = null;
      }
    };
  }, [backgroundPattern]);

  // When the graph's node set changes, free GPU memory for nodes/labels that
  // are no longer shown: prune the mesh map and evict label sprites (texture +
  // material) for titles that left the graph. Sprites still in the graph are
  // untouched, so this never interrupts live labels — it only bounds the cache.
  useEffect(() => {
    const titles = new Set<string>();
    for (const n of graphData.nodes) {
      const t = n.title ?? n.id;
      if (t) titles.add(String(t));
    }
    const nodeIds = new Set(graphData.nodes.map((n) => n.id));
    for (const id of nodeMeshesRef.current.keys()) {
      if (!nodeIds.has(id)) nodeMeshesRef.current.delete(id);
    }
    for (const [title, sprite] of labelCacheRef.current) {
      if (titles.has(title)) continue;
      sprite.userData.texture?.dispose?.();
      sprite.material?.dispose?.();
      labelCacheRef.current.delete(title);
    }
  }, [graphData]);

  // Cleanup: dispose the shared GPU resources + tooltip poll on unmount.
  useEffect(() => {
    return () => {
      stopTooltipPoll();
      if (graphRef.current) {
        const controls = graphRef.current.controls?.();
        if (controls) controls.dispose?.();
      }
      // three-forcegraph never disposes custom node objects, so free every
      // node group's resources explicitly here.
      for (const group of nodeGroupsRef.current) disposeNodeGroup(group);
      nodeGroupsRef.current.clear();
      sphereGeoRef.current?.dispose();
      for (const m of matCacheRef.current.values()) m.dispose();
      hoverMatRef.current?.dispose();
      for (const sprite of labelCacheRef.current.values()) {
        sprite.userData.texture?.dispose?.();
        sprite.material?.dispose?.();
      }
      nodeMeshesRef.current.clear();
      labelCacheRef.current.clear();
    };
  }, []);

  const handleResetCamera = () => {
    const g = graphRef.current;
    if (!g) return;
    try {
      // Canonical library fit: computes the bbox from the live rendered scene
      // and tweens the camera to frame it — the same API used in force-graph's
      // own demos, so it's the most battle-tested fit path available.
      g.zoomToFit?.(600, 40);
    } catch {
      // Fall back to our node-position-based fit.
      frameCamera(600);
    }
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
          <Network className="w-4 h-4 text-brand-400" />
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
                ? 'bg-brand-500/20 border-brand-500/50 text-brand-400'
                : 'bg-slate-900/60 border-slate-800/80 text-slate-400 hover:text-brand-400 hover:border-brand-500/50'
            }`}
          >
            <Orbit className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResetCamera}
            title="Reset camera to fit all nodes in view"
            className="p-1.5 rounded-md bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-brand-400 hover:border-brand-500/50 transition-colors flex items-center gap-1"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* WebGL container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative bg-black"
        onPointerLeave={handlePointerLeave}
      >
        <ForceGraph3D
          ref={graphRef}
          graphData={stableData}
          width={size.width}
          height={size.height}
          // OrbitControls instead of the default TrackballControls: it's the
          // only one of the two that supports autoRotate (TrackballControls
          // dropped autoRotate in modern three.js, so the toggle above was a
          // no-op). Rotation feel stays the same — left-drag rotate, scroll
          // zoom, right-drag pan.
          controlType="orbit"
          backgroundColor="#0D0E12"
          nodeThreeObject={nodeThreeObject}
          linkColor={linkColor}
          linkWidth={0.8}
          linkDirectionalParticles={2}
          linkDirectionalParticleSpeed={0.005}
          linkDirectionalParticleWidth={1.5}
          linkDirectionalParticleColor={particleColor}
          onNodeClick={handleNodeClick}
          onNodeHover={handleNodeHover}
          onEngineStop={handleEngineStop}
          cooldownTime={1200}
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
                  tooltip.exists ? (tooltip.title.toLowerCase() === activeTitle ? 'bg-brand-500' : 'bg-brand-400') : 'bg-slate-600'
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
