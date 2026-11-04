-- Run inside one caller-owned transaction with xmail.identity_status_review set.
-- No DDL, binding creation, user update, password or organization-role mutation.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL timezone = 'UTC';
SELECT pg_advisory_xact_lock(190732, 4);
DO $$ BEGIN
  IF current_database() <> 'xmail' OR current_user <> 'xmail_owner' OR session_user <> 'xmail_owner'
    OR current_setting('server_version_num')::int / 10000 <> 17
    OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) <> 'xmail_owner'
    OR to_regclass('public.xmail_identity_user_controls') IS NULL
    OR to_regclass('public.xmail_identity_bindings') IS NULL
    OR to_regclass('public.xmail_identity_owned_sessions') IS NULL
    OR to_regclass('public.xmail_identity_browser_challenges') IS NULL
  THEN RAISE EXCEPTION 'Identity control target or additive migrations not approved'; END IF;
END $$;
-- Prevent concurrent account/authority edits and owned admission during review.
LOCK TABLE public.users, public.organization_users IN SHARE MODE;
LOCK TABLE public.xmail_identity_user_controls IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.xmail_identity_bindings, public.xmail_identity_owned_sessions,
  public.xmail_identity_browser_challenges IN SHARE MODE;
DO $$
DECLARE
  review jsonb := current_setting('xmail.identity_status_review')::jsonb;
  captured timestamptz;
  reference text;
  users_digest text;
  members_digest text;
BEGIN
  IF jsonb_typeof(review) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(review)) <> 8
    OR review->'version' IS DISTINCT FROM '1'::jsonb OR review->>'app' <> 'xmail'
    OR review->>'sourceProjectRef' <> 'zzbudkfkcmqkavgwselc'
    OR jsonb_typeof(review->'users') <> 'array' OR jsonb_array_length(review->'users') NOT BETWEEN 1 AND 10000
    OR review->>'usersDigest' !~ '^[a-f0-9]{64}$' OR review->>'membershipsDigest' !~ '^[a-f0-9]{64}$'
    OR NOT (review ?& ARRAY['version','app','sourceProjectRef','capturedAt','usersDigest','membershipsDigest','users','readOnlySnapshot'])
    OR review->'readOnlySnapshot' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(review->'capturedAt') <> 'string'
  THEN RAISE EXCEPTION 'Identity status review shape refused'; END IF;
  captured := (review->>'capturedAt')::timestamptz;
  IF captured > clock_timestamp() + interval '5 seconds' OR captured < clock_timestamp() - interval '30 minutes'
    OR EXISTS (SELECT FROM jsonb_array_elements(review->'users') item
      WHERE jsonb_typeof(item) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 2
        OR NOT (item ?& ARRAY['id','disabled']) OR jsonb_typeof(item->'disabled') <> 'boolean'
        OR item->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    OR (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(review->'users') item) <> jsonb_array_length(review->'users')
  THEN RAISE EXCEPTION 'Identity status review freshness or UUID set refused'; END IF;
  IF (SELECT count(*) FROM public.users) <> jsonb_array_length(review->'users')
    OR EXISTS (SELECT FROM jsonb_to_recordset(review->'users') AS r(id uuid, disabled boolean)
      LEFT JOIN public.users u ON u.id=r.id WHERE u.id IS NULL)
    OR EXISTS (SELECT FROM public.xmail_identity_bindings)
    OR EXISTS (SELECT FROM public.xmail_identity_owned_sessions)
    OR EXISTS (SELECT FROM public.xmail_identity_browser_challenges)
  THEN RAISE EXCEPTION 'Initial exact-user control import required'; END IF;
  IF NOT (SELECT relrowsecurity AND pg_get_userbyid(relowner)=current_user FROM pg_class WHERE oid='public.xmail_identity_user_controls'::regclass)
    OR EXISTS (SELECT FROM pg_trigger WHERE tgrelid='public.xmail_identity_user_controls'::regclass AND NOT tgisinternal)
    OR EXISTS (SELECT FROM pg_rewrite WHERE ev_class='public.xmail_identity_user_controls'::regclass)
    OR (SELECT jsonb_object_agg(attname, format_type(atttypid,atttypmod)) FROM pg_attribute
      WHERE attrelid='public.xmail_identity_user_controls'::regclass AND attnum>0 AND NOT attisdropped)
      <> '{"user_id":"uuid","disabled_at":"timestamp with time zone","sessions_valid_after":"timestamp with time zone","review_source":"text","reviewed_at":"timestamp with time zone"}'::jsonb
  THEN RAISE EXCEPTION 'Identity controls schema outside reviewed migration'; END IF;
  SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.id)::text,'[]'),'UTF8')),'hex') INTO users_digest FROM public.users u;
  SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text,'[]'),'UTF8')),'hex') INTO members_digest FROM public.organization_users m;
  IF users_digest <> review->>'usersDigest' OR members_digest <> review->>'membershipsDigest'
  THEN RAISE EXCEPTION 'Application identity or organization authority snapshot differs'; END IF;
  reference := 'legacy-auth-review:' || encode(sha256(convert_to(review::text,'UTF8')),'hex');
  IF EXISTS (
    SELECT FROM public.xmail_identity_user_controls c
    LEFT JOIN jsonb_to_recordset(review->'users') AS r(id uuid, disabled boolean) ON r.id=c.user_id
    WHERE r.id IS NULL OR c.disabled_at IS DISTINCT FROM (CASE WHEN r.disabled THEN captured ELSE NULL END)
      OR c.sessions_valid_after IS DISTINCT FROM captured OR c.reviewed_at IS DISTINCT FROM captured
      OR c.review_source IS DISTINCT FROM reference
  ) THEN RAISE EXCEPTION 'Existing controls differ; never overwrite local decisions'; END IF;
  INSERT INTO public.xmail_identity_user_controls(user_id,disabled_at,sessions_valid_after,review_source,reviewed_at)
    SELECT id, CASE WHEN disabled THEN captured ELSE NULL END, captured, reference, captured
    FROM jsonb_to_recordset(review->'users') AS r(id uuid, disabled boolean)
    ON CONFLICT (user_id) DO NOTHING;
  IF (SELECT count(*) FROM public.xmail_identity_user_controls) <> jsonb_array_length(review->'users')
    OR EXISTS (SELECT FROM public.xmail_identity_user_controls c
      JOIN jsonb_to_recordset(review->'users') AS r(id uuid, disabled boolean) ON r.id=c.user_id
      WHERE (c.disabled_at IS NOT NULL) IS DISTINCT FROM r.disabled)
  THEN RAISE EXCEPTION 'Control import proof failed'; END IF;
END $$;
SELECT jsonb_build_object('controlsImported',true,'applicationUsersChanged',false,
  'nativePasswordsChanged',false,'organizationPermissionsChanged',false,
  'providerBindingsCreated',false,'loginEnabled',false,
  'users',(SELECT count(*) FROM public.xmail_identity_user_controls),
  'disabledUsers',(SELECT count(*) FROM public.xmail_identity_user_controls WHERE disabled_at IS NOT NULL));
