# Phase 22 Research — Unified Inbox Operator Experience

## Existing codebase surfaces

### Navigation and authorization

- `src/components/outreach/OutreachLayout.tsx` already owns organization switching and outreach navigation. Its existing `Inboxes` item means sender accounts, so the Unified Inbox needs a separate `Inbox` item and an unread badge.
- `src/main.tsx` lazy-loads each outreach page, wraps it in `OrganizationProvider`, and currently uses the outreach access gate planned for correction in Phase 20. Add the new route beside the other outreach routes and consume the corrected organization-member gate rather than restoring `AdminCheck`.
- `src/hooks/useOrganization.tsx` persists the selected organization. Every inbox query key must include `currentOrganization.id`; changing organizations must clear selected conversation and cached tenant data.

### UI building blocks

- `src/components/mail/EmailThread.tsx` contains useful thread expansion, participant, attachment, reply, and safe HTML-rendering patterns. Extract/reuse presentation behavior, but adapt API types; it assumes personal-mail `ThreadMessage` and local `Date` instances.
- `src/components/mail/ComposeDialog.tsx` demonstrates multipart attachments, recipient parsing, signatures, reply/reply-all/forward quoting, and `RichTextEditor`. It is coupled to `MailboxProvider` and personal mail APIs, so the unified composer should be a separate controlled component using conversation IDs and durable inbox commands.
- Available local primitives are intentionally small (`Button`, `Card`, `ConfirmDialog`, `Dialog`, `Input`, `PaginationControls`, `Skeleton`, `Switch`, `Table`, toast). Radix packages for Select, Popover, ScrollArea, Tabs, Tooltip, and Dropdown Menu exist even where wrappers do not; add focused wrappers only when the inbox needs them.
- `src/lib/api.ts` provides `apiFetch` and `fetchWithAuth`, including FormData behavior and typed `ApiError`. All new hooks should use these rather than raw unauthenticated fetch.

### Existing notification behavior

- `src/hooks/useNotifications.ts` polls global user-notification unread count every two minutes. This is too coarse for a working inbox and cannot express per-organization conversation invalidation.
- A single organization-scoped SSE stream can publish small events (`conversation.created`, `conversation.updated`, `unread.changed`, `sync.health`) without streaming message bodies. Bearer-authenticated clients must use `fetch` + `ReadableStream` + `AbortController`, not `EventSource`. TanStack Query then invalidates list/detail/count keys. A bounded polling fallback preserves functionality behind proxies that buffer/disconnect SSE.

### Backend constraints

- The process is a long-running Node container, so cron/advisory-lock jobs are appropriate for scheduled sends/reminders.
- Database RLS is defense in depth only. Routes use canonical `requireOutreachRead`/`requireOutreachWrite` from `src/server/lib/outreach-access.ts`; workers and every service query/mutation carry explicit verified organization scope.
- Existing `src/server/routes/outreach/send-message.ts` is native-only, bypasses campaign limits, and sends before durable persistence. It is not a safe implementation base. Phase 22 should call the shared send-policy/command service delivered by Phases 18–19.
- Existing outreach settings contain notification flags, but Phase 20 decides their final contract. New-reply notification behavior must consume the final setting rather than invent a duplicate flag.

## Product benchmark distilled

Instantly's Unibox model centralizes replies from connected sending accounts, then makes filters/search, status actions, blocklist, and reply operations available from one thread workspace. The Xmail version should preserve that operational density while fitting its organization/campaign model. Source used in the audit: [Instantly — How to manage Unibox](https://help.instantly.ai/en/articles/6576561-how-to-manage-unibox-best-practices-for-replying-to-leads).

The benchmark is behavioral, not visual. The decisive Xmail additions are explicit tenant scope, campaign/lead/account attribution, durable commands, and policy-gated delivery.

## Recommended data/API additions after Phase 21

Only add what Phase 21 does not already provide:

- `inbox_labels` and `inbox_conversation_labels` scoped to organization.
- conversation operator state (`status` active/archived, optional outcome) if absent.
- `inbox_reminders` scoped to conversation + user with due/status timestamps.
- `inbox_snippets` scoped to organization, with name/body and optional shortcut.
- `inbox_send_commands` for draft/scheduled/queued/sending/sent/failed/cancelled operations, idempotency key, actor, conversation, source message, mode, recipients, rendered body, attachment refs, scheduling/lease/attempt fields, policy decision, and resulting message ID.
- `inbox_attachments` metadata owned by organization/command/message and one private Supabase Storage bucket created/configured by migration 042. A create-intent endpoint returns a short-lived signed upload token; the browser streams bytes directly to Storage; finalize verifies size/type/object ownership before status `ready`; authorized download uses a short-lived signed URL; delete/cancel plus a scheduled orphan cleanup removes stale rows and objects.

Recommended endpoints beneath Phase 21's `/api/outreach/unified-inbox` router:

- labels list/create/update/delete; conversation label attach/detach;
- conversation status/read mutation and bulk action with a hard item limit;
- suppression preview + confirm endpoint for sender/domain scope;
- reminder CRUD and due summary;
- snippet CRUD;
- send-command create/cancel/retry/status and attachment upload/download;
- event stream + unread/health aggregate.

Every mutation accepts an idempotency key where double-click/retry could duplicate work.

## Responsive interaction recommendation

- **Desktop ≥1280:** 224px filter rail, 360–420px list, fluid thread; composer anchored in thread, not a floating personal-mail window.
- **Tablet 768–1279:** filter rail becomes a sheet/popover; list ~320px + thread.
- **Mobile <768:** route state selects list/thread/compose. Preserve filter query string and scroll position when navigating back.
- Virtualization is optional at first because server cursor pagination bounds rendered rows; infinite loading must keep a visible retry boundary.

## Accessibility risks to plan explicitly

- The conversation list behaves like a selectable listbox only if full keyboard semantics are implemented; otherwise use links/buttons with ordinary focus behavior. Do not fake ARIA grid semantics.
- Announce result counts, mutation outcomes, incoming reply counts, and load-more failures through a polite live region.
- Restore focus to the originating conversation/action after dialogs and mobile back transitions.
- Never encode unread, outcome, provider health, or selection only by color.
- Confirmation copy must identify sender/domain scope and count of affected selected conversations.
- Sanitized email HTML stays isolated through `EmailHtmlViewer`; quoted content is collapsed with a keyboard-operable control.

## Testing recommendation

- Use the test harness established in Phase 18. Add service/route tests for tenant isolation, bulk bounds, idempotency, attachment ownership, schedule recovery, and policy-gate denials.
- Add React tests for URL parsing/serialization, organization cache separation, optimistic rollback, keyboard selection, focus restoration, and all four async states.
- Browser UAT must test 1440×900, 1024×768, and 390×844, plus keyboard-only operation and a simulated SSE disconnect.

## Planning risks

1. Phase 21 contract may land under different names. Each plan starts by reading Phase 21 summaries and reconciling names instead of forking the model.
2. Migration `042` is provisional because other phases may land first and must be revalidated at execution start.
3. Attachments can expand scope. Keep binary storage behind one interface and enforce explicit limits; metadata-only attachment ingestion from Phase 21 does not imply download/upload storage exists.
4. Provider parity must be real. Reply commands must dispatch through provider adapters and the shared policy gate; native-only success is insufficient.
