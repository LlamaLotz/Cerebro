import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { NoteFile, GraphNode, GraphLink } from '../types';
import { Network, Home, RotateCw } from 'lucide-react';

interface GraphViewProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
  /** Extra toolbar controls injected by the container (2D/3D mode toggle). */
  toolbarExtra?: React.ReactNode;
}

export const GraphView: React.FC<GraphViewProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
  toolbarExtra,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const isFirstRenderRef = useRef(true);
  // True once the graph has ever seen real data — used to scope the fresh-
  // startup fly-in (alpha(1).restart()) to the first data arrival only.
  const firstDataSeenRef = useRef(false);

  // Persistent node layout: saved (x, y) per note title in localStorage so the
  // graph reopens in the exact arrangement it was left in. Saved coordinates
  // are applied as initial positions (x/y) — the simulation refines them, so
  // clumped or corner-stuck layouts self-repair on the next open.
  const POSITIONS_KEY = 'cerebro_graph_positions';
  const loadPositions = (): Record<string, { x: number; y: number }> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
      // Corrupt cache: multiple nodes pinned at (0,0) is exactly the "top-left
      // clump" bug — every node stacks at the pane origin because the saved
      // coordinates are all zero. Discard the whole layout so the radial seed
      // pass below spreads the nodes out instead of restoring the clump.
      const entries = Object.values(parsed) as Array<{ x: number; y: number }>;
      const zeroes = entries.filter((p) => p && p.x === 0 && p.y === 0).length;
      if (entries.length >= 2 && zeroes >= 2) {
        localStorage.removeItem(POSITIONS_KEY);
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  };
  const savePositions = (nodes: any[]) => {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
        positions[n.id] = { x: n.x, y: n.y };
      }
    }
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
    } catch {
      // Storage full/unavailable — layout just won't persist this time.
    }
  };
  const positionsRef = useRef(loadPositions());
  // Viewport transform (zoom/pan), persisted to localStorage so the graph
  // reopens exactly where it was left — not just across note edits but across
  // app restarts. A null value also means "never fitted this mount" (see the
  // fit logic in the effect).
  const ZOOM_KEY = 'cerebro_graph_zoom';
  const loadZoom = (): d3.ZoomTransform | null => {
    try {
      const raw = localStorage.getItem(ZOOM_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      if (
        Number.isFinite(t.x) &&
        Number.isFinite(t.y) &&
        Number.isFinite(t.k) &&
        t.k > 0
      ) {
        return d3.zoomIdentity.translate(t.x, t.y).scale(t.k);
      }
    } catch {
      // Corrupt/absent — treat as never fitted.
    }
    return null;
  };
  const saveZoom = (t: d3.ZoomTransform) => {
    try {
      localStorage.setItem(ZOOM_KEY, JSON.stringify({ x: t.x, y: t.y, k: t.k }));
    } catch {
      // Storage full/unavailable — the viewport just won't persist this time.
    }
  };
  const zoomTransformRef = useRef<d3.ZoomTransform | null>(loadZoom());
  // Debounced zoom persistence: wheel/gesture events fire faster than a
  // localStorage write per event is worth.
  const zoomSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest fit function, exposed for the header buttons (the function lives
  // inside the effect where the live simulation is built).
  const fitGraphRef = useRef<((w: number, h: number, d: number) => void) | null>(null);
  // The SVG's measuring container (clientWidth/Height are read from here).
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest d3.zoom behavior + the active-note centering function, exposed to
  // the auto-focus effects below (both live inside the graph-build effect
  // where the simulation is constructed).
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const centerOnNodeRef = useRef<(title: string, animate: boolean) => void>(() => {});
  // Re-heats the simulation (alpha 0.5) so note switches re-arrange the layout
  // without a manual Refresh. Exposed by the graph-build effect.
  const reheatSimulationRef = useRef<() => void>(() => {});
  // Full graph reset (Home/Refresh buttons): re-seeds every node, resets the
  // zoom transform and re-heats the physics. Exposed by the graph-build effect.
  const resetGraphRef = useRef<(w: number, h: number) => void>(() => {});
  // Last (note, node-set) that was auto-focused — edit refreshes with the same
  // note + node set must NOT re-center (would yank the viewport while typing).
  const autoFocusStateRef = useRef<{ note: string | null; nodeSet: string }>({
    note: null,
    nodeSet: '',
  });

  // Bumped by the Refresh button to force a full re-render of the graph.

  // Keep the latest callback in a ref so graph rebuilds are never triggered by
  // callback identity changes (the expensive D3 simulation only re-runs when
  // the debounced notes/activeNote props actually change).
  const selectNoteRef = useRef(onSelectNoteByTitle);
  useEffect(() => {
    selectNoteRef.current = onSelectNoteByTitle;
  }, [onSelectNoteByTitle]);

  // Safe container measurement with a window fallback: if the pane hasn't been
  // laid out yet (clientWidth/Height 0 or tiny), fall back to the window bounds
  // minus the sidebar/header chrome — so the force center and the initial
  // radial seed never land at (0,0) top-left.
  const getDimensions = () => {
    const w = containerRef.current?.clientWidth || 0;
    const h = containerRef.current?.clientHeight || 0;
    return {
      width: w > 100 ? w : window.innerWidth - 300, // subtract sidebar width
      height: h > 100 ? h : window.innerHeight - 60, // subtract toolbar height
    };
  };

  useEffect(() => {
    if (!svgRef.current) return;

    // 1. Nodes/links are served from SQLite (zero-IPC graph snapshot)
    const { nodes, links } = graphData;

    // Deep copy data so D3 can mutate it for simulation
    const d3Nodes = nodes.map((d) => ({ ...d }));
    const d3Links = links.map((d) => ({ ...d }));

    // 2. Select SVG and establish dimensions (the persisted-layout sanity
    // check below needs the pane size).
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // clear previous renders

    const { width, height } = getDimensions();

    svg.attr('width', '100%').attr('height', '100%');

    // 3. Re-apply persisted layout: saved coordinates become the nodes'
    // initial positions (x/y, NOT fx/fy pins). Pinning every node would
    // freeze the physics forever — a clumped or corner-stuck layout from an
    // old session could never repair itself and would be inherited on every
    // reopen. Starting from the saved spot and letting the simulation refine
    // it keeps the arrangement while spreading any clumps.
    //
    // Sanity check: a layout is only ever as large as the pane it was
    // arranged in. If the saved bounding box is absurdly bigger than the
    // current pane (e.g. a node dragged to extreme coordinates in an old
    // session), the data is corrupt — discard it so the graph re-lays itself
    // out instead of opening zoomed all the way out with a tiny clump.
    let hasSavedLayout = false;
    const applied: any[] = [];
    for (const n of d3Nodes) {
      const p = positionsRef.current[n.id];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        applied.push(n);
      }
    }
    if (applied.length > 0) {
      const xs = applied.map((n) => positionsRef.current[n.id].x);
      const ys = applied.map((n) => positionsRef.current[n.id].y);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bh = Math.max(...ys) - Math.min(...ys);
      if (bw > width * 4 || bh > height * 4) {
        positionsRef.current = {};
        try {
          localStorage.removeItem(POSITIONS_KEY);
        } catch {
          // Storage unavailable — the in-memory drop is enough.
        }
      } else {
        for (const n of applied) {
          const p = positionsRef.current[n.id];
          (n as any).x = p.x;
          (n as any).y = p.y;
          // Pin the node at its saved spot: the layout survives exactly as it
          // was left — the physics only arranges nodes that have no saved
          // position (new notes), and dragging still works (drag sets fx/fy).
          (n as any).fx = p.x;
          (n as any).fy = p.y;
        }
        hasSavedLayout = true;
      }
    }

    // 3.5 Sanitize & spread initial coordinates: nodes with no saved position
    // (or a corrupt one) would otherwise start at (0, 0) in a d3 simulation —
    // one clump in the pane's top-left corner, with links fanning to the
    // origin. Discard top-left/off-screen coordinates (uninitialized, zero, or
    // near-origin), clear their pins, and re-seed them in a ring around the
    // canvas center. Valid saved/pinned nodes keep their spots.
    const seedCount = d3Nodes.length || 1;
    d3Nodes.forEach((node: any, i: number) => {
      if (!node.x || node.x < 50 || !node.y || node.y < 50) {
        const angle = (i / seedCount) * 2 * Math.PI;
        const radius = 160 + Math.random() * 80;
        node.x = width / 2 + radius * Math.cos(angle);
        node.y = height / 2 + radius * Math.sin(angle);
        node.fx = null;
        node.fy = null;
      }
    });

    // 3. Create a container group for zooming
    const gContainer = svg.append('g');

    // Add Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        zoomTransformRef.current = event.transform;
        gContainer.attr('transform', event.transform);
        if (zoomSaveTimerRef.current) clearTimeout(zoomSaveTimerRef.current);
        zoomSaveTimerRef.current = setTimeout(() => saveZoom(event.transform), 400);
      });
    
    svg.call(zoom);
    zoomBehaviorRef.current = zoom;

    // 4. Create simulation forces. Strong repulsion + a larger collision
    // radius (which accounts for the labels) keep nodes from clumping into a
    // pile; the gentle x/y centering pulls stray nodes back into the pane
    // without collapsing clusters.
    const simulation = d3.forceSimulation<any>(d3Nodes)
      .force('link', d3.forceLink<any, any>(d3Links)
        .id((d) => d.id)
        .distance(120)
      )
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(0.05))
      .force('y', d3.forceY(height / 2).strength(0.05))
      .force('collision', d3.forceCollide().radius((d: any) => Math.max(14, d.linksCount * 1.5 + 12)));

    // Pre-warm the simulation: a few synchronous ticks settle the seeded
    // positions into a readable layout before the first painted frame (the
    // settle branches below continue from here), so startup never flashes a
    // (0,0) clump.
    for (let i = 0; i < 50 && simulation.alpha() > simulation.alphaMin(); ++i) {
      simulation.tick();
    }

    // 5. Draw Links (Edges)
    const linkElements = gContainer.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(d3Links)
      .enter()
      .append('line')
      .attr('stroke', '#334155') // slate-700
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', 1.5);

    // 6. Draw Nodes (Vertices)
    const nodeElements = gContainer.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(d3Nodes)
      .enter()
      .append('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<any, any>()
          .on('start', dragStarted)
          .on('drag', dragged)
          .on('end', dragEnded)
      );

    // Node Circle
    nodeElements.append('circle')
      .attr('r', (d: any) => {
        // Calculate circle radius based on links count
        return Math.max(6, Math.min(18, d.linksCount * 1.5 + 6));
      })
      .attr('fill', (d: any) => {
        const isCurrent = activeNote && activeNote.title.toLowerCase() === d.title.toLowerCase();
        if (isCurrent) return '#f97316'; // Orange-500 (active)
        return d.exists ? '#fb923c' : '#475569'; // Orange-400 or Slate-600 (uncreated)
      })
      .attr('stroke', (d: any) => {
        const isCurrent = activeNote && activeNote.title.toLowerCase() === d.title.toLowerCase();
        if (isCurrent) return '#ffffff';
        return d.exists ? '#c2410c' : '#1e293b';
      })
      .attr('stroke-width', (d: any) => {
        const isCurrent = activeNote && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? 2 : 1;
      })
      .attr('stroke-dasharray', (d: any) => d.exists ? 'none' : '3,3'); // dashed border for missing notes

    // Node Text labels
    nodeElements.append('text')
      .text((d) => d.title)
      .attr('dx', 12)
      .attr('dy', 4)
      .attr('font-size', '10px')
      .attr('font-weight', '500')
      .attr('fill', (d: any) => {
        const isCurrent = activeNote && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? '#f8fafc' : '#94a3b8'; // Slate-50 or Slate-400
      })
      .attr('pointer-events', 'none')
      .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8)');

    // 7. Click listener on nodes
    nodeElements.on('click', (event, d: any) => {
      selectNoteRef.current(d.title);
    });

    // 8. Tooltip hover effects
    nodeElements.on('mouseover', function (event, d: any) {
      d3.select(this).select('circle')
        .transition()
        .duration(150)
        .attr('r', Math.max(9, Math.min(22, d.linksCount * 1.5 + 9)))
        .attr('fill', '#ea580c'); // bright orange on hover
      
      d3.select(this).select('text')
        .transition()
        .duration(150)
        .attr('font-size', '11px')
        .attr('fill', '#ffffff');
    })
    .on('mouseout', function (event, d: any) {
      const isCurrent = activeNote && activeNote.title.toLowerCase() === d.title.toLowerCase();
      
      d3.select(this).select('circle')
        .transition()
        .duration(150)
        .attr('r', Math.max(6, Math.min(18, d.linksCount * 1.5 + 6)))
        .attr('fill', isCurrent ? '#f97316' : (d.exists ? '#fb923c' : '#475569'));
      
      d3.select(this).select('text')
        .transition()
        .duration(150)
        .attr('font-size', '10px')
        .attr('fill', isCurrent ? '#f8fafc' : '#94a3b8');
    });

    // 9. Simulation Tick function updating positions. Links reference their
    // endpoints by string id until the link force resolves them to node
    // objects; a not-yet-resolved (or dangling) reference evaluates to
    // undefined, and d3 renders an undefined attr as 0 — the classic
    // "starburst" of lines fanning to the pane's top-left corner. Resolve
    // coordinates safely: object endpoints pass through, string ids look up
    // the node map, and anything missing falls back to the canvas center.
    //
    // ID matching: App.buildGraphFromPayload canonicalizes every link endpoint
    // to the node's `id` (the note title), so `nodeMap.get(link.source)` hits
    // for the canonical case — but index by `id`, `title` AND `path` so a
    // reference in any of those string formats still resolves instead of
    // detaching to (0,0).
    const nodeMap = new Map<string, any>();
    for (const n of d3Nodes as any[]) {
      nodeMap.set(n.id, n);
      if (n.title && n.title !== n.id) nodeMap.set(n.title, n);
      if (n.path) nodeMap.set(n.path, n);
    }
    const getCoord = (nodeOrId: any, axis: 'x' | 'y'): number => {
      if (typeof nodeOrId === 'object' && nodeOrId !== null && axis in nodeOrId) {
        const v = nodeOrId[axis];
        return Number.isFinite(v) ? v : width / 2;
      }
      const found = nodeMap.get(nodeOrId);
      if (found && Number.isFinite(found[axis])) return found[axis];
      return axis === 'x' ? width / 2 : height / 2;
    };
    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d: any) => getCoord(d.source, 'x'))
        .attr('y1', (d: any) => getCoord(d.source, 'y'))
        .attr('x2', (d: any) => getCoord(d.target, 'x'))
        .attr('y2', (d: any) => getCoord(d.target, 'y'));

      nodeElements.attr('transform', (d: any) => `translate(${d.x}, ${d.y})`);
    });

    // --- Keep nodes in view ------------------------------------------------
    // Zoom/pan the viewport (a view transform only — node positions are never
    // changed) so the whole graph stays visible in whatever pane size the
    // graph is currently shown in (full pane, split pane, resized pane).
    const fitGraph = (targetWidth: number, targetHeight: number, duration: number) => {
      if (d3Nodes.length === 0 || targetWidth < 50 || targetHeight < 50) return;
      const xs = d3Nodes.map((d: any) => d.x);
      const ys = d3Nodes.map((d: any) => d.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = 80;
      const bw = Math.max(maxX - minX, 1);
      const bh = Math.max(maxY - minY, 1);
      // Never zoom in past 1:1 (small graphs keep natural node size) and never
      // zoom fully out — a corrupt bounding box must not shrink the graph to
      // a dot in the middle of the pane.
      const scale = Math.max(0.15, Math.min(1, Math.min((targetWidth - pad * 2) / bw, (targetHeight - pad * 2) / bh)));
      const tx = targetWidth / 2 - (minX + bw / 2) * scale;
      const ty = targetHeight / 2 - (minY + bh / 2) * scale;
      const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
      zoomTransformRef.current = t;
      if (duration > 0) {
        svg.transition().duration(duration).call(zoom.transform, t);
      } else {
        svg.call(zoom.transform, t);
      }
    };

    // Expose for the header "fit view" button.
    fitGraphRef.current = fitGraph;

    const nodesOutOfView = (t: d3.ZoomTransform, w: number, h: number): boolean =>
      d3Nodes.some((d: any) => {
        const p = t.apply([d.x, d.y]);
        return p[0] < -60 || p[1] < -60 || p[0] > w + 60 || p[1] > h + 60;
      });

    // Refresh behavior: instead of replaying the startup "nodes fly in"
    // simulation, settle the layout synchronously and fade the graph in, so
    // note edits / renames don't trigger a distracting physics animation.
    // Reopened graphs with a saved layout also settle synchronously — the
    // clump/corner repairs instantly instead of animating for seconds.
    const isFirstRender = isFirstRenderRef.current;
    isFirstRenderRef.current = false;
    if (hasSavedLayout) {
      // Pinned saved nodes + a short synchronous settle for any new/unpinned
      // nodes, then persist. No fly-in animation — the graph appears exactly
      // where it was left.
      for (let i = 0; i < 200 && simulation.alpha() > simulation.alphaMin(); i++) {
        simulation.tick();
      }
      simulation.stop();
      savePositions(d3Nodes);
    } else if (!isFirstRender) {
      for (let i = 0; i < 300 && simulation.alpha() > simulation.alphaMin(); i++) {
        simulation.tick();
      }
      simulation.stop();
      // Persist the settled layout so the next open restores this arrangement.
      savePositions(d3Nodes);
      // Fresh startup (no saved layout): re-heat the simulation so the seeded
      // positions spread into place with a visible animation instead of
      // popping. Edit refreshes keep the saved layout and stay synchronous
      // (no distraction while typing).
      if (!firstDataSeenRef.current) {
        simulation.alpha(1).restart();
      }
    }
    firstDataSeenRef.current = d3Nodes.length > 0;

    // --- Auto-focus machinery ----------------------------------------------
    // Centers the ACTIVE note at k=1.2 (mount, first data arrival, note
    // switch) instead of leaving the view zoomed out on the whole graph. The
    // center waits for the physics to settle so it lands on the node's real
    // position, and de-dupes on (note, node set) so plain edit refreshes with
    // the same note + node set never yank the viewport.
    const activeNode = activeNote
      ? d3Nodes.find((d: any) => d.title?.toLowerCase() === activeNote.title.toLowerCase())
      : undefined;
    const centerOnNode = (title: string, animate: boolean) => {
      const node = d3Nodes.find((d: any) => d.title?.toLowerCase() === title.toLowerCase()) as any;
      if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      const nodeSetKey = d3Nodes
        .map((d: any) => d.id)
        .sort()
        .join('\u0001');
      const prev = autoFocusStateRef.current;
      if (prev.note === title.toLowerCase() && prev.nodeSet === nodeSetKey) return; // already centered
      autoFocusStateRef.current = { note: title.toLowerCase(), nodeSet: nodeSetKey };
      const doCenter = () => {
        const cw = containerRef.current?.clientWidth || width;
        const ch = containerRef.current?.clientHeight || height;
        const transform = d3.zoomIdentity
          .translate(cw / 2 - node.x * 1.2, ch / 2 - node.y * 1.2)
          .scale(1.2);
        zoomTransformRef.current = transform;
        if (animate) {
          svg.transition().duration(600).call(zoom.transform, transform);
        } else {
          svg.call(zoom.transform, transform);
        }
      };
      if (simulation.alpha() > simulation.alphaMin()) {
        // Layout still animating (fresh fly-in): center once it settles.
        simulation.on('end.autoFocus', () => {
          simulation.on('end.autoFocus', null);
          doCenter();
        });
      } else {
        doCenter();
      }
    };
    centerOnNodeRef.current = centerOnNode;

    // Re-heat the physics on note switch so the active note's neighborhood
    // re-arranges without a manual Refresh. Idle-only: never interrupts an
    // in-flight animation with a fresh alpha bump.
    const reheatSimulation = () => {
      if (simulation.alpha() <= simulation.alphaMin()) {
        simulation.alpha(0.5).restart();
      }
    };
    reheatSimulationRef.current = reheatSimulation;

    // Full graph reset (Home / Refresh buttons): re-seed every node radially
    // around the canvas center, clear the persisted layout, reset the zoom
    // transform, and re-heat the physics so the graph re-lays itself out in
    // front of the user — no follow-up clicks needed.
    const resetGraphLayout = (w: number, h: number) => {
      const n = d3Nodes.length || 1;
      d3Nodes.forEach((node: any, i: number) => {
        const angle = (i / n) * 2 * Math.PI;
        const radius = 160 + Math.random() * 60;
        node.x = w / 2 + radius * Math.cos(angle);
        node.y = h / 2 + radius * Math.sin(angle);
        node.fx = null;
        node.fy = null;
      });
      positionsRef.current = {};
      const identity = d3.zoomIdentity;
      zoomTransformRef.current = identity;
      svg.transition().duration(500).call(zoom.transform, identity);
      simulation.alpha(1).restart();
    };
    resetGraphRef.current = resetGraphLayout;

    // Re-apply the viewport transform from the previous build (zoom survives
    // note edits), then make sure every node is still in view. A null view
    // transform means this mount has never been fitted — e.g. the first effect
    // run had no data yet, or stale/corrupt saved coordinates put the nodes in
    // a corner. In that case always center the graph, never trust the saved
    // coordinates to be anywhere useful. (When an active note exists, the
    // auto-focus effect below owns the initial view instead of a whole-graph
    // fit.)
    if (zoomTransformRef.current) {
      svg.call(zoom.transform, zoomTransformRef.current);
      if (nodesOutOfView(zoomTransformRef.current, width, height)) {
        fitGraph(width, height, 300);
      }
    } else if (!activeNode) {
      fitGraph(width, height, 0);
    }

    // First-ever render (no saved layout): fit once the physics animation
    // settles, and persist the settled arrangement. One-shot — post-drag
    // simulation restarts must never reset the user's zoom. When an active
    // note exists, the settle-triggered auto-focus centers it instead.
    if (isFirstRender && !hasSavedLayout) {
      simulation.on('end', () => {
        savePositions(d3Nodes);
        if (!activeNode) fitGraph(width, height, 400);
        simulation.on('end', null);
      });
    }

    // Live pane resizes (split view drag, AI panel resize, opening/closing the
    // graph tab): refit only when nodes would fall out of the visible area.
    const container = containerRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (container) {
      resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w < 50 || h < 50) return; // pane closed/hidden
        if (isFirstRender && simulation.alpha() > simulation.alphaMin()) return; // still animating
        if (nodesOutOfView(zoomTransformRef.current ?? d3.zoomIdentity, w, h)) {
          fitGraph(w, h, 250);
        }
      });
      resizeObserver.observe(container);
    }

    // Fade the freshly drawn graph in on refreshes (no physics animation).
    gContainer.style('opacity', isFirstRender ? 1 : 0);
    if (!isFirstRender) {
      gContainer.transition().duration(450).style('opacity', 1);
    }

    // Drag helper handlers
    function dragStarted(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event: any, d: any) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragEnded(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0);
      // Leave the node pinned at its dragged position and persist the layout.
      savePositions(d3Nodes);
      positionsRef.current = loadPositions();
      positionsRef.current[d.id] = { x: d.fx ?? d.x, y: d.fy ?? d.y };
    }

    // Zoom-to-fit double click trigger
    svg.on('dblclick.zoom', null); // disable default double click zoom

    return () => {
      resizeObserver?.disconnect();
      simulation.stop();
      if (zoomSaveTimerRef.current) {
        clearTimeout(zoomSaveTimerRef.current);
        zoomSaveTimerRef.current = null;
      }
    };
  }, [graphData, activeNote]);

  // Fit all nodes into view (header button).
  const handleFitView = () => {
    const c = containerRef.current;
    if (c) fitGraphRef.current?.(c.clientWidth, c.clientHeight, 400);
  };

  // Home / Refresh (header buttons): full graph reset — clears the persisted
  // layout cache, re-seeds all nodes radially around the canvas center, resets
  // the zoom transform to center, and re-heats the physics so the graph
  // re-lays itself out in front of the user.
  const handleResetGraph = () => {
    const { width, height } = getDimensions();
    localStorage.removeItem(POSITIONS_KEY);
    resetGraphRef.current(width, height);
  };

  // Auto-focus & center the ACTIVE note on mount and note switching: smoothly
  // animate the zoom so the active node sits center-screen at k=1.2. The
  // settle-wait and (note, node-set) de-dupe live inside centerOnNodeRef (set
  // by the graph-build effect), so edit refreshes that keep the same note and
  // node set never re-center the view.
  useEffect(() => {
    const title = activeNote?.title;
    if (!title) return;
    centerOnNodeRef.current(title, true);
    // Re-heat the physics so the active note's neighborhood re-arranges — no
    // manual Refresh needed on note switch.
    reheatSimulationRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNote?.title, graphData]);

  // Measured fit-on-mount: only run the whole-graph fit once the SVG container
  // reports real dimensions (a 0×0 first measure would fit against the 600×500
  // fallback). Gated to when no note is active — auto-focus owns the view when
  // a note is selected — and skipped when a saved viewport exists, so the app
  // still reopens exactly where the user left off.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let fitted = false;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      if (fitted) return;
      fitted = true;
      if (!activeNote && !zoomTransformRef.current) handleFitView();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  return (
    <div
      data-region="graph"
      className="flex-1 bg-slate-950/20 border-r border-slate-900/60 flex flex-col h-full relative select-none"
    >
      
      {/* Header bar */}
      <div className="px-6 py-3.5 border-b border-slate-900/60 bg-slate-950/20 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-orange-400" />
          <h2 className="text-sm font-semibold text-slate-100">Knowledge Network</h2>
        </div>
        <div className="text-[10px] text-slate-500 font-medium flex items-center gap-2">
          {toolbarExtra}
          <span className="hidden lg:block">Drag to arrange • Scroll to zoom</span>
          <button
            onClick={handleResetGraph}
            title="Reset graph: re-layout all nodes around the center"
            className="p-1.5 rounded-md bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50 transition-colors flex items-center gap-1"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResetGraph}
            title="Reset graph: re-layout all nodes around the center"
            className="p-1.5 rounded-md bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50 transition-colors flex items-center gap-1"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* SVG Container */}
      <div ref={containerRef} className="flex-1 overflow-hidden relative">
        <svg ref={svgRef} className="w-full h-full" />
        
        {/* Legend */}
        <div className="absolute bottom-4 left-4 bg-slate-900/90 border border-slate-800/80 px-3.5 py-2.5 rounded-xl shadow-lg text-[10px] space-y-1.5 backdrop-blur-sm">
          <span className="font-semibold text-slate-400 block mb-1">GRAPH LEGEND</span>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-500 border border-white" />
            <span className="text-slate-200">Active Note</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-400 border border-orange-700" />
            <span className="text-slate-200">Existing Notes</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-slate-600 border border-dashed border-slate-500" />
            <span className="text-slate-400">Uncreated Wiki-links</span>
          </div>
        </div>
      </div>
    </div>
  );
};
