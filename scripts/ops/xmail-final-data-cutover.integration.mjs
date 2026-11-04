import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

// Explicit disposable CI loopback service only; no dotenv, DATABASE_URL or Docker.
const value = process.env.XMAIL_FINAL_DATA_TEST_DATABASE_URL
const valid = (() => {
  if (!value || process.env.XMAIL_FINAL_DATA_TEST_SENTINEL !== 'xmail-final-data-ci') return false
  try {
    const u = new URL(value)
    return ['postgres:', 'postgresql:'].includes(u.protocol) && u.hostname === '127.0.0.1' && u.port === '5432'
      && u.username === 'postgres' && u.pathname === '/xmail_identity_test' && !u.search && !u.hash
  } catch { return false }
})()
if (value && !valid) throw new Error('Final data rehearsal requires the exact disposable loopback target and sentinel.')
const operator = fileURLToPath(new URL('./prepare-xmail-final-data-cutover.py', import.meta.url))
const python = process.platform === 'win32' ? 'python' : 'python3'
const loader = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('reviewed_operator',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
`
function publicSql() {
  const result = spawnSync(python, ['-B', '-c', loader+`print(json.dumps({'snapshot':m.source_snapshot_sql(),'schema':m.business_schema_sql(),'fingerprints':m.fingerprints_sql(),'fks':m.fk_inventory_sql(),'sequences':m.sequences_sql(),'triggers':m.trigger_inventory_sql()}))`, operator], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
function render(values) {
  const result = spawnSync(python, ['-B', '-c', loader+`v=json.loads(sys.stdin.read());print(m.refresh_sql(**v),end='')`, operator], {
    input: JSON.stringify(values), encoding: 'utf8', maxBuffer: 4*1024*1024,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
function runPsql(sql) {
  return spawnSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', timeout: 30000, maxBuffer: 4*1024*1024,
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'xmail', PGUSER: 'xmail_owner',
      PGPASSWORD: '', PGPASSFILE: '/dev/null', PGSSLMODE: 'disable', PGOPTIONS: '' },
  })
}

test('first data refresh preserves DDL/FK/trigger modes and rolls all rows/controls/sequences back on failure', { skip: !valid }, async () => {
  const sql = publicSql()
  const admin = postgres(value, { max: 1, prepare: false, onnotice() {} })
  let target, source, ownerCreated=false, targetCreated=false, sourceCreated=false
  const roles=[]
  const user1='11111111-1111-4111-8111-111111111111',user2='22222222-2222-4222-8222-222222222222'
  const member='33333333-3333-4333-8333-333333333333'
  const tables=['users','organization_users',...Array.from({length:64},(_,i)=>`business_${String(i).padStart(3,'0')}`),
    'messages','deliveries','inbox_send_commands','outreach_emails']
  const url = new URL(value);url.username='xmail_owner'
  const connect = name => { const u=new URL(url);u.pathname='/'+name;return postgres(u.toString(),{max:1,prepare:false,onnotice(){}}) }
  const setup = `
    SET timezone='UTC'; SET datestyle='ISO,YMD'; SET extra_float_digits=3; SET bytea_output='hex'; SET search_path=public,pg_catalog;
    CREATE TABLE users(id uuid PRIMARY KEY,email text NOT NULL,password_hash text,is_admin boolean NOT NULL);
    CREATE TABLE organization_users(id uuid PRIMARY KEY,user_id uuid NOT NULL,role text NOT NULL);
    ${tables.slice(2).map(t=>`CREATE TABLE ${t}(id integer PRIMARY KEY,label text,parent integer);`).join('\n')}
    ALTER TABLE messages ADD COLUMN held boolean NOT NULL DEFAULT true;
    ALTER TABLE deliveries ADD COLUMN status text NOT NULL DEFAULT 'held',ADD COLUMN message_id integer;
    ALTER TABLE inbox_send_commands ADD COLUMN status text NOT NULL DEFAULT 'held',ADD COLUMN lease_token uuid;
    ALTER TABLE outreach_emails ADD COLUMN status text NOT NULL DEFAULT 'held',ADD COLUMN lease_token uuid,ADD COLUMN dispatch_started_at timestamp;
    ALTER TABLE organization_users ADD CONSTRAINT membership_user FOREIGN KEY(user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE business_000 ADD CONSTRAINT cycle_a FOREIGN KEY(parent) REFERENCES business_001(id) DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE business_001 ADD CONSTRAINT cycle_b FOREIGN KEY(parent) REFERENCES business_000(id) NOT DEFERRABLE;
    CREATE SEQUENCE fixture_seq INCREMENT 3 MINVALUE 1 MAXVALUE 1000 CACHE 1;
    CREATE FUNCTION mutate_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.label='trigger-changed';RETURN NEW;END $$;
    ${['O','D','R','A'].map(mode=>`CREATE TRIGGER mutate_${mode} BEFORE INSERT ON business_000 FOR EACH ROW EXECUTE FUNCTION mutate_fixture();
      ALTER TABLE business_000 ${mode==='O'?'ENABLE':mode==='D'?'DISABLE':mode==='R'?'ENABLE REPLICA':'ENABLE ALWAYS'} TRIGGER mutate_${mode};`).join('\n')}
  `
  try {
    // Never reuse/drop a pre-existing fixture, database or role.
    await admin.unsafe('CREATE ROLE xmail_owner LOGIN SUPERUSER');ownerCreated=true
    await admin.unsafe('CREATE DATABASE xmail OWNER xmail_owner');targetCreated=true
    await admin.unsafe('CREATE DATABASE xmail_final_source_test OWNER xmail_owner');sourceCreated=true
    for(const [name,limit]of[['xmail_runtime',20],['xmail_staging_reader',2]]){
      await admin.unsafe(`CREATE ROLE ${name} NOLOGIN BYPASSRLS CONNECTION LIMIT ${limit}`);roles.push(name)
    }
    target=connect('xmail');source=connect('xmail_final_source_test')
    await target.unsafe(setup);await source.unsafe(setup)
    await target.unsafe(fs.readFileSync(new URL('../../supabase/migrations/079_owned_identity_foundation.sql',import.meta.url),'utf8'))
    await target.unsafe(fs.readFileSync(new URL('../../supabase/migrations/080_identity_browser_challenges.sql',import.meta.url),'utf8'))
    await target.unsafe(`REVOKE CREATE,TEMPORARY ON DATABASE xmail FROM PUBLIC;REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO xmail_runtime,xmail_staging_reader;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO xmail_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO xmail_staging_reader;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO xmail_runtime;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO xmail_runtime;`)
    await target.unsafe(`CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);
      INSERT INTO supabase_migrations.schema_migrations SELECT lpad(n::text,3,'0') FROM generate_series(1,80)n;
      INSERT INTO users VALUES('${user1}','fixture@example.invalid','unchanged-native-hash',true);
      INSERT INTO organization_users VALUES('${member}','${user1}','admin');
      INSERT INTO xmail_identity_user_controls(user_id,disabled_at,sessions_valid_after,review_source)
      VALUES('${user1}','2000-01-01','2099-01-01','previous-reviewed-ban');SELECT setval('fixture_seq',16,true);`)
    await source.unsafe(`CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,banned_until timestamptz,deleted_at timestamptz,raw_app_meta_data jsonb);
      INSERT INTO users VALUES('${user1}','fixture@example.invalid','unchanged-native-hash',true),('${user2}','new@example.invalid','new-native-hash',false);
      INSERT INTO organization_users VALUES('${member}','${user1}','admin');
      INSERT INTO auth.users VALUES('${user1}',NULL,NULL,'{}'),('${user2}','2099-01-01',NULL,'{}');SELECT setval('fixture_seq',53,true);`)
    for(const table of tables.slice(2)){
      // Source INSERT uses an explicit fixture-only disabled-trigger span; the
      // tested refresh itself must independently preserve all trigger modes.
      await source.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER;INSERT INTO ${table} VALUES(1,'authoritative',NULL);`)
    }
    for(const mode of ['O','D','R','A'])await source.unsafe(`ALTER TABLE business_000 ${mode==='O'?'ENABLE':mode==='D'?'DISABLE':mode==='R'?'ENABLE REPLICA':'ENABLE ALWAYS'} TRIGGER mutate_${mode}`)
    const [snapshotRow]=await source.unsafe(sql.snapshot),snapshot=snapshotRow.manifest
    const [{schema:targetSchema}]=await target.unsafe(sql.schema)
    assert.deepEqual(targetSchema,snapshot.schema)
    const [{coalesce:fks}]=await target.unsafe(sql.fks)
    const [{coalesce:triggers}]=await target.unsafe(sql.triggers)
    const [{coalesce:beforeSequences}]=await target.unsafe(sql.sequences)
    const [{fingerprints:beforeRows}]=await target.unsafe(sql.fingerprints)
    let copy=`COPY public.users(id,email,password_hash,is_admin) FROM stdin;\n${user1}\tfixture@example.invalid\tunchanged-native-hash\tt\n${user2}\tnew@example.invalid\tnew-native-hash\tf\n\\.\n`
    copy+=`COPY public.organization_users(id,user_id,role) FROM stdin;\n${member}\t${user1}\tadmin\n\\.\n`
    for(const table of tables.slice(2))copy+=`COPY public.${table}(id,label,parent) FROM stdin;\n1\tauthoritative\t\\N\n\\.\n`
    const plan=render({tables,fks,copy_sql:copy,controls:snapshot.controls,cutoff:snapshot.capturedAt,
      expected_schema:snapshot.schema,sequences:snapshot.sequences,triggers})
    await target.end({timeout:2});target=undefined
    const failed=runPsql(plan+'SELECT 1/0;\nCOMMIT;\n')
    assert.notEqual(failed.status,0,'fixture must fail after the transactional sequence restart')
    target=connect('xmail')
    assert.deepEqual((await target.unsafe(sql.fingerprints))[0].fingerprints,beforeRows)
    assert.deepEqual((await target.unsafe(sql.fks))[0].coalesce,fks)
    assert.deepEqual((await target.unsafe(sql.triggers))[0].coalesce,triggers)
    assert.deepEqual((await target.unsafe(sql.sequences))[0].coalesce,beforeSequences)
    await target.end({timeout:2});target=undefined
    const success=runPsql(plan+'COMMIT;\n')
    assert.equal(success.status,0,success.stderr)
    target=connect('xmail')
    assert.deepEqual((await target.unsafe(sql.fingerprints))[0].fingerprints,snapshot.fingerprints)
    assert.deepEqual((await target.unsafe(sql.schema))[0].schema,snapshot.schema)
    assert.deepEqual((await target.unsafe(sql.fks))[0].coalesce,fks)
    assert.deepEqual((await target.unsafe(sql.triggers))[0].coalesce,triggers)
    const [control]=await target`SELECT disabled_at IS NOT NULL AS banned,sessions_valid_after='2099-01-01'::timestamptz AS future_preserved FROM xmail_identity_user_controls WHERE user_id=${user1}`
    assert.deepEqual(control,{banned:true,future_preserved:true})
    assert.equal(Number((await target`SELECT count(*) AS n FROM xmail_identity_user_controls WHERE disabled_at IS NOT NULL`)[0].n),2)
    assert.equal((await target`SELECT password_hash FROM users WHERE id=${user1}`)[0].password_hash,'unchanged-native-hash')
    const [sequence]=await target`SELECT last_value,is_called FROM fixture_seq`
    assert.equal(String(sequence.last_value),'56');assert.equal(sequence.is_called,false)
    assert.equal((await target`SELECT label FROM business_000`)[0].label,'authoritative')
    assert.equal(Number((await target`SELECT count(*) AS n FROM supabase_migrations.schema_migrations`)[0].n),80)
  } finally {
    if(target)await target.end({timeout:2})
    if(source)await source.end({timeout:2})
    if(sourceCreated)await admin.unsafe('DROP DATABASE xmail_final_source_test')
    if(targetCreated)await admin.unsafe('DROP DATABASE xmail')
    for(const role of roles)await admin.unsafe(`DROP ROLE ${role}`)
    if(ownerCreated)await admin.unsafe('DROP ROLE xmail_owner')
    await admin.end({timeout:2})
  }
})
