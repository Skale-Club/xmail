---
status: awaiting_human_verify
trigger: "Admin user (skale.club@gmail.com) on production sees black screen when opening a mailbox; mailboxes added do not persist across sessions"
created: 2026-04-28T00:00:00Z
updated: 2026-04-28T12:00:00Z
---

## Current Focus

hypothesis: CONFIRMED on both fronts. (1) Persistence bug = c809688 destructive cleanup loop + admin-only filters in mailboxes.ts and native-mail.ts. (2) Black screen = stale Workbox PWA service worker serving 0-byte responses for the JS bundle (Network tab confirmed every asset 200 from `(ServiceWorker)` with 0 B body and zero application requests).
test: Fix applied. Locally: `npm run build` green, both client and server compile with zero TS errors. PWA service worker now configured with cleanupOutdatedCaches+skipWaiting+clientsClaim. Top-level AppErrorBoundary added to give users a "Reset app" escape hatch.
expecting: After deploy, admin can open /mail/inbox, see all mailboxes (own native + every other user's mailbox for impersonation), select any one, navigate freely. If a stale SW is still pinned to the user's browser from before the deploy, the ErrorBoundary triggers on first lazy-load failure and offers Reset.
next_action: User must deploy (git push) then in browser do ONE of: (a) hit Ctrl+Shift+R hard reload, (b) DevTools > Application > Service Workers > Unregister, OR (c) wait for the React error boundary to fire and click "Reset app".

## Symptoms

expected:
- Clicking a mailbox in admin UI opens detail view normally
- Mailboxes added persist across sessions (still listed next day)

actual:
- Opening a mailbox renders black/blank screen
- Previously added mailboxes are missing on return next day

errors: User has not yet checked browser console (F12). No errors captured yet.

reproduction:
1. Login as skale.club@gmail.com (admin, no mailbox ownership)
2. Navigate to /mail/inbox (admin can use mail UI; "Exit to Admin" link is visible)
3. Open AccountSwitcher (top-right) and click an existing mailbox -> black screen reported
4. Add new mailbox via Add Account dialog -> appears to succeed
5. Return next day -> mailbox not listed

started: After commit c809688 (2026-04-24) — "Fix native mailbox ownership and session selection"

## Eliminated

- hypothesis: "Black screen is a render error in EmailDetailPage from a stale selectedMailboxId"
  evidence: User's Network tab shows the page document AND every JS chunk returning 200 from `(ServiceWorker)` with 0 bytes. There is no /api/mail/mailboxes request at all. The React app never gets a chance to mount EmailDetailPage; the bundle itself is empty when the service worker serves it. This is a service-worker-level problem, not an app-level render error.
  timestamp: 2026-04-28T12:00:00Z

- hypothesis: "Black screen is JS errors from React rendering"
  evidence: Console shows only "SES Removing unpermitted intrinsics" from lockdown-install.js (a browser extension, MetaMask/SES — unrelated to our code). No React/app errors logged. Empty bundle => no React execution => no errors to log.
  timestamp: 2026-04-28T12:00:00Z

## Evidence

- timestamp: 2026-04-28T00:00:00Z
  checked: commit c809688 diff (8 files, 493+/148-)
  found: src/server/routes/mail/mailboxes.ts GET / handler now contains an admin-only delete loop (lines 80-91) that *unconditionally deletes* every mailbox row where (userId=admin.id AND isNative=true AND email=admin.email) on every list call. Calls deleteMailboxById which cascades to mailFolders, mailMessages, mailFilters, signatures.
  implication: Any native mailbox the admin previously had with their own email is wiped on the next GET. Explains "mailboxes added previously are missing next day".

- timestamp: 2026-04-28T00:00:00Z
  checked: GET /api/mail/mailboxes filter logic (line 97)
  found: visibleMailboxes = userMailboxes.filter(mb => isCanonicalNativeMailbox(mb, user.email)). Function returns true only when !mb.isNative OR mb.email === user.email. For admin: native mailboxes whose email != admin.email are silently filtered out (not deleted, but invisible).
  implication: If admin previously connected native mailboxes for OTHER users (mailboxes row with userId=admin.id, isNative=true, email=otherUser@domain), those vanish from the response. Combined with previous evidence, admin sees ONLY external (IMAP) mailboxes in the dropdown.

- timestamp: 2026-04-28T00:00:00Z
  checked: POST /api/mail/mailboxes/connect (lines 138-199) and authenticateNativeUser in native-mail.ts (lines 22-31)
  found: authenticateNativeUser returns null when user.isAdmin === true. Connect handler also has explicit `if (targetUser.id !== userId) return 403`. createUserMailbox returns null when owner.isAdmin.
  implication: Admin cannot create native mailboxes via /connect at all. (1) Their own email auth fails (admin filter). (2) Other-user emails get 403. The "Add Account" connect dialog is non-functional for admins. The legacy POST /api/mail/mailboxes (full SMTP/IMAP form) still works but is not isNative — and there is no UI exposing this form on the SettingsPage as far as the dialog flow is concerned (it shells out to ConnectMailboxDialog).

- timestamp: 2026-04-28T00:00:00Z
  checked: src/hooks/useMailbox.tsx and src/lib/constants.ts (storage key change)
  found: localStorage key changed from 'selectedMailboxId' (global) to 'selectedMailboxId:<sessionId>' (per session/user). useMailbox now reads from new key, falls back to legacy key once. After fallback, the legacy key is cleared on every call. activeSessionId comes from useMultiSession; if it isn't ready on first render storageKey resolves to user.id which is fine.
  implication: Persistence ACROSS BROWSER SESSIONS for "selected mailbox" should still work because key includes user.id. However: (a) if multi-session restoration races and activeSessionId resolves later than user.id, selectedMailbox may briefly point to the wrong key — but only during the same session. (b) more critically, even if the saved key resolves, the saved id must match a mailbox in `data.mailboxes`. If the server filtered/deleted that mailbox (admin case), the saved id is stale -> selected falls back to defaultMailbox || mailboxes[0] || null.

- timestamp: 2026-04-28T00:00:00Z
  checked: AccountSwitcher.tsx behavior when mailboxes.length === 0
  found: Pre-c809688: returned early with "Add Account" CTA. Post-c809688: when showSignOut is true (header location), early-return is skipped (`mailboxes.length === 0 && !showSignOut`). Falls through to render user avatar + label "No mailbox selected". Clicking still opens dropdown which now shows "Accounts" header with 0 items.
  implication: For admin in mail header, dropdown opens with empty list — not a black screen. Black screen must come from elsewhere.

- timestamp: 2026-04-28T00:00:00Z
  checked: InboxPage and EmailDetailPage render guards
  found: Both check `mailboxes.length === 0` and render an "Add Email Account" CTA. EmailDetailPage also checks `messageLoading`, `error`, `!thread`. The route component itself is wrapped in PageSuspense. There are no guards that handle "selectedMailbox is non-null but stale (404 on detail)". useMessage fires for any messageId with selectedMailbox truthy.
  implication: If admin has selectedMailbox set to a stale UUID (mailbox previously deleted by admin-cleanup loop), then `useFolders` -> GET /api/mail/mailboxes/{staleId}/folders returns 404 -> error in TanStack Query. InboxPage doesn't render an error UI for the messages query failing — the right pane just renders "Select an email to read" placeholder; left pane EmailList shows empty state. That is also not a black screen.

- timestamp: 2026-04-28T00:00:00Z
  checked: lazy-loaded routes via React.lazy + PageSuspense
  found: All mail pages (InboxPage, EmailDetailPage, SettingsPage, etc.) use React.lazy. If lazy chunk fails to load (network blip, stale chunk after deploy) and there is no error boundary, React renders the empty Suspense fallback at the top level.
  implication: A "black screen" could be a Suspense fallback that never resolves OR an unhandled error from a lazy chunk after a deploy invalidated old hashes. There is no top-level <ErrorBoundary>. Need user's browser console to confirm.

## Resolution

root_cause:
  PERSISTENCE: GET /api/mail/mailboxes contained admin-cleanup logic that deleted every native mailbox with (userId=admin, email=admin.email) on every list call (mailboxes.ts:80-91 in c809688). isCanonicalNativeMailbox filtered out any native mailbox whose email != admin.email (mailboxes.ts:97). authenticateNativeUser refused admin users (native-mail.ts:27). createUserMailbox refused admin users (native-mail.ts:49). POST /connect refused cross-user provisioning (mailboxes.ts:162-166). Together: admins lost their own native mailbox on every page-load AND could not provision new ones.

  BLACK SCREEN: Stale Workbox PWA service worker serving 0-byte responses for the application bundle. User's Network tab confirmed the page document, every JS chunk, every CSS file, the manifest, and assets all returned 200 from `(ServiceWorker)` with content length 0. No API request ever fired because the React bundle never executed. The Vite PWA config in vite.config.ts was missing `cleanupOutdatedCaches`, `skipWaiting`, and `clientsClaim`, so when the c809688 deploy shipped new asset hashes the service worker held onto stale precache entries (or, in this case, stored corrupt empty entries) and there was no top-level ErrorBoundary to surface the failure to the user.

fix:
  PERSISTENCE (Option C — admin is super-admin who can impersonate any user's inbox):
    1. src/server/lib/native-mail.ts: removed all `owner.isAdmin` short-circuits in authenticateNativeUser, createUserMailbox, and findLocalUser. Admins now have a native mailbox tied to their email like every other user.
    2. src/server/routes/mail/mailboxes.ts:
       - Removed the destructive admin-cleanup loop (the deleteMailboxById on every GET).
       - Removed isCanonicalNativeMailbox helper + filter.
       - GET / now returns ALL mailboxes in the system when the requester is admin (impersonation). Regular users still scoped to their own.
       - checkUserMailboxAccess rewritten: admins bypass ownership; regular users still must own the mailbox AND for native mailboxes the email must match the owner's email. This propagates admin-impersonation through every per-mailbox route (folders, messages, send, signatures, filters, sync) without changes to those files.
       - POST /connect: relaxed the cross-user 403 — admins can provision a native mailbox for the target user (rows are created with userId=targetUser.id, not requester's id, preserving the native invariant).

  BLACK SCREEN:
    1. src/components/AppErrorBoundary.tsx (new): top-level ErrorBoundary catches React render exceptions AND React.lazy ChunkLoadError. Provides a "Reset app" button that unregisters all service workers, clears Caches API entries, scrubs `selectedMailboxId*` localStorage keys, and reloads.
    2. src/main.tsx: wraps <App /> in <AppErrorBoundary>.
    3. vite.config.ts (Workbox): added `cleanupOutdatedCaches: true`, `skipWaiting: true`, `clientsClaim: true`, `navigateFallbackDenylist: [/^\/api\//]`. Future deploys will hand off to the new SW immediately and drop stale precache entries.

verification:
  - `npm run build` succeeds. Client bundle generated (52 precache entries, sw.js + workbox-79fb5871.js). Server bundle generated.
  - `tsc -p tsconfig.server.json` reports zero errors.
  - `npm run lint` is non-functional in this repo (no eslint config file present — pre-existing).
  - Logical smoke trace: admin user with skale.club@gmail.com hitting GET /api/mail/mailboxes -> finds user, has passwordHash -> createUserMailbox is idempotent and creates a native mailbox if missing -> isAdmin branch returns ALL mailboxes ordered by createdAt -> response includes admin's own native mailbox + every other user's mailbox. Selecting any of them in AccountSwitcher persists `selectedMailboxId:<sessionId>` in localStorage. Subsequent /api/mail/mailboxes/:id/folders calls go through checkUserMailboxAccess which returns the mailbox for admin regardless of ownership.
  - Post-deploy user action required (current SW is corrupt and won't update itself even with skipWaiting because the stale install never ran the new SW): user must do ONE of:
      (a) Hard reload (Ctrl+Shift+R) on mail.skale.club/mail/inbox
      (b) DevTools > Application > Service Workers > "Unregister" then reload
      (c) Wait for ErrorBoundary to fire and click "Reset app" (only works once a deploy has happened with the new ErrorBoundary present, which requires fresh JS to load — chicken-and-egg if SW is fully wedged).
    Recommended: paste this in the browser console at mail.skale.club then hit Enter:
      `(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); for (const k of Object.keys(localStorage)) if (k.startsWith('selectedMailboxId')) localStorage.removeItem(k); location.reload(); })()`

files_changed:
  - src/server/lib/native-mail.ts
  - src/server/routes/mail/mailboxes.ts
  - src/components/AppErrorBoundary.tsx (new)
  - src/main.tsx
  - vite.config.ts
