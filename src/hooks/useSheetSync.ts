import { useEffect, useRef, useState } from 'react';

// `version` is a monotonically increasing integer that increments on every
// server-side change to the file — much more responsive than `modifiedTime`,
// which Google batches and can lag by minutes on Sheets edits.
const DRIVE_FILE_URL = (fileId: string) =>
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=version`;

/**
 * Polls the Google Drive file metadata API every `intervalMs` milliseconds.
 * When the sheet's version number changes, the returned `revision` counter
 * increments — add it to a useCallback's dependency array to trigger a
 * data re-fetch automatically.
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
 *   - The first successful call only records a baseline and does NOT trigger
 *     a revision bump — avoids a redundant re-fetch on mount.
 */
export function useSheetSync(token: string | null, intervalMs = 15_000): number {
  const [revision, setRevision] = useState(0);
  const lastModifiedRef = useRef<string | null>(null);
  const disabledRef = useRef(false); // set true if scope is missing (403)
  const sheetId = import.meta.env.VITE_GOOGLE_SHEET_ID as string | undefined;

  useEffect(() => {
    if (!token || !sheetId || disabledRef.current) return;

    async function checkForChanges() {
      // Pause when tab is backgrounded — resume on next tick when visible again.
      if (document.hidden) return;
      if (disabledRef.current) return;

      try {
        const res = await fetch(DRIVE_FILE_URL(sheetId!), {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.status === 403 || res.status === 401) {
          // Drive scope not granted — disable polling silently.
          disabledRef.current = true;
          console.debug('[useSheetSync] Drive metadata scope not available; auto-refresh disabled.');
          return;
        }

        if (!res.ok) return; // transient error — retry next tick

        const data = (await res.json()) as { version?: string };
        const { version } = data;
        if (!version) return;

        if (lastModifiedRef.current === null) {
          // First successful call — record baseline, don't bump revision.
          lastModifiedRef.current = version;
          return;
        }

        if (version !== lastModifiedRef.current) {
          lastModifiedRef.current = version;
          setRevision((r) => r + 1);
        }
      } catch {
        // Network error — ignore, retry on next interval.
      }
    }

    checkForChanges(); // run immediately on mount / token change
    const timerId = setInterval(checkForChanges, intervalMs);
    return () => clearInterval(timerId);
  }, [token, sheetId, intervalMs]);

  return revision;
}
