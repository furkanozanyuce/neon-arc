// IMPORTANT: storage-shim must be imported before App.jsx,
// because App's module-scope helpers call window.storage on mount.
import './storage-shim.js';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
