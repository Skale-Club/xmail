import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import postgres from 'postgres'

const value=process.env.XMAIL_OWNED_PILOT_TEST_DATABASE_URL
const valid=(()=>{try{const u=new URL(value);return process.env.XMAIL_OWNED_PILOT_TEST_SENTINEL==='xmail-owned-pilot-ci'
  &&['postgres:','postgresql:'].includes(u.protocol)&&u.hostname==='127.0.0.1'&&u.port==='5432'&&u.username==='postgres'
  &&u.pathname==='/xmail_identity_test'&&!u.search&&!u.hash}catch{return false}})()
if(value&&!valid)throw Error('Owned pilot rehearsal requires its dedicated disposable loopback target and sentinel.')
const path=fileURLToPath(new URL('./prepare-xmail-owned-pilot-rollout.py',import.meta.url))
const python=process.platform==='win32'?'python':'python3'
const loader=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('owned_pilot',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);lib=m.library()
`
function render(kind,input={}){
  const code=kind==='sql'?`print(json.dumps({'snapshot':m.snapshot_sql(lib),'fence':m.role_fence_sql(lib)}))`
    :`v=json.loads(sys.stdin.read());print(m.controls_sql(lib,**v),end='')`
  const r=spawnSync(python,['-B','-c',loader+code,path],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:4*1024*1024})
  assert.equal(r.status,0,r.stderr)
  return kind==='sql'?JSON.parse(r.stdout):r.stdout
}
function withoutMarker(sql,marker){const suffix='\\echo '+marker+'\n';assert.ok(sql.endsWith(suffix));return sql.slice(0,-suffix.length)}

test('owned pilot preserves business/native data, current admin proof and conservative bans/cutoffs atomically',{skip:!valid},async()=>{
  const admin=postgres(value,{max:1,prepare:false,onnotice(){}})
  let db,ownerCreated=false,targetCreated=false
  const roles=[],ids=Array.from({length:5},()=>randomUUID()),source=render('sql')
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
      if(index!==3)await db`INSERT INTO xmail_identity_user_controls(user_id,disabled_at,sessions_valid_after,review_source)
        VALUES(${id},${index===1?new Date('2001-01-01'):null},${new Date(index===1||index===2?'2099-01-01':'2000-01-01')},'preserved-reviewed-control')`
    }
    const now=new Date(),hashes=[]
    for(const i of [0,1,4]){
      const binding=randomUUID(),hash=Buffer.from(randomUUID()+randomUUID()).toString('hex').slice(0,64);hashes.push([i,hash])
      await db`INSERT INTO xmail_identity_bindings(id,project_id,subject,user_id,proof_reference)
        VALUES(${binding},'skaleclub',${randomUUID()},${ids[i]},${'legacy-password:'+ids[i]})`
      await db`INSERT INTO xmail_identity_owned_sessions(token_hash,binding_id,authenticated_at,created_at,expires_at)
        VALUES(${hash},${binding},${Math.floor(now.getTime()/1000)},${now},${new Date(now.getTime()+3600000)})`
    }
    const before=(await db.unsafe(source.snapshot))[0].jsonb_build_object
    assert.equal(Object.keys(before.fingerprints).length,70)
    await db.unsafe(withoutMarker(source.fence,'OWNED_ROLES_FENCED'))
    assert.deepEqual((await admin`SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader')`).map(x=>x.rolcanlogin),[false,false])
    const review={capturedAt:new Date().toISOString(),origin:'https://zzbudkfkcmqkavgwselc.supabase.co',users:ids.map((id,i)=>({id,disabled:i===4}))}
    const sql=withoutMarker(render('controls',{review,frozen:before,runtime_password:randomUUID(),reader_password:randomUUID(),expiry:new Date(Date.now()+900000).toISOString()}),'OWNED_CONTROLS_COMMITTED')
    await assert.rejects(db.unsafe(sql.replace('COMMIT;','SELECT 1/0;COMMIT;')),{code:'22012'})
    await db.unsafe('ROLLBACK')
    assert.deepEqual((await db.unsafe(source.snapshot))[0].jsonb_build_object.controls,before.controls)
    assert.deepEqual((await admin`SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader')`).map(x=>x.rolcanlogin),[false,false])
    await db.unsafe(sql)
    const after=(await db.unsafe(source.snapshot))[0].jsonb_build_object
    for(const key of ['schema','fingerprints','bindingDigest','challengeDigest','sessionCount'])assert.deepEqual(after[key],before[key])
    assert.equal(after.controls.length,5)
    for(const i of [0,1,2])assert.deepEqual(after.controls.find(x=>x.user_id===ids[i]),before.controls.find(x=>x.user_id===ids[i]))
    assert.equal(after.controls.filter(x=>x.disabled_at!==null).length,2)
    for(const[i,hash]of hashes){const[s]=await db`SELECT revoked_at IS NOT NULL AS revoked FROM xmail_identity_owned_sessions WHERE token_hash=${hash}`;assert.equal(s.revoked,i!==0)}
    const roleProof=await admin`SELECT rolcanlogin,rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname IN ('xmail_runtime','xmail_staging_reader')`
    assert.ok(roleProof.every(x=>x.rolcanlogin&&x.scram))
    const mismatched={...review,users:review.users.slice(1)}
    const r=spawnSync(python,['-B','-c',loader+`v=json.loads(sys.stdin.read());m.validate_review(v['review'],v['ids'])`,path],{input:JSON.stringify({review:mismatched,ids}),encoding:'utf8'})
    assert.notEqual(r.status,0,'every current OWN SQL UUID is mandatory')
  }finally{
    if(db)await db.end({timeout:2})
    if(targetCreated)await admin.unsafe('DROP DATABASE xmail')
    for(const role of roles)await admin.unsafe('DROP ROLE '+role)
    if(ownerCreated)await admin.unsafe('DROP ROLE xmail_owner')
    await admin.end({timeout:2})
  }
})
