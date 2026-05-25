import { useState, useCallback, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, AuthProvider } from './hooks/useAuth';
import { useSheetSync } from './hooks/useSheetSync';
import { useUnreviewedCount } from './hooks/useUnreviewedCount';
import { useAppBadge } from './hooks/useAppBadge';
import AuthGate from './components/AuthGate';
import NavBar from './components/NavBar';
import OfflineBanner from './components/OfflineBanner';
import SyncProgress from './components/SyncProgress';
import Plan from './screens/Plan';
import Accounts from './screens/Accounts';
import Reflect from './screens/Reflect';
import Triage from './screens/Triage';

function AppBadge({ onCount }: { onCount: (n: number | null) => void }) {
  const count = useUnreviewedCount();
  useAppBadge(count);
  useEffect(() => { onCount(count); }, [count, onCount]);
  return null;
}

/** Inner shell — renders inside AuthProvider so useAuth() works. */
function AppInner() {
  const { isAuthenticated, token } = useAuth();
  useSheetSync(token); // Drive polling — writes to IndexedDB; screens react via useLiveQuery
  const [unreviewedCount, setUnreviewedCount] = useState<number | null>(null);
  const handleCount = useCallback((n: number | null) => setUnreviewedCount(n), []);

  return (
    <div className="app">
      {isAuthenticated && <AppBadge onCount={handleCount} />}
      <SyncProgress />
      <OfflineBanner />
      {isAuthenticated && <NavBar unreviewedCount={unreviewedCount} />}
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Navigate to="/plan" replace />} />
          <Route
            path="/plan"
            element={
              <AuthGate>
                <Plan />
              </AuthGate>
            }
          />
          <Route
            path="/accounts"
            element={
              <AuthGate>
                <Accounts />
              </AuthGate>
            }
          />
          <Route
            path="/reflect"
            element={
              <AuthGate>
                <Reflect />
              </AuthGate>
            }
          />
          <Route
            path="/triage"
            element={
              <AuthGate>
                <Triage />
              </AuthGate>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

/** Outer shell — sets up providers, then renders AppInner. */
export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </HashRouter>
  );
}
