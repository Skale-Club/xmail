-- Migration 019: Add clicked_at column to messages (COR-03, audit H4)
-- See: .planning/debug/system-wide-audit-2026-05-16.md
--
-- Purpose: enable 60-second sliding-window dedup of click-tracking events so refreshes,
-- email-client previews, and corporate link-rewriters do not multiply linksClicked stats.
--
-- Mirrors the existing opened_at column. Nullable; first click writes the timestamp,
-- subsequent clicks within 60s are recognized as replays by comparing to NOW().

ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS clicked_at timestamp NULL;

COMMENT ON COLUMN public.messages.clicked_at IS
    'Timestamp of most recent link click. Used by /t/click/:token handler to dedup ' ||
    'rapid replays within a 60s window. NULL = no click yet recorded.';
