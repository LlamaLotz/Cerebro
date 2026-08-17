import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { NoteFile, GraphNode, GraphLink } from '../types';
import { Network, Home, RotateCw } from 'lucide-react';

interface GraphViewProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
}

export const GraphView: React.FC<GraphViewProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const isFirstRenderRef = useRef(true);

  // Persistent node layout: saved (x, y) per note title in localStorage so the
  // graph reopens in the exact arrangement it was left in. Saved coordinates
  // are applied as initial positions (x/y) — the simulation refines them, so
  // clumped or corner-stuck layouts self-repair on the next open.
  const POSITIONS_KEY = 'cerebro_graph_positions';
  const loadPositions = (): Record<string, { x: number; y: number }> => {
    try {
      return JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
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
  // Viewport transform (zoom/pan) of the last build, preserved across graph
  // rebuilds so note edits don't reset the user's zoom level. A null value
  // also means "never fitted this mount" (see the fit logic in the effect).
  const zoomTransformRef = useRef<d3.ZoomTransform | null>(null);

  // Latest fit function, exposed for the header buttons (the function lives
  // inside the effect where the live simulation is built).
  const fitGraphRef = useRef<((w: number, h: number, d: number) => void) | null>(null);

  // Bumped by the Refresh button to force a full re-render of the graph.
  const [refreshToken, setRefreshToken] = useState(0);

  // Keep the latest callback in a ref so graph rebuilds are never triggered by
  // callback identity changes (the expensive D3 simulation only re-runs when
  // the debounced notes/activeNote props actually change).
  const selectNoteRef = useRef(onSelectNoteByTitle);
  useEffect(() => {
    selectNoteRef.current = onSelectNoteByTitle;
  }, [onSelectNoteByTitle]);

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

    const width = svgRef.current.parentElement?.clientWidth || 600;
    const height = svgRef.current.parentElement?.clientHeight || 500;

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
        }
        hasSavedLayout = true;
      }
    }

    // 3. Create a container group for zooming
    const gContainer = svg.append('g');

    // Add Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        zoomTransformRef.current = event.transform;
        gContainer.attr('transform', event.transform);
      });
    
    svg.call(zoom);

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

    // 9. Simulation Tick function updating positions
    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

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
    if (!isFirstRender || hasSavedLayout) {
      for (let i = 0; i < 300 && simulation.alpha() > simulation.alphaMin(); i++) {
        simulation.tick();
      }
      simulation.stop();
    }

    // Re-apply the viewport transform from the previous build (zoom survives
    // note edits), then make sure every node is still in view. A null view
    // transform means this mount has never been fitted — e.g. the first effect
    // run had no data yet, or stale/corrupt saved coordinates put the nodes in
    // a corner. In that case always center the graph, never trust the saved
    // coordinates to be anywhere useful.
    if (zoomTransformRef.current) {
      svg.call(zoom.transform, zoomTransformRef.current);
      if (nodesOutOfView(zoomTransformRef.current, width, height)) {
        fitGraph(width, height, 300);
      }
    } else {
      fitGraph(width, height, 0);
    }

    // First-ever render (no saved layout): fit once the physics animation
    // settles. One-shot — post-drag simulation restarts must never reset the
    // user's zoom.
    if (isFirstRender && !hasSavedLayout) {
      simulation.on('end', () => {
        fitGraph(width, height, 400);
        simulation.on('end', null);
      });
    }

    // Live pane resizes (split view drag, AI panel resize, opening/closing the
    // graph tab): refit only when nodes would fall out of the visible area.
    const container = svgRef.current.parentElement as HTMLElement | null;
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
    };
  }, [graphData, activeNote, refreshToken]);

  // Fit all nodes into view (header button).
  const handleFitView = () => {
    const c = svgRef.current?.parentElement;
    if (c) fitGraphRef.current?.(c.clientWidth, c.clientHeight, 400);
  };

  // Re-run the physics fly-in from scratch (header button). Discards the
  // persisted layout so a corrupt/stale arrangement gets fully re-laid-out.
  const handleRefresh = () => {
    positionsRef.current = {};
    isFirstRenderRef.current = true;
    setRefreshToken((t) => t + 1);
  };

  return (
    <div className="flex-1 bg-slate-950/20 border-r border-slate-900/60 flex flex-col h-full relative select-none">
      
      {/* Header bar */}
      <div className="px-6 py-3.5 border-b border-slate-900/60 bg-slate-950/20 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-orange-400" />
          <h2 className="text-sm font-semibold text-slate-100">Knowledge Network</h2>
        </div>
        <div className="text-[10px] text-slate-500 font-medium flex items-center gap-2">
          <span className="hidden lg:block">Drag to arrange • Scroll to zoom</span>
          <button
            onClick={handleFitView}
            title="Fit all nodes in view"
            className="p-1.5 rounded-md bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50 transition-colors flex items-center gap-1"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleRefresh}
            title="Re-animate the graph"
            className="p-1.5 rounded-md bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50 transition-colors flex items-center gap-1"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* SVG Container */}
      <div className="flex-1 overflow-hidden relative">
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
