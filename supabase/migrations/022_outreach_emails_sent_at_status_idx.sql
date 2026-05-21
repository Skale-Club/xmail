-- Phase 17 (17-03) — composite index for outreach health endpoint.
--
-- The /api/admin/outreach/health endpoint and the daily digest cron both run
-- aggregate queries of the form:
--   COUNT(*) FILTER (WHERE sent_at >= $cutoff AND status = $status)
--
-- These filter on (sent_at, status) over rolling 1h/24h/7d windows. Without a
-- composite index, PG falls back to single-column scans + filter passes which
-- becomes painful at scale (millions of outreach_emails rows). CONCURRENTLY so
-- the long-running processor that writes this table is not blocked during
-- index build.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_sent_at_status
    ON outreach_emails (sent_at, status);
