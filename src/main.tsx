import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { quantum, lineSpinner } from 'ldrs';
import App from './App.tsx';
import { ReviewWindow } from './components/ReviewWindow.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { IngestionProvider } from './services/ingestionStore';
import { DialogProvider } from './components/DialogProvider';
import './index.css';
import './linker-test';

// Register the ldrs loading animations (web components) used by the splash
// screen and other loading states across the app.
quantum.register();
lineSpinner.register();

const isReviewWindow = getCurrentWebviewWindow().label === 'review-window';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallbackTitle="Application Error">
      {isReviewWindow ? (
        <ReviewWindow />
      ) : (
        <IngestionProvider>
          <DialogProvider>
            <App />
          </DialogProvider>
        </IngestionProvider>
      )}
    </ErrorBoundary>
  </StrictMode>
);
