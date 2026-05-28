import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuth } from '../hooks/useAuth';
import { db } from '../db/schema';

function useSyncAge(): string {
  const meta = useLiveQuery(() => db.syncMeta.get('all'));
  return useMemo(() => {
    if (!meta?.lastSyncedAt) return '';
    const diffMs = Date.now() - new Date(meta.lastSyncedAt).getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
  }, [meta?.lastSyncedAt]);
}

export default function NavBar({
  unreviewedCount,
  onSyncRequest,
}: {
  unreviewedCount: number | null;
  onSyncRequest: () => void;
}) {
  const { signOut } = useAuth();
  const badge = unreviewedCount != null && unreviewedCount > 0 ? unreviewedCount : null;
  const syncAge = useSyncAge();

  return (
    <nav className="navbar" data-testid="nav-bar">
      <div className="navbar-brand">Zero Budget</div>
      <div className="navbar-tabs">
        <NavLink to="/plan" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          Plan
        </NavLink>
        <NavLink to="/accounts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          Transactions
        </NavLink>
        <NavLink to="/triage" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          Triage
          {badge && <span className="nav-badge">{badge}</span>}
        </NavLink>
        <NavLink to="/reflect" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          Reflect
        </NavLink>
      </div>
      <button
        className="nav-sync"
        onClick={onSyncRequest}
        title={syncAge ? `Last synced ${syncAge} — tap to sync now` : 'Sync now'}
      >
        ↻
      </button>
      <button className="nav-signout" onClick={signOut} title="Sign out">
        ⏏
      </button>
    </nav>
  );
}
