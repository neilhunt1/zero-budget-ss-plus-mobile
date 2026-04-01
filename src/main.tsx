import React from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import App from './App';
import './app.css';

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

if (!clientId) {
  console.error(
    '[Zero Budget] VITE_GOOGLE_CLIENT_ID is not set. ' +
      'Add it to .env.development.local and restart Vite.'
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={clientId ?? ''}>
      <App />
    </GoogleOAuthProvider>
  </React.StrictMode>
);
