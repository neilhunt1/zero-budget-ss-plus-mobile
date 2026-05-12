import { useState, useCallback, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useUnreviewedCount } from './hooks/useUnreviewedCount';
import { useAppBadge } from './hooks/useAppBadge';
import AuthGate from './components/AuthGate';
import NavBar from './components/NavBar';
import OfflineBanner from './components/OfflineBanner';
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

export default function App() {
  const { isAuthenticated } = useAuth();
  const [unreviewedCount, setUnreviewedCount] = useState<number | null>(null);
  const handleCount = useCallback((n: number | null) => setUnreviewedCount(n), []);

  return (
    <HashRouter>
      <div className="app">
        {isAuthenticated && <AppBadge onCount={handleCount} />}
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
                  <Accounts unreviewedCount={unreviewedCount} />
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
    </HashRouter>
  );
}
