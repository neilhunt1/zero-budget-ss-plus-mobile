import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';

function formatSyncAge(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

export default function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const syncMeta = useLiveQuery(() => db.syncMeta.get('all'));

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  // Only show if offline AND we have cached data (syncMeta populated).
  // If no syncMeta, the app has no local data and the banner would be misleading.
  if (!offline || !syncMeta) return null;

  return (
    <div className="offline-banner" role="alert">
      Offline — showing data synced {formatSyncAge(syncMeta.lastSyncedAt)}
    </div>
  );
}
