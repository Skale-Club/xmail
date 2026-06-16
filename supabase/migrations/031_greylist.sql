-- 031_greylist.sql
-- Persist MX greylisting state across container restarts.
--
-- Greylisting state used to live in an in-memory Map (src/server/lib/mx-guard.ts).
-- Because the xmail container redeploys on every push to main, that Map was wiped
-- on each restart: a legitimate MTA that retried after the 5-minute hold would be
-- treated as a brand-new (sender, recipient) pair and greylisted again, so mail
-- from senders that rotate IPs / return-paths (e.g. ESPs like Resend) could keep
-- soft-failing and never reach the inbox. This table makes the hold durable.

CREATE TABLE IF NOT EXISTS public.greylist (
    -- key = lower(envelope_sender) || '|' || lower(recipient)
    key         text        PRIMARY KEY,
    first_seen  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now(),
    passed      boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_greylist_last_seen ON public.greylist (last_seen);

-- Defense-in-depth RLS: this table is only ever touched by the MX server using
-- the DATABASE_URL role (which bypasses RLS). Enable RLS with no policies so no
-- anon/authenticated client can read or write greylisting state.
ALTER TABLE public.greylist ENABLE ROW LEVEL SECURITY;
