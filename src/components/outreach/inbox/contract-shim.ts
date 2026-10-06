// ============================================================
// TODO(contract): temporary shim for the unified-inbox data contract
// ============================================================
// The backend agent is adding, in parallel:
//   - `InboxQuickView` including 'awaiting' (src/lib/unified-inbox-url.ts)
//   - `useInboxCounts(organizationId)` (src/hooks/useUnifiedInbox.ts)
// Everything that depends on them lives here so the merge is a one-file swap:
//   1. `RailQuickView`  -> replace with `InboxQuickView` from the url lib and drop the type shim.
//   2. `railQuickViewPatch` / `railActiveQuickView` -> call `quickViewPatch` / `activeQuickView` directly.
//   3. `useInboxCounts` -> re-export the real hook from `../../../hooks/useUnifiedInbox`.
// Until the contract lands, the 'awaiting' view falls through to the default (no filter) and the
// counts are undefined (the rail falls back to the existing unread counter).

import {
    activeQuickView,
    quickViewPatch,
    type InboxQuickView,
    type InboxUrlState,
} from '../../../lib/unified-inbox-url'

// TODO(contract): drop the `| 'awaiting'` once the url lib exports the view.
export type RailQuickView = InboxQuickView | 'awaiting'

export function railQuickViewPatch(view: RailQuickView): Partial<InboxUrlState> {
    // TODO(contract): the new url lib accepts 'awaiting'; the current one hits its default branch.
    return quickViewPatch(view as InboxQuickView)
}

export function railActiveQuickView(state: InboxUrlState): RailQuickView {
    return activeQuickView(state)
}

/** Contract shape: per-view counts for the rail. */
export interface InboxCounts {
    needsReply: number
    awaiting: number
    unread: number
    remindersDue: number
}

// TODO(contract): replace with `export { useInboxCounts } from '../../../hooks/useUnifiedInbox'`.
// Deliberately free of react-query so the shim never needs a QueryClientProvider.
export function useInboxCounts(_organizationId: string | undefined): { data: InboxCounts | undefined } {
    return { data: undefined }
}
