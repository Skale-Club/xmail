#!/usr/bin/env python3
"""Prepare the first SQL-only cutover. Offline by default; never invokes deployment."""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time

TARGET = 'e12scyfsrp822dag7m9wwd4x'
PG_IMAGE = 'sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
OLD_IMAGE = 'sha256:93c4f3284e452b518dfd7f7363152976cd1d1e3d1a28f76814b8a0ea9797b58d'
SOURCE_PROJECT = 'zzbudkfkcmqkavgwselc'
OPS = Path('/opt/xmail/owned-runtime-ops')
IDENTITY = ['xmail_identity_bindings', 'xmail_identity_browser_challenges', 'xmail_identity_owned_sessions', 'xmail_identity_user_controls']
V2_SHA = '154b8a09399548daed7ebe73df758a1f9b4ee5d44bcd5fea1f1ac2d4f297fdd2'
MAXIMUM = 256*1024*1024


def need(value):
    if not value: raise ValueError('Final data cutover refused')


def sha(value): return hashlib.sha256(value).hexdigest()


def identifier(value):
    need(isinstance(value, str) and 0 < len(value) <= 63 and not any(ord(c) < 32 for c in value))
    return '"'+value.replace('"', '""')+'"'


def encoded(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def durable_file(path, raw, replace=False):
    need(isinstance(raw, bytes) and not path.is_symlink())
    if not replace: need(not path.exists())
    temporary = path.with_name('.'+path.name+'.'+secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if temporary.exists(): temporary.unlink()


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def call(arguments, payload=None, timeout=15):
    result = subprocess.run(arguments, input=payload, capture_output=True, timeout=timeout, check=False)
    need(result.returncode == 0 and len(result.stdout) <= 4*1024*1024)
    return result.stdout


def inspect(identifier_value):
    values = json.loads(call(['docker', 'inspect', identifier_value]))
    need(isinstance(values, list) and len(values) == 1)
    return values[0]


def psql(query, timeout=40):
    return call(['docker', 'exec', '-i', TARGET, 'psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1',
                 '-U', 'xmail_owner', '-d', 'xmail'], query.encode(), timeout)


def read_only(query):
    return psql("BEGIN READ ONLY; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; "
                 "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='500ms'; SET LOCAL timezone='UTC'; "
                 "SET LOCAL datestyle='ISO, YMD'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; "
                 "SET LOCAL search_path=public,pg_catalog; "+query+'; ROLLBACK;')


def load_public_sources(directory, policy_sha):
    deploy = (directory.parents[1]/'.github/scripts/deploy-xmail.sh').read_bytes().replace(b'\r\n', b'\n')
    need(sha(deploy) == policy_sha)
    text = deploy.decode()
    start = text.index('import datetime as dt\n', text.index('# BEGIN XMAIL OWNED POLICY'))
    end = text.index('\nXMAIL_OWNED_POLICY_PY', start)
    namespace = {'__name__': 'reviewed_public_policy'}
    exec(compile(text[start:end], 'reviewed-public-deploy-policy', 'exec'), namespace)
    protocol = (directory/'xmail-database-rehearsal.sh').read_bytes().replace(b'\r\n', b'\n')
    need(sha(protocol) == V2_SHA)
    body = protocol.decode()
    programs = {}
    for name in ['ca_program', 'holder_program']:
        marker = name+"=$(cat <<'NODE'\n"
        need(body.count(marker) == 1)
        programs[name] = body.split(marker, 1)[1].split('\nNODE\n)', 1)[0]
    return namespace, programs


def business_schema_sql():
    excluded = ','.join("'"+name+"'" for name in IDENTITY)
    return """WITH tables AS MATERIALIZED (
      SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ("""+excluded+""" )
    ), signatures AS (
      SELECT t.relname,jsonb_build_object('rls',t.relrowsecurity,'force',t.relforcerowsecurity,
        'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
          a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),
        'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,c.contype,pg_get_constraintdef(c.oid),c.convalidated)
          ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid=t.oid),
        'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=t.oid),
        'policies',(SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,
          (SELECT array_agg(coalesce(r.rolname,'public') ORDER BY coalesce(r.rolname,'public')) FROM unnest(p.polroles) v LEFT JOIN pg_roles r ON r.oid=v),
          pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
          FROM pg_policy p WHERE p.polrelid=t.oid),
        'triggers',(SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(g.oid),g.tgenabled) ORDER BY g.tgname) FROM pg_trigger g WHERE g.tgrelid=t.oid AND NOT g.tgisinternal)
      ) AS signature FROM tables t
    ) SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(relname,encode(sha256(convert_to(signature::text,'UTF8')),'hex')) FROM signatures),
      'functions',(SELECT encode(sha256(convert_to(coalesce(string_agg(pg_get_functiondef(p.oid),'' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)),''),'UTF8')),'hex') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')),
      'types',(SELECT jsonb_agg(jsonb_build_array(t.typname,e.enumlabel,e.enumsortorder) ORDER BY t.typname,e.enumsortorder) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public')) AS schema"""


def fingerprints_sql():
    excluded = ','.join("'"+name+"'" for name in IDENTITY)
    return """WITH tables AS MATERIALIZED (
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ("""+excluded+""" )
    ), measurements AS MATERIALIZED (
      SELECT relname,query_to_xml(format($fingerprint$
        SELECT count(*) AS n,encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex') AS digest
        FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM public.%I t) hashed
      $fingerprint$,relname),false,true,'') AS value FROM tables
    ) SELECT jsonb_object_agg(relname,jsonb_build_object('count',((xpath('/row/n/text()',value))[1]::text)::bigint,
      'sha256',(xpath('/row/digest/text()',value))[1]::text)) AS fingerprints FROM measurements"""


def control_source_sql():
    return """SELECT jsonb_agg(jsonb_build_object('id',u.id::text,'present',a.id IS NOT NULL,
      'disabled',coalesce(a.banned_until>transaction_timestamp(),false) OR a.deleted_at IS NOT NULL
        OR coalesce(a.raw_app_meta_data->'xmail_disabled'='true'::jsonb,false),
      'valid',coalesce(jsonb_typeof(a.raw_app_meta_data->'xmail_disabled') IN ('boolean','null'),true)) ORDER BY u.id)
      AS controls FROM public.users u LEFT JOIN auth.users a ON a.id=u.id"""


def fk_inventory_sql():
    return """SELECT coalesce(jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,
      'tableSchema',n.nspname,'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated,'deferred',c.condeferred,
      'deferrable',c.condeferrable,'referenceSchema',rn.nspname) ORDER BY t.relname,c.conname),'[]'::jsonb)
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_class rt ON rt.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=rt.relnamespace
      WHERE c.contype='f' AND (n.nspname='public' OR rn.nspname='public')"""


def refresh_sql(tables, fks, copy_sql, controls, cutoff, expected_schema=None, sequences=None, triggers=None):
    need(isinstance(tables, list) and len(tables) == 70 and len(set(tables)) == 70 and not set(tables)&set(IDENTITY))
    need(isinstance(fks, list) and fks and all(x['validated'] is True and x['tableSchema'] == x['referenceSchema'] == 'public'
         and x['definition'].startswith('FOREIGN KEY ') and '\n' not in x['definition'] and ';' not in x['definition'] for x in fks))
    # Production input is generated only from the SHA-verified pg_dump archive's
    # whitelisted TABLE DATA entries. Never scan/filter customer COPY row text.
    need(copy_sql == '__XMAIL_DATA_STREAM__' or isinstance(copy_sql, str) and 'COPY public.' in copy_sql)
    need(isinstance(controls, list) and controls and len(controls) <= 10000)
    for row in controls:
        need(set(row) == {'id', 'present', 'disabled', 'valid'} and row['present'] is True and row['valid'] is True
             and type(row['disabled']) is bool and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', row['id']))
    need(len({r['id'] for r in controls}) == len(controls))
    need(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', cutoff))
    lines = ["BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL transaction_timeout='240s'; "
             "SET LOCAL statement_timeout='180s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='45s'; "
             "SET LOCAL maintenance_work_mem='16MB'; SET LOCAL work_mem='2MB'; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; "
             "SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL search_path=public,pg_catalog;",
             "DO $$ BEGIN IF NOT pg_try_advisory_xact_lock(190732,4) THEN RAISE EXCEPTION 'Final refresh already active'; END IF; END $$;",
             'LOCK TABLE '+','.join('public.'+identifier(t) for t in sorted(tables+IDENTITY))+' IN ACCESS EXCLUSIVE MODE;',
             CANDIDATE_GUARD]
    if expected_schema is not None:
        expected = encoded(expected_schema).decode().replace("'", "''")
        lines.append("DO $schema_guard$ BEGIN IF (SELECT schema FROM ("+business_schema_sql()+") q) IS DISTINCT FROM '"+expected+"'::jsonb THEN RAISE EXCEPTION 'Business schema changed before refresh'; END IF; END $schema_guard$;")
    lines.append('CREATE TEMP TABLE prior_controls ON COMMIT DROP AS SELECT * FROM public.xmail_identity_user_controls;')
    for fk in fks: lines.append('ALTER TABLE public.'+identifier(fk['table'])+' DROP CONSTRAINT '+identifier(fk['name'])+';')
    for table in tables: lines.append('ALTER TABLE public.'+identifier(table)+' DISABLE TRIGGER USER;')
    lines += ['TRUNCATE TABLE '+','.join('public.'+identifier(t) for t in sorted(tables+['xmail_identity_user_controls']))+';',
              '\\o /dev/null', copy_sql, '\\o', 'SET LOCAL search_path=public,pg_catalog;']
    values = ','.join("('%s'::uuid,%s)" % (r['id'], 'true' if r['disabled'] else 'false') for r in controls)
    lines.append("INSERT INTO public.xmail_identity_user_controls(user_id,disabled_at,sessions_valid_after,review_source,reviewed_at) "
                 "SELECT v.id,CASE WHEN v.disabled OR p.disabled_at IS NOT NULL THEN coalesce(p.disabled_at,'%s'::timestamptz) ELSE NULL END,"
                 "greatest(coalesce(p.sessions_valid_after,'epoch'),'%s'::timestamptz),'final-data-cutover-auth-exact-uuid','%s'::timestamptz "
                 "FROM (VALUES %s) v(id,disabled) LEFT JOIN prior_controls p ON p.user_id=v.id;" % (cutoff, cutoff, cutoff, values))
    for fk in fks:
        prefix = 'ALTER TABLE public.'+identifier(fk['table'])
        lines.append(prefix+' ADD CONSTRAINT '+identifier(fk['name'])+' '+fk['definition']+' NOT VALID;')
        lines.append(prefix+' VALIDATE CONSTRAINT '+identifier(fk['name'])+';')
    for trigger in triggers or []:
        need(trigger['table'] in tables and trigger['mode'] in ['O', 'D', 'R', 'A'])
        action = {'O': 'ENABLE', 'D': 'DISABLE', 'R': 'ENABLE REPLICA', 'A': 'ENABLE ALWAYS'}[trigger['mode']]
        lines.append('ALTER TABLE public.'+identifier(trigger['table'])+' '+action+' TRIGGER '+identifier(trigger['name'])+';')
    for sequence in sequences or []:
        lines.append('ALTER SEQUENCE public.'+identifier(sequence['name'])+' RESTART WITH '+str(next_sequence_value(sequence))+';')
    lines += ["DO $$ BEGIN IF (SELECT count(*) FROM public.users)<>(SELECT count(*) FROM public.xmail_identity_user_controls) "
              "OR EXISTS(SELECT FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f' AND NOT c.convalidated) "
              "THEN RAISE EXCEPTION 'Final data/control validation refused'; END IF; END $$;", fingerprints_sql()+';', '\\echo REFRESH_READY']
    return '\n'.join(lines)+'\n'


CANDIDATE_GUARD = """DO $$ BEGIN
 IF current_database()<>'xmail' OR current_user<>'xmail_owner' OR session_user<>'xmail_owner'
 OR current_setting('server_version_num')::int/10000<>17
 OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())<>'xmail_owner'
 OR (SELECT count(*) FROM pg_tables WHERE schemaname='public')<>74
 OR EXISTS(SELECT FROM pg_tables WHERE schemaname='public' AND tableowner<>'xmail_owner')
 OR (SELECT count(*) FROM supabase_migrations.schema_migrations)<>80
 OR (SELECT max(version) FROM supabase_migrations.schema_migrations)<>'080'
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN
 ('xmail_identity_bindings','xmail_identity_browser_challenges','xmail_identity_owned_sessions','xmail_identity_user_controls') AND c.relkind='r' AND c.relrowsecurity)<>4
 OR EXISTS(SELECT FROM public.xmail_identity_bindings) OR EXISTS(SELECT FROM public.xmail_identity_owned_sessions)
 OR EXISTS(SELECT FROM public.xmail_identity_browser_challenges)
 OR EXISTS(SELECT FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT g.tgisinternal AND c.relname IN
    ('xmail_identity_bindings','xmail_identity_browser_challenges','xmail_identity_owned_sessions','xmail_identity_user_controls'))
 OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader') AND NOT rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolbypassrls
    AND rolconnlimit=CASE rolname WHEN 'xmail_runtime' THEN 20 ELSE 2 END)<>2
 OR EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('xmail_runtime','xmail_staging_reader'))
 OR EXISTS(SELECT FROM pg_roles r WHERE r.rolname IN ('xmail_runtime','xmail_staging_reader') AND
    (has_schema_privilege(r.rolname,'public','CREATE') OR has_database_privilege(r.rolname,'xmail','CREATE,TEMPORARY')))
 OR EXISTS(SELECT FROM pg_tables t CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(v)
    WHERE schemaname='public' AND NOT has_table_privilege('xmail_runtime',quote_ident(schemaname)||'.'||quote_ident(tablename),p.v))
 OR EXISTS(SELECT FROM pg_tables WHERE schemaname='public' AND
    (NOT has_table_privilege('xmail_staging_reader',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT')
     OR has_table_privilege('xmail_staging_reader',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('xmail_runtime',quote_ident(schemaname)||'.'||quote_ident(tablename),'TRUNCATE,REFERENCES,TRIGGER')))
 OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND has_function_privilege('xmail_staging_reader',p.oid,'EXECUTE'))
 OR EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'
    AND (NOT has_sequence_privilege('xmail_runtime',c.oid,'USAGE') OR NOT has_sequence_privilege('xmail_runtime',c.oid,'SELECT')
      OR has_sequence_privilege('xmail_runtime',c.oid,'UPDATE') OR has_sequence_privilege('xmail_staging_reader',c.oid,'USAGE,UPDATE')))
 OR EXISTS(SELECT FROM pg_stat_activity WHERE datname='xmail' AND pid<>pg_backend_pid())
 THEN RAISE EXCEPTION 'Final data target/control authority refused'; END IF;
END $$;"""


def sequences_sql():
    return """SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'increment',s.seqincrement::text,
      'minimum',s.seqmin::text,'maximum',s.seqmax::text,'start',s.seqstart::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
      'type',format_type(s.seqtypid,NULL),'ownerTable',ot.relname,'ownerColumn',a.attname,
      'last',((xpath('/row/last_value/text()',v.value))[1]::text),'called',((xpath('/row/is_called/text()',v.value))[1]::text)::boolean)
      ORDER BY c.relname),'[]'::jsonb) FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i')
      LEFT JOIN pg_class ot ON ot.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=ot.oid AND a.attnum=d.refobjsubid
      CROSS JOIN LATERAL (SELECT query_to_xml(format('SELECT last_value,is_called FROM public.%I',c.relname),false,true,'') AS value) v
      WHERE n.nspname='public'"""


def next_sequence_value(sequence):
    last, increment = int(sequence['last']), int(sequence['increment'])
    need(type(sequence['called']) is bool and increment != 0)
    value = last+increment if sequence['called'] else last
    minimum, maximum = int(sequence['minimum']), int(sequence['maximum'])
    if not minimum <= value <= maximum:
        need(sequence['cycle'] is True)
        value = minimum if increment > 0 else maximum
    return value


def sequence_definitions(sequences):
    return [{k: v for k, v in s.items() if k not in ['last', 'called']} for s in sequences]


def trigger_inventory_sql():
    names = ','.join("'"+n+"'" for n in IDENTITY)
    return "SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',g.tgname,'mode',g.tgenabled) ORDER BY c.relname,g.tgname),'[]'::jsonb) " \
        "FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace " \
        "WHERE n.nspname='public' AND NOT g.tgisinternal AND c.relname NOT IN ("+names+")"


def source_snapshot_sql():
    return "SELECT jsonb_build_object('schema',(SELECT schema FROM ("+business_schema_sql()+") q)," \
        "'fingerprints',("+fingerprints_sql()+"),'controls',("+control_source_sql()+"),'sequences',("+sequences_sql()+")," \
        "'unsafeDispatches',("+dispatch_admission_sql()+")," \
        "'capturedAt',to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) AS manifest"


def dispatch_admission_sql():
    # The legacy delivery worker has no persisted in-flight marker. An empty
    # dispatchable queue is its conservative freeze boundary; held mail stays held.
    return "SELECT (SELECT count(*) FROM public.deliveries d JOIN public.messages m ON m.id=d.message_id " \
        "WHERE d.status IN ('pending','queued') AND NOT m.held) + " \
        "(SELECT count(*) FROM public.inbox_send_commands WHERE status='sending' " \
        "OR (status='queued' AND lease_token IS NOT NULL)) + " \
        "(SELECT count(*) FROM public.outreach_emails WHERE status IN ('pending','queued') " \
        "AND (lease_token IS NOT NULL OR dispatch_started_at IS NOT NULL))"


def json_result(raw):
    value = json.loads(raw)
    need(isinstance(value, (dict, list)))
    return value


def validate_source_snapshot(value):
    need(isinstance(value, dict) and set(value) == {'schema', 'fingerprints', 'controls', 'sequences', 'unsafeDispatches', 'capturedAt'})
    need(type(value['unsafeDispatches']) is int and value['unsafeDispatches'] == 0)
    tables = value['schema']['tables']
    need(isinstance(tables, dict) and len(tables) == 70 and not set(tables)&set(IDENTITY))
    need(set(value['fingerprints']) == set(tables))
    for item in value['fingerprints'].values():
        need(set(item) == {'count', 'sha256'} and type(item['count']) is int and item['count'] >= 0
             and re.fullmatch(r'[a-f0-9]{64}', item['sha256']))
    controls = value['controls']
    need(isinstance(controls, list) and len(controls) == value['fingerprints']['users']['count'] and controls)
    for row in controls:
        need(set(row) == {'id', 'present', 'disabled', 'valid'} and row['present'] is True and row['valid'] is True
             and type(row['disabled']) is bool and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', row['id']))
    need(len({r['id'] for r in controls}) == len(controls))
    for sequence in value['sequences']: next_sequence_value(sequence)
    need(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value['capturedAt']))


def line(process, seconds=40, maximum=65536):
    import selectors
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    result = bytearray(); end = time.monotonic()+seconds
    try:
        while time.monotonic() < end:
            need(selector.select(max(0, end-time.monotonic())))
            character = os.read(process.stdout.fileno(), 1)
            need(character)
            if character == b'\n': return bytes(result)
            result.extend(character); need(len(result) <= maximum)
        raise ValueError('Bounded protocol read failed')
    finally: selector.close()


def archive_command(arguments, destination):
    import resource
    def bounds(): resource.setrlimit(resource.RLIMIT_FSIZE, (MAXIMUM, MAXIMUM))
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        result = subprocess.run(arguments, stdout=output, stderr=subprocess.PIPE, timeout=180, check=False, preexec_fn=bounds)
        need(result.returncode == 0)
        output.flush(); os.fsync(output.fileno())
    fsync_directory(destination.parent)
    need(0 < destination.stat().st_size <= MAXIMUM)
    return sha(destination.read_bytes())


def capacity():
    memory = dict(re.findall(r'^(\w+):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M))
    need(int(memory['MemAvailable']) >= 786432 and int(memory['SwapTotal'])-int(memory['SwapFree']) <= 524288)
    need(shutil.disk_usage('/opt').free >= 3*1024**3 and shutil.disk_usage('/tmp').free >= 3*1024**3)
    need(call(['stat', '-f', '-c', '%T', '/tmp']).decode().strip() not in ['tmpfs', 'ramfs', 'hugetlbfs', 'devtmpfs'])


def postgres_scram(password):
    import hmac
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
    stored = hashlib.sha256(hmac.digest(salted, b'Client Key', 'sha256')).digest()
    server = hmac.digest(salted, b'Server Key', 'sha256')
    return 'SCRAM-SHA-256$4096:'+base64.b64encode(salt).decode()+'$'+base64.b64encode(stored).decode()+':'+base64.b64encode(server).decode()


def env_bytes(values):
    need(all(isinstance(v, str) and not any(ord(c) < 32 for c in v) for v in values.values()))
    return ''.join(k+'='+v+'\n' for k, v in values.items()).encode()


def source_client(arguments, name, nonce, env_file, image=OLD_IMAGE):
    return ['docker', 'run', '--rm', '--pull=never', '-i', '--name', name,
            '--label', 'com.skale.xmail-final-data='+nonce, '--log-driver=none', '--network', 'coolify',
            '--read-only', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--env-file', str(env_file),
            '--entrypoint', 'node', image]+arguments


def node_snapshot(program, source_file, ca, nonce, name, image=OLD_IMAGE):
    marker = 'await tx.unsafe("SET LOCAL timezone=\'UTC\'");'
    need(program.count(marker) == 1)
    program = program.replace(marker, marker+'await tx.unsafe("SET LOCAL search_path=public,pg_catalog");await tx.unsafe("SET LOCAL work_mem=\'2MB\'");')
    initial = base64.b64encode(ca)+b'\n'+base64.b64encode(source_snapshot_sql().encode())+b'\n'
    return source_client(['-e', program], name, nonce, source_file, image), initial


def copy_data_sql(archive, work, tables, nonce):
    def restore(arguments, destination=None):
        command = ['docker', 'run', '--rm', '--pull=never', '--name', 'xmail-final-restore-'+nonce,
            '--label', 'com.skale.xmail-final-data='+nonce, '--log-driver=none', '--network', 'none', '--read-only',
            '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--mount', 'type=bind,src='+str(work)+',dst=/archive,readonly', PG_IMAGE, 'pg_restore']+arguments
        return archive_command(command, destination) if destination else call(command, timeout=45)
    listing = restore(['--list', '/archive/'+archive.name]).decode()
    selected = []
    for entry in listing.splitlines():
        if not entry or entry.startswith(';'): continue
        match = re.fullmatch(r'\d+; \d+ \d+ TABLE DATA public ([a-z_][a-z0-9_]*) \S+', entry)
        if match:
            need(match[1] in tables); selected.append((match[1], entry))
    need(len(selected) == 70 and {name for name, _ in selected} == set(tables))
    durable_file(work/'data.list', ('\n'.join(entry for _, entry in selected)+'\n').encode())
    raw_path = work/'copy.raw.sql'
    restore(['--no-owner', '--no-acl', '--use-list=/archive/data.list', '--file=-', '/archive/'+archive.name], raw_path)
    final_path = work/'copy.sql'
    removed = 0; body = False
    preamble = {b'SET statement_timeout = 0;', b'SET lock_timeout = 0;',
                b'SET idle_in_transaction_session_timeout = 0;', b'SET transaction_timeout = 0;'}
    with raw_path.open('rb') as source, final_path.open('xb') as destination:
        os.chmod(final_path, 0o600)
        for row in source:
            if row.startswith(b'-- Name:'): body = True
            if not body and row.rstrip(b'\r\n') in preamble: removed += 1
            else: destination.write(row)
        destination.flush(); os.fsync(destination.fileno())
    need(removed == 4); fsync_directory(work)
    return final_path


def ensure_no_other_writers(policy, old, approved):
    for container_id in call(['docker', 'ps', '-q']).decode().split():
        live = inspect(container_id)
        if live['Id'] == old['Id']: continue
        values = policy['container_env'](live)
        writer = live['Name'] in ['/xmail', '/xmail-next', '/skaleclub-mail'] or live['Image'] in [OLD_IMAGE, approved]
        for key in ['DATABASE_URL', 'DIRECT_URL']:
            value = values.get(key, '')
            writer = writer or SOURCE_PROJECT in value or (TARGET in value and 'xmail_runtime' in value)
        need(not writer)


def prepare_runtime_files(args, policy, source_env):
    runtime_password, reader_password = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
    runtime_url = 'postgres://xmail_runtime:'+runtime_password+'@'+TARGET+':5432/xmail'
    profile = {'DATABASE_URL': runtime_url, 'DIRECT_URL': runtime_url,
        'XMAIL_BROWSER_AUTH_AUTHORITY': 'legacy', 'XMAIL_USER_ADMIN_AUTHORITY': 'legacy', 'XMAIL_OWNED_AUTH_PHASE': 'data',
        'DB_POOL_MAX': str(args.http_pool), 'DB_JOB_POOL_MAX': '12', 'XMAIL_ADMIN_DB_POOL_MAX': '2',
        'XMAIL_DB_ROLE_CONNECTION_LIMIT': '20', 'XMAIL_DB_CONNECTION_RESERVE': '2', 'XMAIL_DB_PROCESS_COUNT': '1',
        'XMAIL_OWNED_DEPLOY_MODE': 'promote', 'XMAIL_OWNED_APPROVED_IMAGE_ID': args.approved_image_id,
        'XMAIL_OWNED_APPROVED_SOURCE_SHA': args.approved_source_sha, 'XMAIL_OWNED_RECEIPT_SHA256': '0'*64}
    reader = {'NODE_ENV': 'production', 'XMAIL_STAGING_HTTP_ONLY': 'true',
        'XMAIL_STAGING_ORIGIN': 'http://127.0.0.1:9001', 'XMAIL_GOOGLE_AUTH_ENABLED': 'false', 'GOOGLE_AUTH_ENABLED': 'false',
        'XMAIL_STAGING_DATABASE_URL': 'postgres://xmail_staging_reader:'+reader_password+'@'+TARGET+':5432/xmail'}
    base = {k: v for k, v in source_env.items() if k in policy['BASE_KEYS']}
    durable_file(OPS/'production-base.env', env_bytes(base))
    durable_file(OPS/'reader.env', env_bytes(reader))
    durable_file(OPS/'owned-runtime.env', env_bytes(profile))
    # This validates only syntax/targets. No cutover receipt exists yet, so the
    # deployment consumer still refuses to execute this incomplete profile.
    policy['profiles'](OPS)
    expiry = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=15)).strftime('%Y-%m-%d %H:%M:%S+00')
    role_sql = "DO $$ BEGIN IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader') "
    role_sql += "AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolbypassrls "
    role_sql += "AND rolconnlimit=CASE rolname WHEN 'xmail_runtime' THEN 20 ELSE 2 END)<>2 "
    role_sql += "OR EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('xmail_runtime','xmail_staging_reader')) "
    role_sql += "OR EXISTS(SELECT FROM pg_tables t CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(v) "
    role_sql += "WHERE schemaname='public' AND NOT has_table_privilege('xmail_runtime',quote_ident(schemaname)||'.'||quote_ident(tablename),p.v)) "
    role_sql += "OR EXISTS(SELECT FROM pg_tables WHERE schemaname='public' AND NOT has_table_privilege('xmail_staging_reader',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT')) "
    role_sql += "THEN RAISE EXCEPTION 'Final runtime grant admission refused'; END IF; END $$;\n"
    role_sql += "ALTER ROLE xmail_runtime LOGIN PASSWORD '"+postgres_scram(runtime_password)+"' VALID UNTIL 'infinity';\n"
    role_sql += "ALTER ROLE xmail_staging_reader LOGIN PASSWORD '"+postgres_scram(reader_password)+"' VALID UNTIL '"+expiry+"';\n"
    return profile, role_sql


def finish_receipts(args, policy, old, source, bundle, frozen_at, profile):
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    frozen = frozen_at.replace(microsecond=0)
    expiry = frozen+dt.timedelta(minutes=15)
    need(now < expiry)
    stamp = lambda value: value.strftime('%Y-%m-%dT%H:%M:%SZ')
    common = {'version': 1, 'app': 'xmail', 'target': TARGET, 'database': 'xmail', 'role': 'xmail_runtime',
        'postgresImage': PG_IMAGE, 'applicationImage': args.approved_image_id, 'sourceSha': args.approved_source_sha,
        'authPhase': 'data', 'sourceKind': 'supabase', 'oldContainerId': old['Id'], 'createdAt': stamp(now), 'expiresAt': stamp(expiry)}
    pointers = {}
    def proof(kind, facts, created=None):
        value = {**common, 'kind': kind, 'facts': facts, 'createdAt': stamp(created or now)}
        raw = encoded(value); filename = policy['PROOF_FILES'][kind]
        durable_file(OPS/filename, raw)
        pointers[kind] = {'file': filename, 'sha256': sha(raw)}
    proof('freeze', {'allSourceWritersStopped': True, 'oldContainerStopped': True}, frozen)
    proof('snapshot', {'sourceReadOnlySnapshotComplete': True, 'snapshotDigest': sha((bundle/'private-work/source.dump').read_bytes()), 'businessTables': 70})
    proof('final-import', {'snapshotReceiptSha256': pointers['snapshot']['sha256'], 'restoredAndReconciled': True,
        'nativeHashesPreserved': True, 'referenceMetadataPreserved': True, 'identityTables': 4, 'businessTables': 70})
    proof('controls', {'snapshotReceiptSha256': pointers['snapshot']['sha256'], 'exactUuidControlsReviewed': True,
        'disabledStatePreserved': True, 'noContactAutoLinks': True, 'runtimeGrantsReviewed': True})
    _, _, profile_digest, _, _ = policy['profiles'](OPS)
    receipt = {**common, 'oldImageId': old['Image'], 'profileDigest': profile_digest,
        'baseEnvironmentSha256': sha((OPS/'production-base.env').read_bytes()), 'proofs': pointers}
    raw = encoded(receipt)
    durable_file(OPS/'cutover-receipt.json', raw)
    profile['XMAIL_OWNED_RECEIPT_SHA256'] = sha(raw)
    durable_file(OPS/'owned-runtime.env', env_bytes(profile), replace=True)
    durable_file(bundle/'data-refresh-committed.json', encoded({'dataRefreshCommitted': True, 'businessFingerprintsMatched': 70,
        'identitySchemaPreserved': True, 'nativeHashesAndMembershipsPreserved': True, 'sequenceState': 'equivalent-next-value',
        'applicationStarted': False, 'browserAuthority': 'legacy', 'googleEnabled': False}))
    with open(os.devnull, 'w') as sink:
        import contextlib
        with contextlib.redirect_stdout(sink): policy['execute']('inspect')


def apply(args):
    import fcntl
    need(os.geteuid() == 0 and re.fullmatch(r'sha256:[a-f0-9]{64}', args.approved_image_id or '')
         and re.fullmatch(r'[a-f0-9]{40}', args.approved_source_sha or '')
         and re.fullmatch(r'[a-f0-9]{64}', args.policy_sha256 or '')
         and re.fullmatch(r'[a-f0-9]{64}', args.old_container_id or '') and args.http_pool in [1, 2, 3, 4])
    directory = Path(__file__).resolve().parent
    policy, programs = load_public_sources(directory, args.policy_sha256)
    for path in [Path('/opt'), Path('/opt/xmail')]: policy['secure_directory'](path)
    capacity()
    if not OPS.exists(): OPS.mkdir(mode=0o700); fsync_directory(OPS.parent)
    policy['secure_directory'](OPS, True)
    need(not any((OPS/name).exists() or (OPS/name).is_symlink() for name in
         ['owned-runtime.env', 'reader.env', 'production-base.env', 'cutover-receipt.json']))
    lock_fd = os.open(OPS/'deploy.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock_stat = os.fstat(lock_fd)
    need(lock_stat.st_uid == lock_stat.st_gid == 0 and stat.S_IMODE(lock_stat.st_mode) == 0o600
         and lock_stat.st_nlink == 1 and lock_stat.st_size == 0)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    old = inspect(args.old_container_id)
    need(old['Id'] == args.old_container_id and old['Name'] == '/xmail' and old['Image'] == args.approved_image_id
         and old['State']['Running'] is True and old['State'].get('Health', {}).get('Status') == 'healthy')
    source_env = policy['container_env'](old)
    need(source_env.get('NODE_ENV') == 'production' and source_env.get('NODE_TLS_REJECT_UNAUTHORIZED') != '0'
         and source_env.get('SUPABASE_URL', '').rstrip('/') == 'https://'+SOURCE_PROJECT+'.supabase.co'
         and source_env.get('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy') == source_env.get('XMAIL_USER_ADMIN_AUTHORITY', 'legacy') == 'legacy'
         and source_env.get('XMAIL_GOOGLE_AUTH_ENABLED', 'false') == 'false')
    policy['source_database_url'](source_env['DATABASE_URL'])
    policy['source_database_url'](source_env.get('DIRECT_URL') or source_env['DATABASE_URL'])
    approved = inspect(args.approved_image_id)
    need(approved['Id'] == args.approved_image_id and
         (approved['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') == args.approved_source_sha)
    google_directory = Path('/opt/xmail/google-identity-ops')
    policy['secure_directory'](google_directory, True)
    google_raw = policy['secure_read'](google_directory/'google-auth.env', 16384)
    need(b'XMAIL_GOOGLE_AUTH_ENABLED=false\n' in google_raw and b'XMAIL_GOOGLE_AUTH_ENABLED=true' not in google_raw)
    candidate = inspect(TARGET)
    pgdata = [m for m in candidate.get('Mounts', []) if m.get('Destination') == '/var/lib/postgresql/data']
    need(candidate['Image'] == PG_IMAGE and candidate['State']['Running'] is True and candidate['State'].get('Health', {}).get('Status') == 'healthy'
         and not any((candidate['NetworkSettings'].get('Ports') or {}).values()) and len(pgdata) == 1
         and pgdata[0].get('Name') == 'postgres-data-'+TARGET and pgdata[0].get('Type') == 'volume' and pgdata[0].get('RW') is True
         and candidate['HostConfig']['Memory'] == candidate['HostConfig']['MemorySwap'] == 536870912
         and candidate['HostConfig']['NanoCpus'] == 750000000)
    target_free = call(['docker', 'exec', TARGET, 'df', '-Pk', '/var/lib/postgresql/data']).decode().splitlines()[-1].split()[3]
    target_fs = call(['docker', 'exec', TARGET, 'stat', '-f', '-c', '%T', '/var/lib/postgresql/data']).decode().strip()
    need(int(target_free) >= 2097152 and target_fs not in ['tmpfs', 'ramfs', 'hugetlbfs', 'devtmpfs'])
    read_only(CANDIDATE_GUARD)
    candidate_schema = json_result(read_only(business_schema_sql()))
    sequences = json_result(read_only(sequences_sql()))
    fks = json_result(read_only(fk_inventory_sql()))
    triggers = json_result(read_only(trigger_inventory_sql()))
    need(fks and all(fk['validated'] is True and fk['tableSchema'] == fk['referenceSchema'] == 'public' for fk in fks))
    need(len(candidate_schema['tables']) == 70)
    ensure_no_other_writers(policy, old, args.approved_image_id)
    backup_parent = Path('/opt/xmail/backups')
    if not backup_parent.exists(): backup_parent.mkdir(mode=0o700); fsync_directory(backup_parent.parent)
    policy['secure_directory'](backup_parent, True)
    nonce = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
    bundle = backup_parent/('final-data-'+nonce); bundle.mkdir(mode=0o700); fsync_directory(backup_parent)
    work = bundle/'private-work'; work.mkdir(mode=0o700); fsync_directory(bundle)
    backup_sha = archive_command(['docker', 'exec', TARGET, 'pg_dump', '-U', 'xmail_owner', '-d', 'xmail',
        '--format=custom', '--compress=6', '--no-owner', '--no-acl'], bundle/'candidate-before.dump')
    durable_file(bundle/'candidate-before.sha256', (backup_sha+'  candidate-before.dump\n').encode())
    durable_file(bundle/'candidate-schema.json', encoded(candidate_schema))
    durable_file(bundle/'candidate-fks.json', encoded(fks))
    durable_file(bundle/'candidate-sequences.json', encoded(sequences))
    durable_file(bundle/'candidate-triggers.json', encoded(triggers))
    source_file = work/'source-reader.env'
    durable_file(source_file, env_bytes({'NODE_ENV': 'production', 'SUPABASE_URL': source_env['SUPABASE_URL'],
        'DATABASE_URL': source_env.get('DIRECT_URL') or source_env['DATABASE_URL']}))
    resources = []; holder = None; transaction = None; committed = False
    try:
        ca = call(source_client(['-e', programs['ca_program']], 'xmail-final-ca-'+nonce, nonce, source_file, old['Image']), timeout=20)
        durable_file(work/'source-ca.crt', ca)
        # Schema parity is proved before stopping production, then checked again
        # under the target lock and against the final frozen snapshot.
        command, initial = node_snapshot(programs['holder_program'], source_file, ca, nonce, 'xmail-final-preflight-'+nonce, old['Image'])
        preflight = call(command, initial+b'DUMP_COMPLETE\n', timeout=60).splitlines()
        need(len(preflight) == 3 and preflight[2] == b'SOURCE_CLOSED')
        preliminary = json_result(preflight[1]); validate_source_snapshot(preliminary)
        need(preliminary['schema'] == candidate_schema and sequence_definitions(preliminary['sequences']) == sequence_definitions(sequences))
        ensure_no_other_writers(policy, old, args.approved_image_id)
        # This is the first production mutation. No failure path restarts OLD.
        call(['docker', 'update', '--restart=no', old['Id']])
        call(['docker', 'stop', '--time=20', old['Id']], timeout=30)
        stopped = inspect(old['Id'])
        need(stopped['State']['Running'] is False and stopped['State'].get('Pid', 0) == 0 and stopped['Image'] == old['Image']
             and stopped['State'].get('ExitCode') == 0 and stopped['State'].get('OOMKilled') is False)
        frozen_at = dt.datetime.now(dt.timezone.utc)
        command, initial = node_snapshot(programs['holder_program'], source_file, ca, nonce, 'xmail-final-source-'+nonce, old['Image'])
        resources.append('xmail-final-source-'+nonce)
        error_fd = os.open(work/'source-protocol.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(error_fd, 'wb') as errors:
            holder = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, bufsize=0)
            holder.stdin.write(initial); holder.stdin.flush()
            snapshot_id = line(holder).decode()
            need(re.fullmatch(r'[a-fA-F0-9]{8}-[a-fA-F0-9]{8}-[0-9]+', snapshot_id))
            source = json_result(line(holder)); validate_source_snapshot(source)
            need(source['schema'] == candidate_schema and sequence_definitions(source['sequences']) == sequence_definitions(sequences))
            from urllib.parse import urlsplit, unquote
            u = urlsplit(source_env.get('DIRECT_URL') or source_env['DATABASE_URL'])
            pg_env = {'PGHOST': u.hostname, 'PGPORT': '5432', 'PGDATABASE': 'postgres', 'PGUSER': unquote(u.username),
                'PGPASSWORD': unquote(u.password), 'PGSSLMODE': 'verify-full', 'PGSSLROOTCERT': '/source-ca.crt', 'PGCONNECT_TIMEOUT': '8',
                'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=2000'}
            durable_file(work/'source-pg.env', env_bytes(pg_env))
            archive = work/'source.dump'
            dump_command = ['docker', 'run', '--rm', '--pull=never', '--name', 'xmail-final-dump-'+nonce,
                '--label', 'com.skale.xmail-final-data='+nonce, '--log-driver=none', '--network', 'coolify', '--read-only',
                '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--env-file', str(work/'source-pg.env'),
                '--mount', 'type=bind,src='+str(work/'source-ca.crt')+',dst=/source-ca.crt,readonly', PG_IMAGE,
                'pg_dump', '--format=custom', '--compress=6', '--schema=public', '--schema=supabase_migrations', '--strict-names',
                '--no-owner', '--no-acl', '--no-comments', '--snapshot='+snapshot_id, '--lock-wait-timeout=5s']
            resources.append('xmail-final-dump-'+nonce)
            archive_sha = archive_command(dump_command, archive)
            holder.stdin.write(b'DUMP_COMPLETE\n'); holder.stdin.close()
            need(line(holder, 10) == b'SOURCE_CLOSED' and holder.wait(timeout=10) == 0); holder = None
        durable_file(bundle/'source-snapshot.json', encoded(source))
        durable_file(bundle/'source-snapshot.sha256', (archive_sha+'  private-work/source.dump\n').encode())
        data_file = copy_data_sql(archive, work, list(source['schema']['tables']), nonce)
        capacity(); read_only(CANDIDATE_GUARD)
        profile, role_sql = prepare_runtime_files(args, policy, source_env)
        script = refresh_sql(list(source['schema']['tables']), fks, '__XMAIL_DATA_STREAM__', source['controls'], source['capturedAt'],
                             source['schema'], source['sequences'], triggers)
        prefix, suffix = script.split('__XMAIL_DATA_STREAM__', 1)
        error_fd = os.open(work/'target-protocol.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(error_fd, 'wb') as errors:
            transaction = subprocess.Popen(['docker', 'exec', '-i', TARGET, 'psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1',
                '-U', 'xmail_owner', '-d', 'xmail'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, bufsize=0)
            transaction.stdin.write(prefix.encode())
            with data_file.open('rb') as data:
                while chunk := data.read(65536): transaction.stdin.write(chunk)
            transaction.stdin.write(suffix.encode()); transaction.stdin.flush()
            actual = json_result(line(transaction, 180, 4*1024*1024))
            need(actual == source['fingerprints'] and line(transaction, 5) == b'REFRESH_READY')
            # No receipt claims success before both pre-COMMIT reconciliation and
            # a fresh source snapshot agree with the frozen source.
            command, initial = node_snapshot(programs['holder_program'], source_file, ca, nonce, 'xmail-final-stability-'+nonce, old['Image'])
            stability = call(command, initial+b'DUMP_COMPLETE\n', timeout=60).splitlines()
            need(len(stability) == 3 and stability[2] == b'SOURCE_CLOSED')
            current = json_result(stability[1]); validate_source_snapshot(current)
            need({k: v for k, v in current.items() if k != 'capturedAt'} == {k: v for k, v in source.items() if k != 'capturedAt'})
            durable_file(bundle/'target-uncommitted-fingerprints.json', encoded(actual))
            durable_file(bundle/'commit-attempt.json', encoded({'commitAttempted': True, 'commitAcknowledged': False}))
            transaction.stdin.write(role_sql.encode()+b'COMMIT;\n\\echo REFRESH_COMMITTED\n'); transaction.stdin.flush()
            need(line(transaction, 15) == b'REFRESH_COMMITTED')
            transaction.stdin.close(); need(transaction.wait(timeout=10) == 0); transaction = None; committed = True
        durable_file(bundle/'commit-acknowledged.json', encoded({'commitAcknowledged': True, 'readbackComplete': False}))
        need(json_result(read_only(fingerprints_sql())) == source['fingerprints'])
        need(json_result(read_only(business_schema_sql())) == source['schema'])
        need(json_result(read_only(fk_inventory_sql())) == fks)
        after_sequences = json_result(read_only(sequences_sql()))
        need(sequence_definitions(after_sequences) == sequence_definitions(source['sequences'])
             and [next_sequence_value(s) for s in after_sequences] == [next_sequence_value(s) for s in source['sequences']])
        need(json_result(read_only(trigger_inventory_sql())) == triggers)
        command, initial = node_snapshot(programs['holder_program'], source_file, ca, nonce, 'xmail-final-postcommit-'+nonce, old['Image'])
        final_source = call(command, initial+b'DUMP_COMPLETE\n', timeout=60).splitlines()
        need(len(final_source) == 3 and final_source[2] == b'SOURCE_CLOSED')
        final_snapshot = json_result(final_source[1]); validate_source_snapshot(final_snapshot)
        need({k: v for k, v in final_snapshot.items() if k != 'capturedAt'} == {k: v for k, v in source.items() if k != 'capturedAt'})
        durable_file(bundle/'source-postcommit-snapshot.json', encoded(final_snapshot))
        finish_receipts(args, policy, old, source, bundle, frozen_at, profile)
        result = {'dataRefreshCommitted': True, 'businessFingerprintsMatched': 70, 'identityDdlPreserved': True,
            'nativeHashesAndMembershipsPreserved': True, 'oldWriterStopped': True, 'browserAuthority': 'legacy',
            'googleEnabled': False, 'applicationCutover': False, 'privateBackupRetained': True}
    finally:
        for process in [holder, transaction]:
            if process:
                try: process.stdin.close()
                except Exception: pass
                try: process.wait(timeout=5)
                except Exception: process.kill(); process.wait(timeout=5)
        cleanup_failed = False
        for name in resources+['xmail-final-restore-'+nonce]:
            try:
                values = call(['docker', 'ps', '-aq', '--filter', 'name=^/'+name+'$']).decode().split()
                for value in values:
                    state = inspect(value)
                    need((state['Config'].get('Labels') or {}).get('com.skale.xmail-final-data') == nonce)
                    call(['docker', 'rm', '-f', state['Id']])
            except Exception: cleanup_failed = True
        # Retain dumps/diagnostics and a failed/ambiguous candidate for review;
        # only the two temporary source credentials are unlinked explicitly.
        for name in ['source-reader.env', 'source-pg.env']:
            path = work/name
            if path.exists(): path.unlink()
        fsync_directory(work)
        os.close(lock_fd)
        need(not cleanup_failed)
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--approved-image-id')
    parser.add_argument('--approved-source-sha')
    parser.add_argument('--policy-sha256')
    parser.add_argument('--old-container-id')
    parser.add_argument('--http-pool', type=int)
    args = parser.parse_args()
    need(not (args.plan and args.apply))
    if not args.apply:
        print('PLAN ONLY: first Xmail SQL-only cutover; no files, Docker, network, SQL, LOGIN, freeze or deployment.')
        return
    apply(args)


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Final data cutover refused/failed; private diagnostics suppressed.', file=sys.stderr)
        sys.exit(1)
