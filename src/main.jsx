import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './font-subsets.css';
import './styles.css';

// Register the production shell on first visit so that an installable PWA is
// available before opening the offline panel. The download action still checks
// that the worker actually controls the page and the shell is ready.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Browsers may reject registration (private mode, storage policy, etc.).
    // prepareOfflineEngine reports a useful error if a download is requested.
  });
}

createRoot(document.getElementById('root')).render(<App />);
