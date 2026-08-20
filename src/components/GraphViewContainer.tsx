import React, { useState } from 'react';
import { GraphView } from './GraphView';
import { GraphView3D } from './GraphView3D';
import { GraphNode, GraphLink, NoteFile } from '../types';

const GRAPH_MODE_KEY = 'prism_graph_mode';

interface GraphViewContainerProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
  /** Appearance setting: which backdrop pattern the graph pane draws. */
  backgroundPattern: 'grid' | 'mesh' | 'solid';
  /** Appearance setting: the 2D/3D mode to open in (unless the user has
   *  explicitly picked one before — that choice is persisted and wins). */
  defaultGraphMode: '2d' | '3d';
  /** Linking setting: whether the 2D graph persists dragged node positions. */
  persistNodePositions: boolean;
  /** Appearance settings: auto-rotate the 3D camera on load + its speed. */
  autoRotateOnLoad: boolean;
  autoRotateSpeed: number;
  /** Appearance setting: 3D label billboard DPI ('high' = up to 3x, crisp). */
  labelQuality: 'standard' | 'high';
}

/**
 * Hosts the knowledge graph pane and its 2D/3D mode switcher. The choice is
 * persisted (prism_graph_mode) so the graph reopens in the same mode. The
 * mode state lives here so the segmented control can be injected into either
 * graph component's toolbar header (toolbarExtra) while the graph bodies stay
 * self-contained.
 */
export const GraphViewContainer: React.FC<GraphViewContainerProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
  backgroundPattern = 'grid',
  defaultGraphMode = '3d',
  persistNodePositions = true,
  autoRotateOnLoad = false,
  autoRotateSpeed = 0.67,
  labelQuality = 'high',
}) => {
  // Open in the configured default mode; a user who explicitly picked a mode
  // before (key stored) keeps their choice.
  const [graphMode, setGraphMode] = useState<'2d' | '3d'>(
    () =>
      (localStorage.getItem(GRAPH_MODE_KEY) === '2d' ||
      localStorage.getItem(GRAPH_MODE_KEY) === '3d'
        ? localStorage.getItem(GRAPH_MODE_KEY)
        : defaultGraphMode) as '2d' | '3d'
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
      backgroundPattern={backgroundPattern}
      persistNodePositions={persistNodePositions}
    />
  ) : (
    <GraphView3D
      graphData={graphData}
      activeNote={activeNote}
      onSelectNoteByTitle={onSelectNoteByTitle}
      toolbarExtra={toggle}
      backgroundPattern={backgroundPattern}
      autoRotateOnLoad={autoRotateOnLoad}
      autoRotateSpeed={autoRotateSpeed}
      labelQuality={labelQuality}
    />
  );
};
