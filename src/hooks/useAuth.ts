import { useState } from 'react';
import { useGoogleLogin, googleLogout } from '@react-oauth/google';

const TOKEN_KEY = 'zb_access_token';
const EXPIRY_KEY = 'zb_token_expiry';

/** Google Sheets OAuth scope required by this app. */
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function getStoredToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(EXPIRY_KEY);
  if (token && expiry && Date.now() < parseInt(expiry, 10)) return token;
  return null;
}

export interface AuthState {
  token: string | null;
  isAuthenticated: boolean;
  /** Opens the Google OAuth popup. */
  login: () => void;
  signOut: () => void;
}

/**
 * Manages Google OAuth token state.
 * Persists the access token in localStorage so it survives page refreshes
 * within the token's lifetime (~1 hour).
 *
 * Must be used inside <GoogleOAuthProvider>.
 */
export function useAuth(): AuthState {
  const [token, setToken] = useState<string | null>(getStoredToken);

  const login = useGoogleLogin({
    scope: SHEETS_SCOPE,
    onSuccess: (response) => {
      const expiry = Date.now() + response.expires_in * 1000;
      localStorage.setItem(TOKEN_KEY, response.access_token);
      localStorage.setItem(EXPIRY_KEY, String(expiry));
      setToken(response.access_token);
    },
    onError: (error) => {
      console.error('Google login error:', error);
    },
  });

  const signOut = () => {
    googleLogout();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRY_KEY);
    setToken(null);
  };

  return { token, isAuthenticated: !!token, login, signOut };
}
