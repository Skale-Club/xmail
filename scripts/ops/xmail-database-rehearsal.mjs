#!/usr/bin/env node
/** No dotenv loading. Default mode is an offline plan; inventory is explicitly read-only. */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const plan = {
    status: 'offline plan by default; inventory is read-only; this launcher has no write mode',
    source: 'running xmail container DATABASE_URL; credentials remain on its host',
    development: 'reuse an eligible existing isolated target; no new paid Supabase project',
    steps: [
        'Collect read-only catalog inventory and current host capacity',
        'Review Supabase extension/function/trigger/policy dependencies before selecting dump scope',
        'Review the separate host-only rehearsal shell script and capacity limits',
        'After explicit review, pin a local PostgreSQL17 image and dump public plus migration ledger with source read-only options',
        'Restore into a quota-limited, network-none temporary PostgreSQL17 container; never start Xmail',
        'Validate 39 users, 38 memberships and catalog constraints; shared-snapshot fingerprint/sequence reconciliation remains unverified',
        'Remove only the uniquely named rehearsal resources and host-local dump under a cleanup trap',
    ],
}

export function readSshHost(file) {
    const matches = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^\s*(?:export\s+)?HETZNER_IP\s*=/.test(line))
    if (matches.length !== 1) throw new Error('Exactly one declared SSH host is required.')
    let host = matches[0].replace(/^\s*(?:export\s+)?HETZNER_IP\s*=\s*/, '').trim()
    if (/^(['"]).*\1$/.test(host)) host = host.slice(1, -1)
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.split('.').some(part => Number(part) > 255)) throw new Error('An explicit IPv4 SSH host is required.')
    return host
}

export const inventoryProgram = String.raw`
const postgres = require('postgres');
const { X509Certificate } = require('node:crypto');
let stage = 'source-validation';
const deadline = setTimeout(() => { process.stderr.write(JSON.stringify({stage,code:'HARD_TIMEOUT'})); process.exit(124); },35000);
deadline.unref();
(async () => {
  if (process.env.NODE_ENV !== 'production' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Wrong runtime');
  const target = new URL(process.env.DATABASE_URL || '');
  const expected = 'zzbudkfkcmqkavgwselc';
  const project = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(process.env.SUPABASE_URL || '')?.[1];
  const user = decodeURIComponent(target.username);
  const direct = target.hostname === 'db.' + expected + '.supabase.co' && user === 'postgres';
  const pooler = /^aws-[0-9]+-[a-z0-9-]+[.]pooler[.]supabase[.]com$/.test(target.hostname) && user === 'postgres.' + expected;
  if (project !== expected || !['postgres:', 'postgresql:'].includes(target.protocol) || !(direct || pooler)
      || target.pathname !== '/postgres' || !['5432','6543'].includes(target.port) || target.hash || !target.password) throw new Error('Source identity mismatch');
  for (const [key,value] of target.searchParams) {
    if (!['sslmode','application_name'].includes(key) || target.searchParams.getAll(key).length !== 1
        || (key === 'sslmode' && !['require','verify-ca','verify-full'].includes(value))) throw new Error('Source options refused');
  }
  target.search = ''; // Driver URL parameters must never override the explicit TLS object.
  stage = 'public-source-ca';
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt', { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('CA unavailable');
  const ca = await response.text();
  if (ca.length > 32768) throw new Error('CA invalid');
  const certificate = new X509Certificate(ca);
  if (!certificate.ca || !/Supabase/i.test(certificate.subject) || certificate.fingerprint256.replaceAll(':','') !== '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
      || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error('CA invalid');
  // postgres.js ssl:'require' disables certificate verification. This explicit
  // Supabase public CA must verify both the source chain and its exact hostname.
  const sql = postgres(target.href, { max: 1, prepare: false, ssl: { ca, rejectUnauthorized: true, servername: target.hostname }, connect_timeout: 8, idle_timeout: 1, onnotice: () => {} });
  try {
    stage = 'verified-connection';
    const report = await sql.begin('isolation level repeatable read read only', async tx => {
      stage = 'read-only-catalog';
      await tx.unsafe("SET LOCAL statement_timeout = '8000ms'");
      await tx.unsafe("SET LOCAL lock_timeout = '500ms'");
      const one = async query => (await tx.unsafe(query))[0];
      const visibility = await one("SELECT count(*)::int AS tables,count(*) FILTER (WHERE has_table_privilege(c.oid,'SELECT'))::int AS select_access,count(*) FILTER (WHERE c.relrowsecurity AND NOT (r.rolsuper OR r.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE'))))::int AS potentially_filtered_tables,bool_or(r.rolsuper) AS superuser,bool_or(r.rolbypassrls) AS bypass_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user WHERE n.nspname='public' AND c.relkind IN ('r','p')");
      if (visibility.tables !== visibility.select_access || visibility.potentially_filtered_tables !== 0) throw new Error('Unfiltered visibility required');
      const out = { capturedAt: new Date().toISOString(), sourceMatchesRunningAuthProject: true, tlsCertificateAndHostnameVerified: true, sourceCaSha256: certificate.fingerprint256,
        visibility, ownedIdentityFlagEnabled: process.env.XMAIL_GOOGLE_AUTH_ENABLED === 'true',
        database: await one("SELECT current_setting('server_version') AS version, pg_database_size(current_database())::text AS bytes, current_setting('transaction_read_only') AS read_only"),
        publicRelations: await one("SELECT count(*)::int AS tables, coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS total_bytes, count(*) FILTER (WHERE c.relrowsecurity)::int AS rls_enabled FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')"),
        largestPublicTables: await tx.unsafe("SELECT c.relname AS table_name, pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8"),
        extensions: await tx.unsafe("SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname"),
        foreignKeysOutsidePublic: await tx.unsafe("SELECT target.nspname AS target_schema,count(*)::int AS count FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace src ON src.oid=c.relnamespace JOIN pg_class referenced ON referenced.oid=co.confrelid JOIN pg_namespace target ON target.oid=referenced.relnamespace WHERE co.contype='f' AND src.nspname='public' AND target.nspname<>'public' GROUP BY target.nspname ORDER BY target.nspname"),
        functions: await tx.unsafe("SELECT p.proname AS name,p.prosecdef AS security_definer,l.lanname AS language,(pg_get_functiondef(p.oid) ~* '(auth|storage|vault|extensions|supabase)[.]') AS hosted_schema_reference FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.prokind='f' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') ORDER BY p.proname"),
        hostedFunctionReferences: await tx.unsafe("SELECT DISTINCT matches[1] AS schema,matches[2] AS function FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL regexp_matches(pg_get_functiondef(p.oid),'(auth|storage|vault|extensions|supabase)[.]([a-z_][a-z0-9_]*)','gi') matches WHERE n.nspname='public' AND p.prokind='f' ORDER BY 1,2"),
        triggers: await tx.unsafe("SELECT c.relname AS table_name,t.tgname AS trigger_name,fn.nspname AS function_schema,p.proname AS function_name,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname"),
        policies: await one("SELECT count(*)::int AS count,count(*) FILTER (WHERE coalesce(qual,'')||coalesce(with_check,'') ~* '(auth|storage|vault|extensions|supabase)[.]')::int AS hosted_schema_references FROM pg_policies WHERE schemaname='public'"),
        policyRoles: await tx.unsafe("SELECT DISTINCT unnest(roles)::text AS role FROM pg_policies WHERE schemaname='public' ORDER BY role"),
        views: await one("SELECT count(*)::int AS count,count(*) FILTER (WHERE definition ~* '(auth|storage|vault|extensions|supabase)[.]')::int AS hosted_schema_references FROM pg_views WHERE schemaname='public'"),
        columnDefaults: await one("SELECT count(*)::int AS count,count(*) FILTER (WHERE pg_get_expr(d.adbin,d.adrelid) ~* '(auth|storage|vault|extensions|supabase)[.]')::int AS hosted_schema_references FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'"),
        identity: await one("SELECT (SELECT count(*)::int FROM public.users) AS users,(SELECT count(*)::int FROM public.organization_users) AS organization_users,(SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'xmail_identity_%') AS owned_identity_tables"),
      };
      const ledger = await one("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present");
      out.ledger = ledger.present ? await one("SELECT count(*)::int AS count,min(version) AS first,max(version) AS latest FROM supabase_migrations.schema_migrations") : { present: false };
      if (out.database.read_only !== 'on') throw new Error('Read-only transaction required');
      return out;
    });
    process.stdout.write(JSON.stringify(report));
  } finally { await sql.end({ timeout: 2 }); }
})().then(() => clearTimeout(deadline)).catch(error => {
  clearTimeout(deadline);
  const code = /^(?:[0-9A-Z]{5}|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|CONNECT_TIMEOUT)$/.test(error.code || '') ? error.code : 'REDACTED';
  process.stderr.write(JSON.stringify({stage,code})); process.exitCode=1;
});
`

export function runInventory(host) {
    const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', `root@${host}`,
        'docker', 'exec', '-i', 'xmail', 'node'], { input: inventoryProgram, encoding: 'utf8', timeout: 45_000, maxBuffer: 512_000, windowsHide: true })
    if (result.status !== 0 || result.error) {
        try {
            const failure = JSON.parse(result.stderr)
            if (['source-validation', 'public-source-ca', 'verified-connection', 'read-only-catalog'].includes(failure.stage)
                && /^[A-Z0-9_]{5,48}$/.test(failure.code)) console.error(`Inventory stopped at ${failure.stage}; diagnostic ${failure.code}.`)
        } catch { /* Never emit arbitrary remote errors or connection values. */ }
        throw new Error('Read-only SSH inventory failed; no raw remote output was emitted.')
    }
    const report = JSON.parse(result.stdout)
    if (report.database?.read_only !== 'on' || report.sourceMatchesRunningAuthProject !== true || report.tlsCertificateAndHostnameVerified !== true) throw new Error('Inventory did not prove the intended verified read-only source.')
    return report
}

function main() {
    const args = process.argv.slice(2)
    if (args.length === 0 || (args.length === 1 && args[0] === '--plan')) { console.log(JSON.stringify(plan, null, 2)); return }
    if (args.length !== 3 || args[0] !== '--inventory' || args[1] !== '--ssh-env-file') throw new Error('Use --plan, or --inventory --ssh-env-file <explicit file>. No write mode exists.')
    console.log(JSON.stringify(runInventory(readSshHost(args[2])), null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { main() } catch { console.error('Xmail database operation refused or failed; connection details omitted.'); process.exitCode = 1 }
}
