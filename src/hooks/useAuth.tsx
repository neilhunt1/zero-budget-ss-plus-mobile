import { createContext, useContext, useState, ReactNode } from 'react';
import { useGoogleLogin, googleLogout } from '@react-oauth/google';

const TOKEN_KEY = 'zb_access_token';
const EXPIRY_KEY = 'zb_token_expiry';

/** Google Sheets OAuth scope required by this app. */
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Drive metadata scope — used by useSheetSync to poll modifiedTime for
 * auto-refresh. Must be enabled in Google Cloud Console → OAuth consent screen.
 * If the token lacks this scope the hook degrades gracefully (no auto-refresh).
 */
const DRIVE_METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';

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

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthState | null>(null);

/**
 * Provides a single shared auth state to the entire app.
 * Must be rendered inside <GoogleOAuthProvider> so that useGoogleLogin works.
 *
 * Previously, every component that called useAuth() got its own useState,
 * so a login triggered in AuthGate didn't update the token in App.tsx and
 * the NavBar stayed hidden until a page refresh.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(getStoredToken);

  const login = useGoogleLogin({
    scope: `${SHEETS_SCOPE} ${DRIVE_METADATA_SCOPE}`,
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

  return (
    <AuthContext.Provider value={{ token, isAuthenticated: !!token, login, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns the shared auth state.
 * All callers share the same token — updating it in one place (e.g. AuthGate)
 * immediately reflects everywhere (e.g. App.tsx → NavBar).
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
