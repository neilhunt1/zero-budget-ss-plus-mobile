import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// VitePWA injects the precache manifest here at build time.
precacheAndRoute(self.__WB_MANIFEST);

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
