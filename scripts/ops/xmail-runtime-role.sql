-- Run only against the independently reconciled private candidate.
-- The server enforces organization authorization. Its backend role must bypass
-- legacy Supabase RLS (auth.uid() is NULL here), but must not own schema/data.
-- NOLOGIN is deliberate: preparing grants does not enable an application user.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SELECT pg_advisory_xact_lock(190732, 3);
DO $$ BEGIN
  IF current_database() <> 'xmail' OR current_user <> 'xmail_owner'
    OR session_user <> 'xmail_owner'
    OR current_setting('server_version_num')::int / 10000 <> 17
    OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) <> 'xmail_owner'
    OR to_regclass('public.users') IS NULL
    OR to_regclass('public.organization_users') IS NULL
    OR EXISTS (SELECT FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader'))
  THEN RAISE EXCEPTION 'Runtime role target or initial state refused'; END IF;
END $$;
CREATE ROLE xmail_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS CONNECTION LIMIT 20;
CREATE ROLE xmail_staging_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE xmail_staging_reader SET default_transaction_read_only = on;
-- PUBLIC privileges otherwise silently defeat a restricted per-role grant.
REVOKE CREATE, TEMPORARY ON DATABASE xmail FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE xmail TO xmail_runtime;
GRANT CONNECT ON DATABASE xmail TO xmail_staging_reader;
GRANT USAGE ON SCHEMA public TO xmail_runtime;
GRANT USAGE ON SCHEMA public TO xmail_staging_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO xmail_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO xmail_staging_reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xmail_runtime;
-- A SELECT-only role can otherwise invoke a PUBLIC SECURITY DEFINER function.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO xmail_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE xmail_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO xmail_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE xmail_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO xmail_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE xmail_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO xmail_staging_reader;
-- Function EXECUTE starts with a global PUBLIC default. A per-schema revoke
-- cannot cancel that global grant; revoke globally, then grant runtime locally.
ALTER DEFAULT PRIVILEGES FOR ROLE xmail_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE xmail_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO xmail_runtime;
COMMENT ON ROLE xmail_runtime IS
  'Trusted Xmail server DML role; application enforces tenant authorization. NOLOGIN until reviewed activation; never use in browsers.';
COMMENT ON ROLE xmail_staging_reader IS
  'Private HTTP staging aggregate probes only; SELECT, no public function execution, no login until reviewed activation.';
COMMIT;
