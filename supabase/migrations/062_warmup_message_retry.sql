-- 062 — Warm-up mesh: retry temporary send failures instead of discarding them
--
-- On 2026-08-17 the warm-up mesh had 38 messages marked `failed` with:
--   "direct delivery to <ourdomain> failed on all 1 MX host(s) (mx.skale.club):
--    Can't send mail - all recipients were rejected: 451 4.7.1 Greylisted; please retry in 5 minutes"
--
-- Two independent defects were behind this, diagnosed together:
--
--   1. The mesh sends between our OWN registered inboxes, on our OWN domains, and it all routes
--      to our OWN MX (mx.skale.club) — which greylists new sender/recipient pairs
--      (mx-guard.ts's shouldGreylist). Fixed separately by exempting our own verified
--      email_accounts from the greylist gate (no schema change needed for that half).
--   2. `processWarmup.ts` treated ANY provider rejection as terminal and set `status = 'failed'`.
--      A 451 is a TEMPORARY failure that explicitly asks the sender to retry in 5 minutes — a
--      correct MTA retries. Marking it `failed` on the first attempt threw the message away
--      instead of trying again once the greylist hold (or any other transient condition) cleared.
--
-- This migration adds the bookkeeping the retry needs: how many times a message has been
-- attempted, and when it is next allowed to try again. The SEND-phase selection query in
-- processWarmup.ts skips any pending message whose `next_attempt_at` is still in the future, and
-- gives up (flips to `failed`) only after repeated temporary failures — see
-- `src/server/lib/warmup/retry.ts` for the pure classification/backoff logic this drives.
--
-- Idempotent. Additive: nothing removed, no existing default changes behavior for rows that
-- never fail (attempts stays 0, next_attempt_at stays NULL, same as before this migration).

BEGIN;

ALTER TABLE public.warmup_messages
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamp;

COMMENT ON COLUMN public.warmup_messages.attempts IS
    'How many send attempts have been made for this message (0 = not yet attempted). A 4xx/unclassifiable failure increments this and reschedules via next_attempt_at; a 5xx or hitting the attempt cap flips status straight to failed. See classifySendFailure / decideWarmupSendOutcome in lib/warmup/retry.ts.';
COMMENT ON COLUMN public.warmup_messages.next_attempt_at IS
    'Earliest time the SEND phase may retry this message. NULL means no retry is scheduled (never attempted yet, or already terminal). The selection query must skip rows where this is in the future.';

-- Retry due-selection: pending messages whose backoff has elapsed. Partial on status='pending' so
-- the index stays small — sent/failed/archived rows never need this lookup again.
CREATE INDEX IF NOT EXISTS idx_warmup_messages_retry_due
    ON public.warmup_messages (next_attempt_at)
    WHERE status = 'pending' AND attempts > 0;

COMMIT;
