// Phase 6 Phase C2 — minimal service worker.
//
// Purpose: satisfy Chrome's PWA installability checklist (manifest +
// registered SW with a fetch handler that calls event.respondWith) so the
// "Install app" / "Add to Home Screen" banner appears on Android. Without
// this, Chrome silently skips the install prompt even though the manifest
// is fully valid.
//
// Explicit non-goal: caching. Every navigation and asset request is
// forwarded straight to the network. The team needs fresh data (live
// stats, live mail status, live bookings) — stale-while-revalidate or
// cache-first would risk wrong decisions on the dashboard. If we later
// want offline support, add a cache here and version it with a release
// constant so old entries get cleaned up on activate.

self.addEventListener('install', () => {
  // New SW takes over immediately on next page load instead of waiting
  // until every controlled tab is closed.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim already-open tabs so the new SW controls them right away.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Network passthrough only. event.respondWith is required by Chrome's
  // installability check; without it the install prompt does not appear
  // even when the manifest is otherwise perfect.
  event.respondWith(fetch(event.request));
});
