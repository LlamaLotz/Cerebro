import React, { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// Catches render/lifecycle errors in its subtree. Without one, a single
// component crash unmounts the whole React tree and leaves a blank screen;
// with it, the failing region shows a recoverable fallback instead.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { hasError: false, error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught component error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 bg-red-950/40 text-red-200 border border-red-500/30 rounded-lg m-4 select-text">
          <h2 className="text-lg font-bold mb-2">
            {this.props.fallbackTitle || 'Component Crashed'}
          </h2>
          <p className="text-sm font-mono bg-red-950/80 p-3 rounded border border-red-900/50 overflow-x-auto whitespace-pre-wrap">
            {this.state.error?.toString()}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-4 px-3 py-1.5 bg-red-800 hover:bg-red-700 text-white rounded text-xs font-semibold transition-colors"
          >
            Reset Component
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}