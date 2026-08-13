import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { NoteFile, GraphNode, GraphLink } from '../types';
import { buildGraphData } from '../utils/markdownParser';
import { Network, HelpCircle } from 'lucide-react';

interface GraphViewProps {
  notes: NoteFile[];
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
}

export const GraphView: React.FC<GraphViewProps> = ({
  notes,
  activeNote,
  onSelectNoteByTitle,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Keep the latest callback in a ref so graph rebuilds are never triggered by
  // callback identity changes (the expensive D3 simulation only re-runs when
  // the debounced notes/activeNote props actually change).
  const selectNoteRef = useRef(onSelectNoteByTitle);
  useEffect(() => {
    selectNoteRef.current = onSelectNoteByTitle;
  }, [onSelectNoteByTitle]);

  useEffect(() => {
    if (!svgRef.current) return;

    // 1. Build graph nodes and links using our utility
    const { nodes, links } = buildGraphData(notes);

    // Deep copy data so D3 can mutate it for simulation
    const d3Nodes = nodes.map((d) => ({ ...d }));
    const d3Links = links.map((d) => ({ ...d }));

    // 2. Select SVG and establish dimensions
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // clear previous renders

    const width = svgRef.current.parentElement?.clientWidth || 600;
    const height = svgRef.current.parentElement?.clientHeight || 500;
    
    svg.attr('width', '100%').attr('height', '100%');

    // 3. Create a container group for zooming
    const gContainer = svg.append('g');

    // Add Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        gContainer.attr('transform', event.transform);
      });
    
    svg.call(zoom);

    // 4. Create simulation forces
    const simulation = d3.forceSimulation<any>(d3Nodes)
      .force('link', d3.forceLink<any, any>(d3Links)
        .id((d) => d.id)
        .distance(120)
      )
      .force('charge', d3.forceManyBody().strength(-150))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: any) => Math.max(12, d.linksCount * 1.5 + 10)));

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
      d.fx = null;
      d.fy = null;
    }

    // Zoom-to-fit double click trigger
    svg.on('dblclick.zoom', null); // disable default double click zoom

    return () => {
      simulation.stop();
    };
  }, [notes, activeNote]);

  return (
    <div className="flex-1 bg-slate-950/20 border-r border-slate-900/60 flex flex-col h-full relative select-none">
      
      {/* Header bar */}
      <div className="px-6 py-3.5 border-b border-slate-900/60 bg-slate-950/20 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-orange-400" />
          <h2 className="text-sm font-semibold text-slate-100">Knowledge Network</h2>
        </div>
        <div className="text-[10px] text-slate-500 font-medium flex items-center gap-1">
          <HelpCircle className="w-3 h-3 text-slate-600" /> Drag to arrange • Scroll to zoom • Click note to open
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
