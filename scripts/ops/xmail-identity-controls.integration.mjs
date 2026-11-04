import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

// Disposable CI service only. No dotenv or production URL aliases are read.
const value = process.env.XMAIL_IDENTITY_CONTROL_TEST_DATABASE_URL
const valid = (() => {
  if (!value || process.env.XMAIL_IDENTITY_CONTROL_TEST_SENTINEL !== 'xmail-identity-controls-ci') return false
  try {
    const u = new URL(value)
    return ['postgres:', 'postgresql:'].includes(u.protocol) && u.hostname === '127.0.0.1' && u.port === '5432'
      && u.username === 'postgres' && u.pathname === '/xmail_identity_test' && !u.search && !u.hash
  } catch { return false }
})()
if (value && !valid) throw new Error('Identity control integration requires the exact disposable loopback target and sentinel.')

test('reviewed identity controls preserve bans and immutable mail/organization authority', { skip: !valid }, async t => {
  const admin = postgres(value, { max: 1, prepare: false, onnotice() {} })
  let owner, ownerCreated = false, databaseCreated = false
  const engine = fs.readFileSync(new URL('./xmail-identity-controls.sql', import.meta.url), 'utf8')
  const ids = [randomUUID(), randomUUID()]
  let snapshot
  try {
    // No IF NOT EXISTS: never reuse or drop a pre-existing fixture/database.
    await admin.unsafe('CREATE ROLE xmail_owner LOGIN SUPERUSER')
    ownerCreated = true
    await admin.unsafe('CREATE DATABASE xmail OWNER xmail_owner')
    databaseCreated = true
    const u = new URL(value); u.username = 'xmail_owner'; u.pathname = '/xmail'
    owner = postgres(u.toString(), { max: 2, prepare: false, onnotice() {} })
    await owner.unsafe(`CREATE TABLE public.users(id uuid PRIMARY KEY,email text NOT NULL UNIQUE,
      password_hash text,is_admin boolean NOT NULL DEFAULT false);
      CREATE TABLE public.organization_users(id uuid PRIMARY KEY,user_id uuid REFERENCES public.users(id),
        organization_id uuid NOT NULL,role text NOT NULL);
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,banned_until timestamptz,deleted_at timestamptz,raw_app_meta_data jsonb);`)
    for (const name of ['079_owned_identity_foundation.sql', '080_identity_browser_challenges.sql']) {
      await owner.unsafe(fs.readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
    }
    const reset = async () => {
      await owner.unsafe('TRUNCATE public.users CASCADE')
      for (let index = 0; index < ids.length; index++) {
        await owner`INSERT INTO public.users(id,email,password_hash,is_admin)
          VALUES(${ids[index]},${`offline-${index}@example.invalid`},${`native-hash-${index}`},${index === 0})`
        await owner`INSERT INTO public.organization_users(id,user_id,organization_id,role)
          VALUES(${randomUUID()},${ids[index]},${randomUUID()},${index === 0 ? 'admin' : 'viewer'})`
      }
    }
    const manifest = async () => {
      const [data] = await owner`SELECT date_trunc('second',clock_timestamp()) AS captured,
        (SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(u) ORDER BY u.id)::text,'UTF8')),'hex') FROM public.users u) AS users,
        (SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text,'UTF8')),'hex') FROM public.organization_users m) AS memberships`
      return { version: 1, app: 'xmail', sourceProjectRef: 'zzbudkfkcmqkavgwselc', capturedAt: data.captured.toISOString(),
        usersDigest: data.users, membershipsDigest: data.memberships, readOnlySnapshot: true,
        users: ids.map((id, index) => ({ id, disabled: index === 1 })) }
    }
    const apply = review => owner.begin(async tx => {
      await tx`SELECT set_config('xmail.identity_status_review',${JSON.stringify(review)},true)`
      await tx.unsafe(engine)
    })
    const controls = () => owner`SELECT user_id,disabled_at,sessions_valid_after,review_source,reviewed_at
      FROM public.xmail_identity_user_controls ORDER BY user_id`
    const empty = async () => assert.equal((await controls()).length, 0)
    const python = (program, input = '') => {
      const result = spawnSync('python3', ['-B', '-c', program, fileURLToPath(new URL('./prepare-xmail-identity-controls.py', import.meta.url))],
        { input, encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 })
      assert.equal(result.status, 0, 'Offline operator helper must succeed without environment/connection reads')
      return result.stdout
    }
    const authStatusSql = python('import runpy,sys; print(runpy.run_path(sys.argv[1])["AUTH_STATUS_SQL"])')

    await t.test('the exact source query preserves current bans, local offboarding and soft-deleted denial', async () => {
      await reset()
      await owner`INSERT INTO auth.users(id,raw_app_meta_data) VALUES(${ids[0]},${owner.json({})}),(${ids[1]},${owner.json({})})`
      const read = () => owner.begin('isolation level repeatable read read only', tx => tx.unsafe(authStatusSql))
      await owner`UPDATE auth.users SET banned_until=clock_timestamp()+interval '1 hour' WHERE id=${ids[1]}`
      assert.equal((await read()).find(row => row.id === ids[1]).disabled, true)
      await owner`UPDATE auth.users SET banned_until=clock_timestamp()-interval '1 hour' WHERE id=${ids[1]}`
      assert.equal((await read()).find(row => row.id === ids[1]).disabled, false)
      await owner`UPDATE auth.users SET raw_app_meta_data=${owner.json({ xmail_disabled: true })} WHERE id=${ids[1]}`
      assert.equal((await read()).find(row => row.id === ids[1]).disabled, true)
      await owner`UPDATE auth.users SET raw_app_meta_data=${owner.json({})},deleted_at=clock_timestamp() WHERE id=${ids[1]}`
      assert.equal((await read()).find(row => row.id === ids[1]).disabled, true)
      await owner`UPDATE auth.users SET raw_app_meta_data=${owner.json({ xmail_disabled: 'true' })} WHERE id=${ids[1]}`
      assert.equal((await read()).find(row => row.id === ids[1]).valid, false)
      await owner`DELETE FROM auth.users WHERE id=${ids[1]}`
      assert.equal((await read()).find(row => row.id === ids[1]).present, false)
    })

    await t.test('imports both UUIDs, preserves the banned denial, admin/native hashes and org roles', async () => {
      await reset(); snapshot = await manifest()
      const users = await owner`SELECT * FROM public.users ORDER BY id`
      const memberships = await owner`SELECT * FROM public.organization_users ORDER BY id`
      await apply(snapshot)
      const rows = await controls()
      assert.equal(rows.length, 2)
      assert.equal(rows.find(row => row.user_id === ids[0]).disabled_at, null)
      assert.equal(rows.find(row => row.user_id === ids[1]).disabled_at.toISOString(), snapshot.capturedAt)
      assert(rows.every(row => row.sessions_valid_after.toISOString() === snapshot.capturedAt))
      assert.deepEqual(await owner`SELECT * FROM public.users ORDER BY id`, users)
      assert.deepEqual(await owner`SELECT * FROM public.organization_users ORDER BY id`, memberships)
      assert.equal(Number((await owner`SELECT count(*) AS n FROM public.xmail_identity_bindings`)[0].n), 0)
      assert.equal(Number((await owner`SELECT count(*) AS n FROM public.xmail_identity_owned_sessions`)[0].n), 0)
    })
    await t.test('replaying the same reviewed snapshot is idempotent and does not rewrite controls', async () => {
      const before = await controls()
      await apply(snapshot)
      assert.deepEqual(await controls(), before)
    })
    await t.test('the separate operator readback verifies exact controls/content without projecting private data', async () => {
      const sql = python('import json,runpy,sys; sys.stdout.buffer.write(runpy.run_path(sys.argv[1])["readback_sql"](json.load(sys.stdin)))', JSON.stringify(snapshot))
      assert(sql.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'))
      assert(sql.endsWith('ROLLBACK;\n'))
      const statement = sql.slice(sql.indexOf('WITH review AS'), sql.lastIndexOf('ROLLBACK;'))
      const [row] = await owner.begin('isolation level repeatable read read only', tx => tx.unsafe(statement))
      assert(Object.values(row.jsonb_build_object).every(value => value === true))
      assert(!JSON.stringify(row).includes(ids[0]) && !JSON.stringify(row).includes(snapshot.usersDigest))
    })
    await t.test('a different status never overwrites a local ban/review decision', async () => {
      const before = await controls(), altered = structuredClone(snapshot)
      altered.users[1].disabled = false
      await assert.rejects(apply(altered), /never overwrite local decisions/)
      assert.deepEqual(await controls(), before)
    })
    await t.test('unknown, incomplete or duplicate UUID sets roll back with zero controls', async () => {
      for (const change of [r => { r.users[0].id = randomUUID() }, r => { r.users.pop() }, r => { r.users[1] = r.users[0] }]) {
        await reset(); const r = await manifest(); change(r)
        await assert.rejects(apply(r)); await empty()
      }
    })
    await t.test('stale or future source evidence cannot admit users', async () => {
      for (const offset of [-1900000, 60000]) {
        await reset(); const r = await manifest(); r.capturedAt = new Date(Date.now() + offset).toISOString()
        await assert.rejects(apply(r), /freshness/); await empty()
      }
    })
    await t.test('different application-user or organization-authority contents deny all inserts', async () => {
      for (const key of ['usersDigest', 'membershipsDigest']) {
        await reset(); const r = await manifest(); r[key] = '0'.repeat(64)
        await assert.rejects(apply(r), /snapshot differs/); await empty()
      }
    })
    await t.test('unrelated existing controls are preserved on refusal', async () => {
      await reset(); const r = await manifest()
      await owner`INSERT INTO public.xmail_identity_user_controls(user_id,review_source) VALUES(${ids[0]},'operator-local-decision')`
      const before = await controls()
      await assert.rejects(apply(r), /never overwrite local decisions/)
      assert.deepEqual(await controls(), before)
    })
    await t.test('an existing provider binding blocks initial-import mode', async () => {
      await reset(); const r = await manifest()
      await owner`INSERT INTO public.xmail_identity_bindings(project_id,subject,user_id,proof_reference)
        VALUES('skaleclub','synthetic-already-linked',${ids[0]},'offline-independent-proof')`
      await assert.rejects(apply(r), /Initial exact-user/); await empty()
    })
    await t.test('unreviewed target triggers are rejected before any control write', async () => {
      await reset(); const r = await manifest()
      await owner.unsafe(`CREATE FUNCTION public.control_fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER control_fixture_trigger BEFORE INSERT ON public.xmail_identity_user_controls
          FOR EACH ROW EXECUTE FUNCTION public.control_fixture_trigger()`)
      try { await assert.rejects(apply(r), /schema outside reviewed migration/); await empty() }
      finally { await owner.unsafe('DROP TRIGGER control_fixture_trigger ON public.xmail_identity_user_controls; DROP FUNCTION public.control_fixture_trigger()') }
    })
    await t.test('a failing control constraint rolls back the entire batch', async () => {
      await reset(); const r = await manifest()
      await owner.unsafe(`ALTER TABLE public.xmail_identity_user_controls ADD CONSTRAINT fixture_failure CHECK(user_id <> '${ids[1]}'::uuid)`)
      try { await assert.rejects(apply(r), error => error.code === '23514'); await empty() }
      finally { await owner.unsafe('ALTER TABLE public.xmail_identity_user_controls DROP CONSTRAINT fixture_failure') }
    })
    await t.test('a wrong database/user cannot import even with a valid review', async () => {
      await reset(); const r = await manifest()
      await assert.rejects(admin.begin(async tx => {
        await tx`SELECT set_config('xmail.identity_status_review',${JSON.stringify(r)},true)`
        await tx.unsafe(engine)
      }), /target or additive migrations not approved/)
      await empty()
    })
  } finally {
    if (owner) await owner.end({ timeout: 3 })
    // Only resources created above, in the explicitly pinned disposable service.
    if (databaseCreated) await admin.unsafe('DROP DATABASE xmail')
    if (ownerCreated) await admin.unsafe('DROP ROLE xmail_owner')
    await admin.end({ timeout: 3 })
  }
})
