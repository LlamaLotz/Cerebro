import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import App from './App.tsx';
import { ReviewWindow } from './components/ReviewWindow.tsx';
import { IngestionProvider } from './services/ingestionStore';
import './index.css';
import './linker-test';

const isReviewWindow = getCurrentWebviewWindow().label === 'review-window';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isReviewWindow ? (
      <ReviewWindow />
    ) : (
      <IngestionProvider>
        <App />
      </IngestionProvider>
    )}
  </StrictMode>
);
