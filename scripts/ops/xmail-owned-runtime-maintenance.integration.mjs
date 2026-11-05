import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import postgres from 'postgres'

const value=process.env.XMAIL_OWNED_MAINTENANCE_TEST_DATABASE_URL
const valid=(()=>{try{const u=new URL(value);return process.env.XMAIL_OWNED_MAINTENANCE_TEST_SENTINEL==='xmail-owned-maintenance-ci'
  &&['postgres:','postgresql:'].includes(u.protocol)&&u.hostname==='127.0.0.1'&&u.port==='5432'&&u.username==='postgres'
  &&u.pathname==='/xmail_identity_test'&&!u.search&&!u.hash}catch{return false}})()
if(value&&!valid)throw Error('Owned maintenance rehearsal requires its dedicated disposable loopback target and sentinel.')
const path=fileURLToPath(new URL('./prepare-xmail-owned-runtime-maintenance.py',import.meta.url))
const python=process.platform==='win32'?'python':'python3'
const loader=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('maintenance',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);pilot,lib=m.libraries();policy,_=lib.load_public_sources(__import__('pathlib').Path(sys.argv[1]).parent,lib.sha((__import__('pathlib').Path(sys.argv[1]).parents[2]/'.github/scripts/deploy-xmail.sh').read_bytes().replace(b'\\r\\n',b'\\n')))
`
function render(kind,input={}){
 const code=kind==='sql'?`print(json.dumps({'snapshot':m.snapshot_sql(lib,pilot),'fence':pilot.role_fence_sql(lib),'state':policy['maintenance_state_sql']()}))`
  :`v=json.loads(sys.stdin.read());print(m.rotation_sql(lib,pilot,v['frozen'],v['runtime_password'],v['reader_password'],v['expiry'],policy['maintenance_state_sql']()),end='')`
 const r=spawnSync(python,['-B','-c',loader+code,path],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:4*1024*1024})
 assert.equal(r.status,0,r.stderr);return kind==='sql'?JSON.parse(r.stdout):r.stdout
}
function withoutMarker(sql,marker){const suffix='\\echo '+marker+'\n';assert.ok(sql.endsWith(suffix));return sql.slice(0,-suffix.length)}
function snapshot(db,sql){return db.unsafe(sql).then(rows=>Object.values(rows[0])[0])}

test('owned maintenance preserves seventy business/four identity tables and accepts native users absent from Source',{skip:!valid},async()=>{
  const admin=postgres(value,{max:1,prepare:false,onnotice(){}})
  let db,ownerCreated=false,targetCreated=false
  const roles=[],ids=Array.from({length:3},()=>randomUUID()),source=render('sql')
  const tables=['users','organization_users',...Array.from({length:64},(_,i)=>'business_'+String(i).padStart(3,'0')),
    'messages','deliveries','inbox_send_commands','outreach_emails']
  const url=new URL(value);url.username='xmail_owner';url.pathname='/xmail'
  try{
    await admin.unsafe('CREATE ROLE xmail_owner LOGIN SUPERUSER');ownerCreated=true
    await admin.unsafe('CREATE DATABASE xmail OWNER xmail_owner');targetCreated=true
    for(const[name,n]of[['xmail_runtime',20],['xmail_staging_reader',2]]){
      await admin.unsafe(`CREATE ROLE ${name} LOGIN BYPASSRLS CONNECTION LIMIT ${n}`);roles.push(name)
    }
    db=postgres(url.href,{max:1,prepare:false,onnotice(){}})
    await db.unsafe(`SET timezone='UTC';SET search_path=public,pg_catalog;
      CREATE TABLE users(id uuid PRIMARY KEY,email text NOT NULL,password_hash text,is_admin boolean);
      CREATE TABLE organization_users(id uuid PRIMARY KEY,user_id uuid,role text);
      ${tables.slice(2).map(t=>`CREATE TABLE ${t}(id integer PRIMARY KEY,label text);`).join('\n')}
      ALTER TABLE messages ADD COLUMN held boolean NOT NULL DEFAULT true;
      ALTER TABLE deliveries ADD COLUMN status text NOT NULL DEFAULT 'held',ADD COLUMN message_id integer;
      ALTER TABLE inbox_send_commands ADD COLUMN status text NOT NULL DEFAULT 'held',ADD COLUMN lease_token uuid;
      ALTER TABLE outreach_emails ADD COLUMN status text NOT NULL DEFAULT 'held',ADD COLUMN lease_token uuid,ADD COLUMN dispatch_started_at timestamp;`)
    await db.unsafe(fs.readFileSync(new URL('../../supabase/migrations/079_owned_identity_foundation.sql',import.meta.url),'utf8'))
    await db.unsafe(fs.readFileSync(new URL('../../supabase/migrations/080_identity_browser_challenges.sql',import.meta.url),'utf8'))
    await db.unsafe(`CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);
      INSERT INTO supabase_migrations.schema_migrations SELECT lpad(n::text,3,'0') FROM generate_series(1,80)n;
      REVOKE CREATE,TEMPORARY ON DATABASE xmail FROM PUBLIC;REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO xmail_runtime,xmail_staging_reader;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO xmail_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO xmail_staging_reader;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;`)
    for(const[id,index]of ids.map((id,i)=>[id,i])){
      await db`INSERT INTO users VALUES(${id},${randomUUID()+'@example.invalid'},${randomUUID()},${index===0})`
      await db`INSERT INTO organization_users VALUES(${randomUUID()},${id},'admin')`
      await db`INSERT INTO xmail_identity_user_controls(user_id,disabled_at,sessions_valid_after,review_source)
        VALUES(${id},${index===1?new Date('2001-01-01'):null},${new Date(index===1?'2099-01-01':'2000-01-01')},${index===2?'local-owned-native-created-no-source':'preserved-reviewed'})`
    }
    const binding=randomUUID(),sessionHash='a'.repeat(64)
    await db`INSERT INTO xmail_identity_bindings(id,project_id,subject,user_id,proof_reference)
      VALUES(${binding},'skaleclub',${randomUUID()},${ids[0]},${'legacy-password:'+ids[0]})`
    // Original authentication can be old: this release does not re-prove ownership.
    await db`INSERT INTO xmail_identity_owned_sessions(token_hash,binding_id,authenticated_at,created_at,expires_at)
      VALUES(${sessionHash},${binding},${Math.floor(Date.now()/1000)-7200},${new Date(Date.now()-7200000)},${new Date(Date.now()+3600000)})`
    assert.equal(Object.values((await db.unsafe(source.state))[0])[0],true)
    const before=await snapshot(db,source.snapshot)
    assert.equal(Object.keys(before.fingerprints).length,70)
    assert.equal(Object.keys(before.identityDigests).length,4)
    await db.unsafe(withoutMarker(source.fence,'OWNED_ROLES_FENCED'))
    const sql=withoutMarker(render('rotation',{frozen:before,runtime_password:randomUUID(),reader_password:randomUUID(),expiry:new Date(Date.now()+840000).toISOString()}),'OWNED_MAINTENANCE_COMMITTED')
    await assert.rejects(db.unsafe(sql.replace('COMMIT;','SELECT 1/0;COMMIT;')),{code:'22012'})
    await db.unsafe('ROLLBACK')
    assert.deepEqual((await admin`SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader')`).map(x=>x.rolcanlogin),[false,false])
    assert.deepEqual((await snapshot(db,source.snapshot)).identityDigests,before.identityDigests)
    await db.unsafe(sql)
    const after=await snapshot(db,source.snapshot)
    for(const key of ['schema','fingerprints','ids','controls','bindingDigest','challengeDigest','sessionCount','identityDigests'])assert.deepEqual(after[key],before[key],key)
    const proof=await admin`SELECT rolcanlogin,rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname IN ('xmail_runtime','xmail_staging_reader')`
    assert.ok(proof.every(r=>r.rolcanlogin&&r.scram))
    // Missing controls cannot be silently filled from a remote legacy inventory.
    await db`DELETE FROM xmail_identity_user_controls WHERE user_id=${ids[2]}`
    assert.equal(Object.values((await db.unsafe(source.state))[0])[0],false)
    await db.unsafe(withoutMarker(source.fence,'OWNED_ROLES_FENCED'))
    await assert.rejects(db.unsafe(sql),/Owned controls unavailable/)
    await db.unsafe('ROLLBACK')
    assert.ok((await admin`SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader')`).every(x=>!x.rolcanlogin))
  }finally{
    if(db)await db.end({timeout:2})
    if(targetCreated)await admin.unsafe('DROP DATABASE xmail')
    for(const role of roles)await admin.unsafe('DROP ROLE '+role)
    if(ownerCreated)await admin.unsafe('DROP ROLE xmail_owner')
    await admin.end({timeout:2})
  }
})
