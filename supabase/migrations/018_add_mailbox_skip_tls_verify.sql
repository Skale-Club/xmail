-- Migration 018: Add skip_tls_verify column to mailboxes (SEC-02, audit H5)
-- See: .planning/debug/system-wide-audit-2026-05-16.md
--
-- NOTE: Plan 11-02 originally specified filename 017, but 017 is reserved by
-- Phase 13 (QUA-03) for the RLS consolidation migration. Renumbered to 018
-- here at orchestrator direction. Phase 13's `consolidate_rls.sql` will take
-- 017 as originally planned.
--
-- Default false (strict TLS verification). Per-mailbox opt-in for self-signed
-- corporate IMAP. Adding this column is forward-compatible: existing
-- application code reading it gets `false` until the application is upgraded
-- (which lands tlsOptions.rejectUnauthorized true by default anyway — see
-- src/server/lib/mail-sync.ts).

ALTER TABLE public.mailboxes
    ADD COLUMN IF NOT EXISTS skip_tls_verify boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.mailboxes.skip_tls_verify IS
    'When true, IMAP/SMTP TLS certificate verification is disabled for this mailbox. Use only for self-signed corporate servers. Default false (strict).';
