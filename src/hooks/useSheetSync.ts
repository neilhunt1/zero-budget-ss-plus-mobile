import { useEffect, useRef } from 'react';
import { db } from '../db/schema';
import { syncOnOpen } from '../db/sync';
import { AuthError } from '../api/client';
import { useAuth } from './useAuth';

// `version` is a monotonically increasing integer that increments on every
// server-side change to the file — much more responsive than `modifiedTime`,
// which Google batches and can lag by minutes on Sheets edits.
const DRIVE_FILE_URL = (fileId: string) =>
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=version`;

/**
 * Polls the Google Drive file metadata API every `intervalMs` milliseconds.
 * When the sheet's version changes (compared to the stored IndexedDB syncMeta),
 * triggers a full sync into IndexedDB and increments the returned `revision`
 * counter — add it to a useCallback's dependency array to re-fetch from Sheets.
 *
 * On first ever load (no syncMeta), a cold-start sync runs and shows the
 * SyncProgress overlay (via the onSyncProgress event system in db/sync.ts).
 *
 * Requirements:
 *   - OAuth token must include the `drive.metadata.readonly` scope.
 *   - VITE_GOOGLE_SHEET_ID env var must be set.
 *
 * Graceful degradation:
 *   - If the token lacks the Drive scope (403), polling is silently disabled
 *     for the rest of the session — the app still works, just without auto-refresh.
 *   - Network errors are ignored; the next tick will retry.
 *
 * Performance:
 *   - Polling pauses automatically when the page is hidden (Page Visibility API).
 *   - If the stored IndexedDB version matches Drive, the sync is skipped entirely.
 */
export function useSheetSync(token: string | null, intervalMs = 15_000): void {
  const { notifySessionExpired } = useAuth();
  const disabledRef = useRef(false); // set true if Drive scope is missing (403)
  const syncingRef = useRef(false);  // prevent concurrent syncs
  const sheetId = import.meta.env.VITE_GOOGLE_SHEET_ID as string | undefined;
  // Exposed so the SW message listener can trigger a check without closing over stale state.
  const checkRef = useRef<(() => void) | null>(null);

  // Register PWA periodic background sync (Chrome/Edge only).
  // When the periodicsync event fires in the SW, it messages active clients,
  // and this listener triggers a Drive version check + sync if stale.
  useEffect(() => {
    navigator.serviceWorker?.ready
      .then((reg) => {
        if ('periodicSync' in reg) {
          return (reg as unknown as { periodicSync: { register(tag: string, opts: object): Promise<void> } })
            .periodicSync.register('budget-sync', { minInterval: 12 * 60 * 60 * 1000 });
        }
      })
      .catch(() => {
        // periodicSync not supported or permission denied — silent fallback.
        // The app still syncs on every open via the Drive version poll.
      });

    const handleSWMessage = (event: MessageEvent) => {
      if (event.data?.type === 'PERIODIC_SYNC') {
        checkRef.current?.();
      }
    };
    navigator.serviceWorker?.addEventListener('message', handleSWMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleSWMessage);
    };
  }, []);

  useEffect(() => {
    if (!token || !sheetId || disabledRef.current) return;

    async function checkForChanges() {
      if (document.hidden) return;
      if (disabledRef.current || syncingRef.current) return;

      try {
        const res = await fetch(DRIVE_FILE_URL(sheetId!), {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.status === 403) {
          disabledRef.current = true;
          console.debug('[useSheetSync] Drive metadata scope not available; auto-refresh disabled.');
          return;
        }

        if (res.status === 401) { notifySessionExpired(); return; }
        if (!res.ok) return;            // transient error — retry next tick

        const data = (await res.json()) as { version?: string };
        const { version } = data;
        if (!version) return;

        // Compare against what we last synced. syncOnOpen short-circuits if already current.
        const lastSync = await db.syncMeta.get('all');
        if (lastSync?.lastSheetVersion === version) return;

        syncingRef.current = true;
        try {
          await syncOnOpen(token!, sheetId!, version);
        } finally {
          syncingRef.current = false;
        }
      } catch (e) {
        syncingRef.current = false;
        if (e instanceof AuthError) notifySessionExpired();
        // else: network/sync error — ignore, retry on next interval.
      }
    }

    checkRef.current = checkForChanges;

    const handleVisibilityChange = () => {
      if (!document.hidden) checkForChanges();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    checkForChanges();
    const timerId = setInterval(checkForChanges, intervalMs);
    return () => {
      checkRef.current = null;
      clearInterval(timerId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [token, sheetId, intervalMs]);
}
