import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
// Initialises Firebase + App Check on startup, before any AI call.
import './ai/firebase';
import App from './App';

// Offline support: cache the app shell so Zamari opens without a connection.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[Zamari] Service worker failed', e));
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
