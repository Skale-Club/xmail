CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_native_email_unique
    ON public.mailboxes (lower(email))
    WHERE is_native = true;
