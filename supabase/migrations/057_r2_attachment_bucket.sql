-- 057_r2_attachment_bucket.sql
--
-- Point NEW inbox attachments at the Cloudflare R2 bucket.
--
-- Migration 042 created inbox_attachments with DEFAULT 'inbox-attachments', the private
-- Supabase Storage bucket. Object bytes now live in R2 (`xmail-inbox-attachments`, WEUR,
-- private) behind src/server/lib/object-storage.ts.
--
-- Only the DEFAULT changes. Existing rows are deliberately NOT rewritten: storage_bucket
-- records where an object was actually written, and download/delete resolve it from the
-- row. Rewriting it would point old rows at a bucket that does not hold their bytes.
-- (At the time of writing there are zero attachment objects, so this is a formality —
-- but the rule is what keeps a future re-run honest.)

ALTER TABLE public.inbox_attachments
    ALTER COLUMN storage_bucket SET DEFAULT 'xmail-inbox-attachments';

COMMENT ON COLUMN public.inbox_attachments.storage_bucket IS
    'Object-storage bucket holding this attachment. Written at upload time and never rewritten: it records where the bytes actually are, so a backend/bucket change only affects new rows.';
