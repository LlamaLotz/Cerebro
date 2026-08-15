import React, { useCallback, useEffect, useRef } from 'react';

interface ResizeHandleProps {
  direction: 'vertical' | 'horizontal';
  onResize: (delta: number) => void;
  className?: string;
}

/** A draggable divider used to resize panels. `vertical` resizes a panel's
 *  height (drag up/down), `horizontal` resizes its width (drag left/right). */
export const ResizeHandle: React.FC<ResizeHandleProps> = ({ direction, onResize, className }) => {
  const startRef = useRef<number | null>(null);
  const lastDeltaRef = useRef(0);
  const draggingRef = useRef(false);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (startRef.current === null) return;
      const pos = direction === 'vertical' ? e.clientY : e.clientX;
      const delta = pos - startRef.current;
      onResize(delta - lastDeltaRef.current);
      lastDeltaRef.current = delta;
    },
    [direction, onResize]
  );

  const onUp = useCallback(() => {
    startRef.current = null;
    lastDeltaRef.current = 0;
    draggingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }, [onMove]);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startRef.current = direction === 'vertical' ? e.clientY : e.clientX;
    lastDeltaRef.current = 0;
    draggingRef.current = true;
    document.body.style.cursor = direction === 'vertical' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // If the handle unmounts mid-drag (e.g. the layout switches while the user
  // is resizing a panel), release the window listeners instead of leaking them.
  useEffect(() => {
    return () => {
      if (draggingRef.current) onUp();
    };
  }, [onUp]);

  return (
    <div
      onMouseDown={onDown}
      className={`shrink-0 ${
        direction === 'vertical' ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize'
      } hover:bg-orange-500/40 active:bg-orange-500/60 transition-colors ${className ?? ''}`}
    />
  );
};
