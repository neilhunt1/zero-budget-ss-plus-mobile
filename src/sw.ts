import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope;

// With injectManifest strategy the developer owns the SW lifecycle.
// These two calls are required for registerType: 'autoUpdate' to work —
// without them the new SW installs but waits in "waiting" state until every
// tab is closed, so users keep seeing the old cached app.
self.skipWaiting();
clientsClaim();

// VitePWA injects the precache manifest here at build time.
precacheAndRoute(self.__WB_MANIFEST);
// Remove caches left behind by previous SW versions.
cleanupOutdatedCaches();

// Periodic background sync — Chrome/Edge only.
// On iOS Safari the next app open triggers a regular Drive-poll sync (acceptable).
// When the event fires the page may not be open, so we notify any active window
// clients to run a sync with their stored OAuth token. If no clients are open
// the sync is deferred until the next app open — the Drive version check in
// useSheetSync will detect the stale version and sync immediately.
self.addEventListener('periodicsync', (event: Event) => {
  const syncEvent = event as Event & { tag: string; waitUntil: (p: Promise<unknown>) => void };
  if (syncEvent.tag === 'budget-sync') {
    syncEvent.waitUntil(
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => {
          clients.forEach((client) => client.postMessage({ type: 'PERIODIC_SYNC' }));
        })
    );
  }
});
