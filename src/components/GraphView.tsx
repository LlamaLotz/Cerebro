import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { NoteFile, GraphNode, GraphLink } from '../types';
import { Network, Home, RotateCw } from 'lucide-react';

// Path normalization: link endpoints come from raw [[wiki-link]] text and
// note paths (Windows `\` separators, `.md` suffixes, mixed casing) while D3
// matches ids exactly. Normalizing everything to one canonical form keeps
// forceLink resolution + coordinate lookup consistent across view rebuilds.
const normalizeKey = (str: any): string => {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/\\/g, '/') // Convert Windows backslashes \ to /
    .replace(/\.md$/, '') // Remove .md extension
    .trim();
};

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const simulationRef = useRef<d3.Simulation<any, any> | null>(null);
  // Latest fit-all-nodes function, exposed for the header reset button so it
  // can refit once its re-animation settles.
  const fitAllNodesRef = useRef<() => void>(() => {});

  const POSITIONS_KEY = 'cerebro_graph_positions';

  // Load saved positions safely
  const loadPositions = (): Record<string, { x: number; y: number }> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
      const entries = Object.values(parsed) as Array<{ x: number; y: number }>;
      const zeroes = entries.filter((p) => p && (p.x === 0 || p.y === 0)).length;
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
      if (Number.isFinite(n.x) && Number.isFinite(n.y) && (n.x !== 0 || n.y !== 0)) {
        const key = n.id || n.title || n.path;
        if (key) positions[key] = { x: n.x, y: n.y };
      }
    }
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
    } catch {
      // Storage unavailable
    }
  };

  const selectNoteRef = useRef(onSelectNoteByTitle);
  useEffect(() => {
    selectNoteRef.current = onSelectNoteByTitle;
  }, [onSelectNoteByTitle]);

  const getDimensions = () => {
    const w = containerRef.current?.clientWidth || 0;
    const h = containerRef.current?.clientHeight || 0;
    return {
      width: w > 100 ? w : Math.max(600, window.innerWidth - 320),
      height: h > 100 ? h : Math.max(400, window.innerHeight - 80),
    };
  };

  useEffect(() => {
    if (!svgRef.current) return;

    const { nodes, links } = graphData;
    if (!nodes || nodes.length === 0) return;

    // Deep copy data for D3 mutation. Link endpoints are normalized to a
    // canonical key (case-insensitive, POSIX path, no .md) so they always
    // match the node map — a raw [[wiki-link]] or Windows path that only
    // differs in casing/separators would otherwise detach to the pane center
    // and disconnect when the view rebuilds.
    //
    // An endpoint may also arrive as a node OBJECT reference: react-force-
    // graph-3d mutates the shared graphData in place (forceLink swaps string
    // ids for node objects carrying 3D coordinates), so passing those objects
    // straight through would draw 2D links at stale 3D positions, away from
    // the rendered nodes. Reducing them to a key makes forceLink re-resolve
    // against the current 2D node set via the .id accessor below.
    const endpointKey = (v: any): string => {
      if (v && typeof v === 'object') return normalizeKey(v.id || v.title || v.path);
      return normalizeKey(v);
    };
    const d3Nodes: any[] = nodes.map((d) => ({ ...d }));
    // Only keep links whose endpoints resolve to a node in this render:
    // d3-force's forceLink throws "missing: <id>" on unresolvable endpoints,
    // which would crash the whole graph pane (the Rust snapshot can race a
    // re-index, and cross-view object refs can be stale). Self-links collapse
    // to the same key after normalization and are dropped too.
    const nodeKeys = new Set<string>();
    d3Nodes.forEach((n: any) => {
      if (n.id) nodeKeys.add(normalizeKey(n.id));
      if (n.title) nodeKeys.add(normalizeKey(n.title));
      if (n.path) nodeKeys.add(normalizeKey(n.path));
    });
    const d3Links: any[] = links
      .map((d) => ({
        ...d,
        source: endpointKey(d.source),
        target: endpointKey(d.target),
      }))
      .filter(
        (l) =>
          !!l.source &&
          !!l.target &&
          l.source !== l.target &&
          nodeKeys.has(l.source) &&
          nodeKeys.has(l.target)
      );

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // Clear previous rendering

    const { width, height } = getDimensions();
    svg.attr('width', '100%').attr('height', '100%');

    const savedPositions = loadPositions();

    // 1. Position Seeding: Use saved positions as starting hints ONLY (No hard fx/fy pins)
    const seedCount = d3Nodes.length || 1;
    d3Nodes.forEach((node: any, i: number) => {
      const key = node.id || node.title || node.path;
      const p = key ? savedPositions[key] : undefined;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x !== 0 && p.y !== 0) {
        node.x = p.x;
        node.y = p.y;
      } else {
        // Radial spread around canvas center to prevent top-left (0,0) clumping
        const angle = (i / seedCount) * 2 * Math.PI;
        const radius = 140 + Math.random() * 80;
        node.x = width / 2 + radius * Math.cos(angle);
        node.y = height / 2 + radius * Math.sin(angle);
      }
      // Ensure nodes are NOT pinned so physics can spread them apart
      node.fx = null;
      node.fy = null;
    });

    // 2. Container group for zoom & pan
    const gContainer = svg.append('g').attr('class', 'graph-container');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 3.5])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        gContainer.attr('transform', event.transform.toString());
      });

    svg.call(zoom);
    zoomBehaviorRef.current = zoom;

    // 3. Force Physics Simulation: Strong repulsion + Collision to prevent clumping
    const simulation = d3.forceSimulation<any>(d3Nodes)
      .force('link', d3.forceLink<any, any>(d3Links)
        .id((d: any) => normalizeKey(d.id || d.title || d.path))
        .distance(110)
      )
      .force('charge', d3.forceManyBody().strength(-450))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.8))
      .force('collision', d3.forceCollide().radius((d: any) => Math.max(22, (d.linksCount || 1) * 2 + 16)))
      .force('x', d3.forceX(width / 2).strength(0.04))
      .force('y', d3.forceY(height / 2).strength(0.04));

    simulationRef.current = simulation;

    // Pre-warm physics for 40 ticks so layout spreads before initial paint
    for (let i = 0; i < 40; ++i) {
      simulation.tick();
    }

    // 4. Draw Link Edges with crisp slate-400 visibility
    const linkElements = gContainer.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(d3Links)
      .enter()
      .append('line')
      .attr('stroke', '#64748b') // Slate-500
      .attr('stroke-opacity', 0.5)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', (d: any) => (d.targetExists === false ? '4,4' : 'none'));

    // 5. Draw Node Vertices
    const nodeElements = gContainer.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(d3Nodes)
      .enter()
      .append('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, any>()
          .on('start', (event: any, d: any) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event: any, d: any) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event: any, d: any) => {
            if (!event.active) simulation.alphaTarget(0);
            savePositions(d3Nodes);
          })
      );

    // Node Circle
    nodeElements.append('circle')
      .attr('r', (d: any) => Math.max(7, Math.min(20, (d.linksCount || 1) * 1.8 + 6)))
      .attr('fill', (d: any) => {
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        if (isCurrent) return '#f97316'; // Active (Orange-500)
        return d.exists !== false ? '#fb923c' : '#475569';
      })
      .attr('stroke', (d: any) => {
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? '#ffffff' : '#c2410c';
      })
      .attr('stroke-width', (d: any) => {
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? 2.5 : 1;
      });

    // Node Text Labels
    nodeElements.append('text')
      .text((d: any) => d.title || d.id || 'Untitled')
      .attr('dx', 14)
      .attr('dy', 4)
      .attr('font-size', '11px')
      .attr('font-weight', '500')
      .attr('fill', (d: any) => {
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? '#ffffff' : '#cbd5e1';
      })
      .attr('pointer-events', 'none')
      .style('text-shadow', '0 1px 4px rgba(0,0,0,0.9)');

    // Node Interactivity
    nodeElements.on('click', (_event: any, d: any) => {
      if (d.title || d.id) {
        selectNoteRef.current(d.title || d.id);
      }
    });

    nodeElements.on('mouseover', function (this: SVGGElement, _event: any, d: any) {
      d3.select(this).select('circle')
        .transition()
        .duration(150)
        .attr('r', Math.max(10, Math.min(24, (d.linksCount || 1) * 1.8 + 10)))
        .attr('fill', '#ea580c');

      d3.select(this).select('text')
        .transition()
        .duration(150)
        .attr('font-size', '12px')
        .attr('fill', '#ffffff');
    })
    .on('mouseout', function (this: SVGGElement, _event: any, d: any) {
      const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
      
      d3.select(this).select('circle')
        .transition()
        .duration(150)
        .attr('r', Math.max(7, Math.min(20, (d.linksCount || 1) * 1.8 + 6)))
        .attr('fill', isCurrent ? '#f97316' : (d.exists !== false ? '#fb923c' : '#475569'));

      d3.select(this).select('text')
        .transition()
        .duration(150)
        .attr('font-size', '11px')
        .attr('fill', isCurrent ? '#ffffff' : '#cbd5e1');
    });

    // 6. Safe Link Coordinate Resolution
    const nodeMap = new Map<string, any>();
    d3Nodes.forEach((n: any) => {
      if (n.id) nodeMap.set(normalizeKey(n.id), n);
      if (n.title) nodeMap.set(normalizeKey(n.title), n);
      if (n.path) nodeMap.set(normalizeKey(n.path), n);
    });

    const getCoord = (sourceOrTarget: any, axis: 'x' | 'y'): number => {
      if (typeof sourceOrTarget === 'object' && sourceOrTarget !== null && axis in sourceOrTarget) {
        const val = sourceOrTarget[axis];
        return Number.isFinite(val) ? val : (axis === 'x' ? width / 2 : height / 2);
      }
      if (typeof sourceOrTarget === 'string' || typeof sourceOrTarget === 'number') {
        const found = nodeMap.get(normalizeKey(sourceOrTarget));
        if (found && Number.isFinite(found[axis])) return found[axis];
      }
      return axis === 'x' ? width / 2 : height / 2;
    };

    // Simulation Tick Update
    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d: any) => getCoord(d.source, 'x'))
        .attr('y1', (d: any) => getCoord(d.source, 'y'))
        .attr('x2', (d: any) => getCoord(d.target, 'x'))
        .attr('y2', (d: any) => getCoord(d.target, 'y'));

      nodeElements.attr('transform', (d: any) => `translate(${d.x || width / 2}, ${d.y || height / 2})`);
    });

    // Save positions when simulation ends
    simulation.on('end', () => {
      savePositions(d3Nodes);
    });

    // 7. Fit ALL nodes into the pane on startup / opening the graph view. The
    // previous behavior centered on the ACTIVE note at 1.25x, which zoomed in
    // so far the rest of the network fell out of view. Compute the bounding
    // box of every node and fit it to the pane with padding instead, so the
    // whole graph is always visible at once.
    const fitAllNodes = () => {
      if (d3Nodes.length === 0) return;
      const xs = d3Nodes.map((d: any) => d.x).filter(Number.isFinite);
      const ys = d3Nodes.map((d: any) => d.y).filter(Number.isFinite);
      if (xs.length === 0 || ys.length === 0) return;

      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const bw = Math.max(maxX - minX, 100);
      const bh = Math.max(maxY - minY, 100);
      // Fit with padding and allow zooming IN (up to 2.5x) so a compact graph
      // fills the pane instead of floating small in empty space. The bounding
      // box math still guarantees every node stays in view.
      const scale = Math.max(
        0.1,
        Math.min(2.5, Math.min((width - 160) / bw, (height - 160) / bh))
      );
      const transform = d3.zoomIdentity
        .translate(width / 2 - (minX + bw / 2) * scale, height / 2 - (minY + bh / 2) * scale)
        .scale(scale);

      svg.transition()
        .duration(600)
        .ease(d3.easeCubicOut)
        .call(zoom.transform, transform);
    };
    fitAllNodesRef.current = fitAllNodes;

    // Fit immediately once the layout is roughly in place, then again when the
    // simulation settles so the final spread always fits the pane (nodes keep
    // drifting while the physics animate past the first fit).
    const fitTimer = setTimeout(fitAllNodes, 120);
    simulation.on('end.fitInitial', () => {
      simulation.on('end.fitInitial', null);
      fitAllNodes();
    });

    return () => {
      clearTimeout(fitTimer);
      simulation.stop();
    };
  }, [graphData, activeNote]);

  // Header Manual Reset Button
  const handleResetGraph = () => {
    localStorage.removeItem(POSITIONS_KEY);
    localStorage.removeItem('cerebro_graph_zoom');
    
    // Fit the whole graph into view immediately — the old behavior zoomed to
    // identity (pane center only), so Home appeared to shrink the graph to
    // the middle instead of covering every node.
    fitAllNodesRef.current();

    if (simulationRef.current) {
      simulationRef.current.alpha(1).restart();
      // Nodes drift while the re-animation runs — refit once it settles so
      // the final spread still covers the whole pane.
      simulationRef.current.on('end.resetFit', () => {
        simulationRef.current?.on('end.resetFit', null);
        fitAllNodesRef.current();
      });
    }
  };

  return (
    <div
      data-region="graph"
      className="flex-1 bg-slate-950/40 border-r border-slate-900/60 flex flex-col h-full relative select-none overflow-hidden"
    >
      {/* Header bar */}
      <div className="px-6 py-3.5 border-b border-slate-900/60 bg-slate-950/60 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-orange-400" />
          <h2 className="text-sm font-semibold text-slate-100">Knowledge Network</h2>
        </div>
        <div className="text-[10px] text-slate-500 font-medium flex items-center gap-2">
          {toolbarExtra}
          <span className="hidden lg:block">Drag to arrange • Scroll to zoom</span>
          <button
            onClick={handleResetGraph}
            title="Reset graph view & re-arrange nodes"
            className="p-1.5 rounded-md bg-slate-900/80 border border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50 transition-colors flex items-center gap-1"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResetGraph}
            title="Re-animate physics simulation"
            className="p-1.5 rounded-md bg-slate-900/80 border border-slate-800/80 text-slate-400 hover:text-orange-400 hover:border-orange-500/50 transition-colors flex items-center gap-1"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* SVG Container */}
      <div ref={containerRef} className="flex-1 overflow-hidden relative w-full h-full">
        <svg ref={svgRef} className="w-full h-full block" />

        {/* Legend */}
        <div className="absolute bottom-4 left-4 bg-slate-900/90 border border-slate-800/80 px-3.5 py-2.5 rounded-xl shadow-lg text-[10px] space-y-1.5 backdrop-blur-md z-10">
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