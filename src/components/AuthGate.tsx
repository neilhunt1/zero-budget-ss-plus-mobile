import { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';

interface Props {
  children: ReactNode;
}

/**
 * Renders children only when the user is authenticated.
 * Otherwise shows a sign-in prompt.
 */
export default function AuthGate({ children }: Props) {
  const { isAuthenticated, login } = useAuth();

  if (!isAuthenticated) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <h1 className="auth-title">Zero Budget</h1>
          <p className="auth-subtitle">Sign in with Google to access your budget.</p>
          <button className="btn-primary" onClick={() => login()}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
