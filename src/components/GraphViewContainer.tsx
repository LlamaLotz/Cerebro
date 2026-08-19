import React, { useState } from 'react';
import { GraphView } from './GraphView';
import { GraphView3D } from './GraphView3D';
import { GraphNode, GraphLink, NoteFile } from '../types';

const GRAPH_MODE_KEY = 'cerebro_graph_mode';

interface GraphViewContainerProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
}

/**
 * Hosts the knowledge graph pane and its 2D/3D mode switcher. The choice is
 * persisted (cerebro_graph_mode) so the graph reopens in the same mode. The
 * mode state lives here so the segmented control can be injected into either
 * graph component's toolbar header (toolbarExtra) while the graph bodies stay
 * self-contained.
 */
export const GraphViewContainer: React.FC<GraphViewContainerProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
}) => {
  // Default to 3D; a user who explicitly picked 2D (key stored) keeps their
  // choice.
  const [graphMode, setGraphMode] = useState<'2d' | '3d'>(
    () => (localStorage.getItem(GRAPH_MODE_KEY) === '2d' ? '2d' : '3d')
  );

  const switchMode = (mode: '2d' | '3d') => {
    setGraphMode(mode);
    localStorage.setItem(GRAPH_MODE_KEY, mode);
  };

  const toggle = (
    <div className="flex items-center bg-neutral-900 p-1 rounded-lg border border-neutral-800">
      <button
        onClick={() => switchMode('2d')}
        className={`px-3 py-1 text-xs rounded-md transition-colors ${
          graphMode === '2d'
            ? 'bg-orange-500/90 text-neutral-950 font-medium'
            : 'text-neutral-400 hover:text-neutral-200'
        }`}
      >
        2D Graph
      </button>
      <button
        onClick={() => switchMode('3d')}
        className={`px-3 py-1 text-xs rounded-md transition-colors ${
          graphMode === '3d'
            ? 'bg-orange-500/90 text-neutral-950 font-medium'
            : 'text-neutral-400 hover:text-neutral-200'
        }`}
      >
        3D Graph
      </button>
    </div>
  );

  return graphMode === '2d' ? (
    <GraphView
      graphData={graphData}
      activeNote={activeNote}
      onSelectNoteByTitle={onSelectNoteByTitle}
      toolbarExtra={toggle}
    />
  ) : (
    <GraphView3D
      graphData={graphData}
      activeNote={activeNote}
      onSelectNoteByTitle={onSelectNoteByTitle}
      toolbarExtra={toggle}
    />
  );
};
