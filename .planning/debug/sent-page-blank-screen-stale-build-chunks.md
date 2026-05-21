---
status: awaiting_human_verify
trigger: "Web app at mail.skale.club shows blank screen when navigating to Sent page for info@skale.club. Console shows MIME type errors — browser tries to load old JS chunk (SentPage-DsScGhek.js) that no longer exists in the current build."
created: 2026-05-03T00:00:00Z
updated: 2026-05-03T00:01:00Z
---

## Current Focus

hypothesis: CONFIRMED — Browser has a stale Service Worker (from an older build) that is serving a cached index.html referencing old chunk hashes (SentPage-DsScGhek.js). The new SW (from the current build) cannot self-activate because the stale SW is still controlling the page. The AppErrorBoundary exists but cannot catch the error because the dynamic import failure (TypeError: Failed to fetch dynamically imported module) is a PROMISE REJECTION at the module-loader level, NOT a React render error — it propagates outside the React component tree and doesn't trigger getDerivedStateFromError.
test: Confirmed by reading: (1) dist/client/sw.js precache manifest has SentPage-B-FwuXux.js, not DsScGhek — proving the deployed build is different from what the browser is requesting; (2) index.html+CSS also get MIME text/html — proving multiple stale asset hashes are in play, indicating the browser has an older index.html from the old SW; (3) AppErrorBoundary catches React render errors but NOT unhandled promise rejections from dynamic import() calls
expecting: Fix needs two parts: (1) immediate: add an unhandledrejection listener in main.tsx that detects ChunkLoadError-style failures and auto-clears SW + reloads; (2) structural: ensure sw.js is served with no-cache headers so new SW installs immediately; (3) optional but valuable: make the SW update cycle more robust with a version broadcast
next_action: Implement the fixes

## Symptoms

expected: Clicking info@skale.club → Sent in mail.skale.club should show the Sent folder UI.
actual: Screen goes completely blank (white/black). No UI renders.
errors:
  - lockdown-install.js:1 SES Removing unpermitted intrinsics
  - SentPage-DsScGhek.js:1 Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html". Strict MIME type checking is enforced for module scripts per HTML spec.
  - vendor-react-DhHcGwbV.js:24 TypeError: Failed to fetch dynamically imported module: https://mail.skale.club/assets/SentPage-DsScGhek.js
  - vendor-react-DhHcGwbV.js:24 Uncaught TypeError: Failed to fetch dynamically imported module: https://mail.skale.club/assets/SentPage-DsScGhek.js
  - sent:1 Uncaught (in promise) Error: A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received
  - sent:1 Refused to apply style from 'https://mail.skale.club/assets/index-4LoyJroF.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
reproduction: 1) Open mail.skale.club. 2) Navigate to info@skale.club mailbox. 3) Click "Sent" folder. 4) Screen goes blank.
timeline: Started after multiple Docker rebuilds today (we did several docker build + restart cycles to fix IMAP/SMTP issues). The app was working before the rebuilds.

## Eliminated

(none — root cause confirmed on first hypothesis)

## Evidence

- timestamp: 2026-05-03T00:00:00Z
  checked: Error messages in context
  found: SentPage-DsScGhek.js gets MIME type "text/html" from server — Express SPA fallback is serving index.html for this missing asset path
  implication: The chunk hash DsScGhek doesn't exist in the current build; a stale reference exists somewhere

- timestamp: 2026-05-03T00:00:00Z
  checked: CSS error in context
  found: index-4LoyJroF.css also returns "text/html" — this is a DIFFERENT hash from the current build's CSS (current build has index-BQpEir9G.css per sw.js)
  implication: Multiple stale asset hashes being requested → the browser is using an old index.html from a prior build (served by the old SW from its precache)

- timestamp: 2026-05-03T00:00:00Z
  checked: dist/client/sw.js precache manifest
  found: Current build has SentPage-B-FwuXux.js and index-BQpEir9G.css; browser is requesting SentPage-DsScGhek.js and index-4LoyJroF.css
  implication: The stale SW (from a prior Docker build) is serving an old index.html that references those old chunk names. The new SW can't take over because the old SW doesn't self-terminate fast enough when new tabs are still open.

- timestamp: 2026-05-03T00:00:00Z
  checked: AppErrorBoundary.tsx
  found: getDerivedStateFromError catches React render errors only. The failure is a TypeError: Failed to fetch dynamically imported module — an UNHANDLED PROMISE REJECTION at the browser module-loader level, outside the React render call stack.
  implication: AppErrorBoundary does NOT catch this error class. The blank screen is because React.lazy's Suspense never resolves (the chunk never loads) and the rejection propagates as an unhandled promise rejection, not a React error.

- timestamp: 2026-05-03T00:00:00Z
  checked: src/server/index.ts static file serving
  found: express.static(clientDist) serves sw.js with default ETag/Last-Modified cache headers (no explicit no-cache). No special handling for /sw.js.
  implication: If Caddy or browser caches sw.js, the new SW doesn't get fetched promptly. Browser SW update mechanism relies on sw.js responding with byte-different content to trigger update — ETag alone usually works, but HTTP cache headers on sw.js should be max-age=0 per spec recommendation.

- timestamp: 2026-05-03T00:00:00Z
  checked: vite.config.ts VitePWA config
  found: registerType: 'autoUpdate', skipWaiting: true, clientsClaim: true, cleanupOutdatedCaches: true
  implication: Config is correct in theory. skipWaiting+clientsClaim means a new SW should take over immediately. BUT: if the old SW's precache has a stale index.html, the new index.html (with new chunk hashes) is served from the old SW's NavigationRoute handler — so even after new SW installs, users get the stale index.html until the SW actually activates. The real gap is: after the new SW claims clients, the page is NOT reloaded automatically, so the old index.html (with old chunk hashes) stays loaded in memory.

## Resolution

root_cause: Two-layer failure: (1) After each Docker rebuild, Workbox's skipWaiting+clientsClaim installs and activates the new SW, but does NOT reload currently-open tabs. So the tab keeps the old index.html in memory (with old chunk hashes like SentPage-DsScGhek.js). When navigation triggers a lazy import(), the browser requests the old chunk — which no longer exists on the server — and Express SPA-fallback returns index.html with text/html MIME type. (2) AppErrorBoundary cannot catch this failure because the dynamic import() rejection is an unhandled promise rejection, not a React render error. So the user sees a blank screen with no recovery UI.
fix: Three-part fix applied: (1) Added window.addEventListener('unhandledrejection') in src/main.tsx that detects chunk-load failures and auto-clears SW cache + reloads — immediate recovery without user needing DevTools. (2) Added sw.js and registerSW.js explicit routes in src/server/index.ts with Cache-Control: no-store so browsers always fetch fresh SW. (3) Added navigator.serviceWorker 'controllerchange' listener in src/main.tsx that reloads the page when a new SW takes over — ensures users automatically get the new index.html after each deploy.
verification: Build passes (✓ built in 5.61s). TypeScript errors in modified files: none. Pre-existing errors in unrelated files (AppLogo.tsx, SettingsPage.tsx) not introduced by this change.
files_changed:
  - src/main.tsx
  - src/server/index.ts
