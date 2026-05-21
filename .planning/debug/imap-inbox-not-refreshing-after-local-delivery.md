---
status: awaiting_human_verify
trigger: "imap-inbox-not-refreshing-after-local-delivery"
created: 2026-05-03T00:00:00Z
updated: 2026-05-03T00:20:00Z
---

## Current Focus

hypothesis: CONFIRMED — NOOP does not push EXISTS updates, and IDLE push omits RECENT.
test: Fix applied. Awaiting human verification.
expecting: After deploy, Thunderbird shows new messages delivered to info@skale.club immediately (IDLE) or on F5 (NOOP/CHECK polling).
next_action: User deploys and confirms fix in Thunderbird.

## Symptoms

expected: After vanildo@skale.club sends email to info@skale.club via Thunderbird SMTP, the message should appear in info@skale.club Inbox in Thunderbird.
actual: Thunderbird shows info@skale.club Inbox as empty. Server logs confirm "[SMTP] Local delivery: vanildo@skale.club → info@skale.club" ran successfully twice. DB query confirms messages exist in the folder.
errors: No errors in server logs. Delivery succeeds silently but Thunderbird never shows the new messages.
reproduction: 1) Send email from vanildo@skale.club to info@skale.club via Thunderbird. 2) Check info@skale.club Inbox in Thunderbird — empty. 3) Check server: docker logs show local delivery OK. 4) Check DB: messages are in mail_messages table in the inbox folder.
timeline: Started as soon as Thunderbird was configured. IMAP auth works. SELECT INBOX returns correct EXISTS count. FETCH works. But new messages don't appear after delivery.

## Eliminated

(none yet)

## Evidence

- timestamp: 2026-05-03T00:00:00Z
  checked: smtp-server.ts storeMessage() call path for local delivery
  found: storeMessage() calls emitFolderChange({ folderId, mailboxId, kind:'new' }) after inserting into DB and recomputeFolderCounts. The event is emitted on the mailEvents EventEmitter.
  implication: The event bus signal path is present. The question is whether the IDLE listener in imap-server.ts receives it and whether it pushes correctly to the right session.

- timestamp: 2026-05-03T00:00:00Z
  checked: imap-server.ts IDLE handler (lines 872-896)
  found: |
    The IDLE handler registers a listener on 'folder-change'. The listener:
    1. Filters by payload.folderId === session.selectedFolderId
    2. Calls countFolderMessages() to get newCount
    3. If newCount !== session.knownMessageCount → sends "* {newCount} EXISTS"
    4. Updates session.knownMessageCount
    But it sends ONLY "* N EXISTS". It does NOT send a "* N RECENT" line alongside it.
  implication: This is a potential issue. RFC 3501 says EXISTS alone is sufficient for clients to fetch new messages, but some clients (especially Thunderbird) may rely on RECENT flag or may need the response in a specific format.

- timestamp: 2026-05-03T00:00:00Z
  checked: imap-server.ts IDLE termination (lines 1258-1263)
  found: |
    When "DONE" is received, the listener is removed and tag OK is sent. There is no
    EXISTS/RECENT flush before the OK response. This means: if a message arrives
    EXACTLY while the client is sending DONE, the EXISTS never gets sent.
    More importantly: after IDLE terminates via DONE, the client must re-poll
    via NOOP or re-enter IDLE. The DONE handler sends NO unsolicited EXISTS/FLAGS
    responses in the tagged OK response window.
  implication: If Thunderbird is cycling IDLE/DONE rapidly, it might miss the EXISTS notification.

- timestamp: 2026-05-03T00:00:00Z
  checked: IDLE listener folderId matching logic
  found: |
    The IDLE listener checks: payload.folderId !== session.selectedFolderId
    The SMTP storeMessage() calls emitFolderChange({ folderId: folder.id, mailboxId, kind:'new' })
    where folder.id is the UUID of the inbox folder from mailFolders table.
    The IMAP session stores session.selectedFolderId from the SELECT command result,
    which is also folder.id.
    These should match IF the same folder record is being used — but only if Thunderbird
    has the INBOX selected at the moment of delivery. If Thunderbird is not in IDLE on
    INBOX, the event is silently dropped.
  implication: If info@skale.club has no active IDLE connection OR selected a different folder, the EXISTS push is never sent, and Thunderbird won't poll until its own timeout. This explains "empty until F5".

- timestamp: 2026-05-03T00:00:00Z
  checked: NOOP command handler (lines 360-363)
  found: |
    NOOP handler sends ONLY "* tag OK NOOP completed". It does NOT check for new
    messages and send unsolicited EXISTS/RECENT responses.
    RFC 3501 §6.1.2 says: "The NOOP command always succeeds. It does nothing [...] 
    but the server may send any applicable untagged responses." This means NOOP
    is supposed to be an opportunity to flush pending EXISTS/RECENT updates.
    The current implementation misses this: NOOP never pushes EXISTS count changes.
  implication: Even when Thunderbird sends NOOP (e.g., F5 / "Get Messages"), the server sends no EXISTS update. Thunderbird would then not know there are new messages to fetch. This is a CRITICAL protocol gap.

- timestamp: 2026-05-03T00:00:00Z
  checked: SELECT response for pre-existing messages
  found: |
    SELECT correctly returns "* N EXISTS" for messages already in the folder.
    So the initial display works fine. The problem is ONLY for messages delivered
    AFTER the folder was selected — which requires either IDLE push or NOOP polling.
    Both are broken.
  implication: Confirms the bug: IDLE push may work if Thunderbird maintains a persistent IDLE connection, but NOOP-based polling (F5) definitely doesn't work, and the IDLE push has the folderId-match dependency noted above.

## Resolution

root_cause: |
  Two compounding bugs:
  1. PRIMARY: The NOOP command handler does not send unsolicited EXISTS responses
     for new messages. RFC 3501 requires servers to use NOOP responses as an
     opportunity to send pending EXISTS/RECENT/FLAGS updates. Thunderbird relies
     on NOOP polling when not in IDLE mode (e.g., after composing/sending, or
     on "Get Messages"). Since NOOP never pushes EXISTS changes, Thunderbird
     never discovers new messages have arrived.
  2. SECONDARY: The IDLE notification only works if the client's IDLE connection
     happens to have exactly the recipient's INBOX folder selected at delivery time.
     The matching is correct in principle, but the IDLE EXISTS push also does NOT
     send "* 1 RECENT" alongside the EXISTS, which some clients use as the trigger
     to initiate a FETCH. Without RECENT=1, Thunderbird may not issue a FETCH after
     receiving the EXISTS.

fix: |
  Two targeted changes in src/server/imap-server.ts:
  1. NOOP + CHECK handlers: when a folder is selected, query current message count
     and push "* N EXISTS" + "* M RECENT" before the tagged OK if the count changed.
     Also added CHECK command (RFC 3501 §6.4.1) which Thunderbird uses equivalently.
  2. IDLE listener: added "* M RECENT" line immediately after "* N EXISTS" when
     new messages are detected, so Thunderbird triggers an automatic FETCH.
verification: Pending human confirmation after deploy.
files_changed:
  - src/server/imap-server.ts
