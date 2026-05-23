import { useState, useEffect } from 'react';
import { onSyncProgress, getCurrentSyncProgress, type SyncProgress as SP } from '../db/sync';

export default function SyncProgress() {
  const [progress, setProgress] = useState<SP>(getCurrentSyncProgress);

  useEffect(() => onSyncProgress(setProgress), []);

  if (progress.status === 'error') {
    return (
      <div className="sync-error-banner">
        Sync failed — check your connection
      </div>
    );
  }

  if (progress.status !== 'cold-start') return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg, #f5f5f7)',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          padding: '2rem',
          maxWidth: '320px',
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid var(--color-border, #ddd)',
            borderTopColor: 'var(--color-accent, #5c6bc0)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 1.5rem',
          }}
        />
        <p style={{ margin: '0 0 0.5rem', fontWeight: 600, fontSize: '1rem' }}>
          Setting up your local database…
        </p>
        {progress.loaded > 0 && (
          <p style={{ margin: 0, color: 'var(--color-text-secondary, #666)', fontSize: '0.875rem' }}>
            {progress.total !== null
              ? `${progress.loaded.toLocaleString()} of ${progress.total.toLocaleString()} transactions`
              : `${progress.loaded.toLocaleString()} transactions loaded`}
          </p>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
