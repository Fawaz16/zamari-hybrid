import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
// Initialises Firebase + App Check on startup, before any AI call.
import './ai/firebase';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
