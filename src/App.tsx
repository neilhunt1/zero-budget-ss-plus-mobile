import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import AuthGate from './components/AuthGate';
import NavBar from './components/NavBar';
import Plan from './screens/Plan';
import Accounts from './screens/Accounts';
import Reflect from './screens/Reflect';

export default function App() {
  const { isAuthenticated } = useAuth();

  return (
    <HashRouter>
      <div className="app">
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
          </Routes>
        </main>
        {isAuthenticated && <NavBar />}
      </div>
    </HashRouter>
  );
}
