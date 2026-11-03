import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import postgres from 'postgres'

// CI-only, disposable loopback PostgreSQL. Never consume DATABASE_URL/.env.
const value = process.env.XMAIL_RUNTIME_ROLE_TEST_DATABASE_URL
const sentinel = process.env.XMAIL_RUNTIME_ROLE_TEST_SENTINEL
const valid = (() => {
  if (!value || sentinel !== 'xmail-runtime-role-ci') return false
  try {
    const u = new URL(value)
    return ['postgres:', 'postgresql:'].includes(u.protocol)
      && u.hostname === '127.0.0.1' && u.port === '5432'
      && u.username === 'postgres' && u.pathname === '/xmail_identity_test'
      && !u.search && !u.hash
  } catch { return false }
})()
if (value && !valid) throw new Error('Runtime role tests require the isolated CI target and sentinel.')

test('runtime role cannot administer the database, bypasses backend RLS, and preserves DML', { skip: !valid }, async () => {
  const admin = postgres(value, { max: 1, prepare: false, onnotice() {} })
  let owner
  let runtime
  let reader
  const source = fs.readFileSync(new URL('./xmail-runtime-role.sql', import.meta.url), 'utf8')
  try {
    // Deliberately fail if the dedicated fixture already exists. No DROP DATABASE.
    await admin.unsafe('CREATE ROLE xmail_owner LOGIN SUPERUSER')
    await admin.unsafe('CREATE DATABASE xmail OWNER xmail_owner')
    const u = new URL(value)
    u.username = 'xmail_owner'
    u.pathname = '/xmail'
    owner = postgres(u.toString(), { max: 1, prepare: false, onnotice() {} })
    await owner.unsafe(`
      CREATE TABLE public.users(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text);
      CREATE TABLE public.organization_users(id bigint PRIMARY KEY);
      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
      CREATE POLICY deny_all ON public.users USING (false) WITH CHECK (false);
      INSERT INTO public.users(label) VALUES ('fixture');
      CREATE SCHEMA supabase_migrations;
      CREATE TABLE supabase_migrations.schema_migrations(version text);
      CREATE FUNCTION public.unsafe_writer() RETURNS void LANGUAGE sql SECURITY DEFINER
        AS 'INSERT INTO public.users(label) VALUES (''should never run'')';
    `)
    await owner.unsafe(source)
    const [role] = await owner`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='xmail_runtime'`
    assert.deepEqual(role, { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: true })
    // LOGIN is enabled only inside this disposable CI database (loopback trust).
    // The operational SQL leaves both roles NOLOGIN and creates no passwords.
    await owner.unsafe('ALTER ROLE xmail_runtime LOGIN; ALTER ROLE xmail_staging_reader LOGIN')
    u.username = 'xmail_runtime'
    runtime = postgres(u.toString(), { max: 1, prepare: false, onnotice() {} })
    u.username = 'xmail_staging_reader'
    reader = postgres(u.toString(), { max: 1, prepare: false, onnotice() {} })
    assert.equal(Number((await runtime`SELECT count(*) AS n FROM public.users`)[0].n), 1)
    const [row] = await runtime`INSERT INTO public.users(label) VALUES ('runtime') RETURNING id`
    await runtime`UPDATE public.users SET label='updated' WHERE id=${row.id}`
    assert.equal((await runtime`SELECT label FROM public.users WHERE id=${row.id}`)[0].label, 'updated')
    await runtime`DELETE FROM public.users WHERE id=${row.id}`
    for (const sql of [
      'CREATE TABLE public.forbidden(id int)',
      'CREATE SCHEMA forbidden',
      'CREATE TEMP TABLE forbidden(id int)',
      'TRUNCATE public.users',
      'ALTER TABLE public.users ADD COLUMN forbidden text',
      'DROP TABLE public.users',
      'SET ROLE xmail_owner',
      'CREATE ROLE forbidden',
      'SELECT * FROM supabase_migrations.schema_migrations',
    ]) {
      await assert.rejects(runtime.unsafe(sql), error => ['42501', '0LP01'].includes(error.code), sql)
    }
    assert.equal(Number((await reader`SELECT count(*) AS n FROM public.users`)[0].n), 1)
    // Even overriding the session's read-only default must not grant DML/DDL or
    // execution of a SECURITY DEFINER writer through inherited PUBLIC access.
    await reader.unsafe('SET default_transaction_read_only = off')
    for (const sql of [
      "INSERT INTO public.users(label) VALUES ('forbidden')",
      "UPDATE public.users SET label='forbidden'",
      'DELETE FROM public.users',
      'TRUNCATE public.users',
      'CREATE TABLE public.forbidden(id int)',
      'SELECT public.unsafe_writer()',
      'SET ROLE xmail_runtime',
      'SET ROLE xmail_owner',
    ]) await assert.rejects(reader.unsafe(sql), error => error.code === '42501', sql)
    await owner.unsafe('CREATE TABLE public.future_data(id bigint GENERATED ALWAYS AS IDENTITY, label text)')
    const [grants] = await owner`SELECT has_table_privilege('xmail_runtime','public.future_data','INSERT') AS future_insert, has_sequence_privilege('xmail_runtime','public.future_data_id_seq','USAGE') AS future_sequence`
    assert.deepEqual(grants, { future_insert: true, future_sequence: true })
    assert.equal((await owner`SELECT has_table_privilege('xmail_staging_reader','public.future_data','SELECT') AS allowed`)[0].allowed, true)
    await owner.unsafe(`CREATE FUNCTION public.future_writer() RETURNS void LANGUAGE sql SECURITY DEFINER
      AS 'INSERT INTO public.users(label) VALUES (''should never run'')'`)
    await assert.rejects(reader.unsafe('SELECT public.future_writer()'), error => error.code === '42501')
    assert.equal((await owner`SELECT has_function_privilege('xmail_runtime','public.future_writer()','EXECUTE') AS allowed`)[0].allowed, true)
    // Re-running never rotates/reuses an existing role or silently broadens it.
    await assert.rejects(owner.unsafe(source), /initial state refused/)
    await owner.unsafe('ROLLBACK')
  } finally {
    if (runtime) await runtime.end({ timeout: 3 })
    if (reader) await reader.end({ timeout: 3 })
    if (owner) await owner.end({ timeout: 3 })
    await admin.end({ timeout: 3 })
  }
})
