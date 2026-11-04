/** Default offline plan. No customer bytes are logged or written on the controller. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';

const SOURCE = '49.13.197.250';
const TARGET = '188.245.112.3';
const BACKUP = 'candidate-20261103T232409Z-3654333.CTKbuKFN';
const SOURCE_SHA = 'a78f4b001411b10d6a050e403194107d391e46626ebdcd79f0aedd9562b5671a';
const SOURCE_BYTES = 23009087;
const BASE = '/opt/xmail/offsite-backups/v1';
const MAX_CIPHER = 32 * 1024 * 1024;
const children = new Set();
let interrupted = false;

// This program is sent as fixed base64 Python source, never as interpolated shell data.
// Certificate packets are public metadata; the private recipient key stays on TARGET.
const REMOTE = String.raw`
import ctypes,datetime,errno,hashlib,json,os,pathlib,re,resource,shutil,signal,stat,subprocess,sys,tempfile
S='49.13.197.250'; T='188.245.112.3'
ID='candidate-20261103T232409Z-3654333.CTKbuKFN'
SHA='a78f4b001411b10d6a050e403194107d391e46626ebdcd79f0aedd9562b5671a'
SIZE=23009087; MAX=33554432
BASE=pathlib.Path('/opt/xmail/offsite-backups/v1')
SOURCE=pathlib.Path('/opt/xmail/backups')/ID
ACTIVE=set()
class Failure(Exception): pass
def need(value):
 if not value: raise Failure()
def exists(path): return os.path.lexists(path)
def stop(*_):
 for p in list(ACTIVE):
  if p.poll() is None: p.kill()
 raise Failure()
for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT,signal.SIGALRM): signal.signal(sig,stop)
signal.alarm(210)
resource.setrlimit(resource.RLIMIT_FSIZE,(MAX+1048576,MAX+1048576))
def command(args,data=None,stdout=subprocess.PIPE,pass_fds=()):
 p=subprocess.Popen(args,stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
  stdout=stdout,stderr=subprocess.DEVNULL,pass_fds=pass_fds,env=dict(os.environ,LC_ALL='C'))
 ACTIVE.add(p)
 try:
  out,_=p.communicate(data,timeout=120)
  need(p.returncode==0 and (out is None or len(out)<=65536)); return out
 finally:
  if p.poll() is None: p.kill()
  p.wait(timeout=5); ACTIVE.discard(p)
def guard(path,directory=False,mode=None):
 info=path.lstat(); need(not stat.S_ISLNK(info.st_mode) and info.st_uid==0)
 need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1)
 if mode is not None: need(stat.S_IMODE(info.st_mode)==mode)
 return info
def parents(path):
 for p in reversed(path.parents):
  info=guard(p,True); need(stat.S_IMODE(info.st_mode)&0o022==0)
def syncdir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try: os.fsync(fd)
 finally: os.close(fd)
def write_new(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out: out.write(data); out.flush(); os.fsync(out.fileno())
def write_json(path,value): write_new(path,json.dumps(value,sort_keys=True).encode())
def read_json(path):
 info=guard(path,False,0o600); need(info.st_size<=65536)
 return json.loads(path.read_bytes())
def digest(path):
 guard(path,False,0o600); h=hashlib.sha256(); size=0
 with path.open('rb') as stream:
  for data in iter(lambda:stream.read(65536),b''): h.update(data); size+=len(data)
 return h.hexdigest(),size
def private_dir(path,create=False):
 if create and not exists(path): path.mkdir(mode=0o700)
 guard(path,True,0o700)
def ensure_base(create=False):
 need(stat.S_IMODE(guard(pathlib.Path('/opt'),True).st_mode)&0o022==0)
 for p in (pathlib.Path('/opt/xmail'),pathlib.Path('/opt/xmail/offsite-backups'),BASE):
  private_dir(p,create)
def source_open():
 parents(SOURCE/'snapshot.dump'); guard(SOURCE,True,0o700)
 proof=read_json(SOURCE/'restore-proof.json')
 need(proof.get('status')=='candidate_committed_and_reconciled' and proof.get('applicationCutover') is False
  and proof.get('sourceSnapshot')=='exported_repeatable_read' and proof.get('publicTableCounts')==70 and proof.get('digestGroups')==4)
 guard(SOURCE/'snapshot.dump',False,0o600)
 fd=os.open(SOURCE/'snapshot.dump',os.O_RDONLY|os.O_NOFOLLOW)
 info=os.fstat(fd); need(info.st_uid==0 and info.st_size==SIZE and stat.S_IMODE(info.st_mode)==0o600)
 h=hashlib.sha256()
 for data in iter(lambda:os.read(fd,65536),b''): h.update(data)
 need(h.hexdigest()==SHA); os.lseek(fd,0,os.SEEK_SET)
 return fd,info
def rename_new(source,target):
 libc=ctypes.CDLL(None,use_errno=True)
 fn=libc.renameat2; fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
 fn.restype=ctypes.c_int
 need(fn(-100,os.fsencode(source),-100,os.fsencode(target),1)==0)
def marker(nonce): return {'operation':nonce,'sourceBackup':ID,'sourceSha256':SHA}
def own(path,nonce):
 guard(path,True,0o700); need(read_json(path/'owner.json')==marker(nonce))
def remove_owned(path,nonce,allowed):
 if not exists(path): return
 own(path,nonce); entries=list(path.iterdir()); need({p.name for p in entries}<=set(allowed))
 for p in entries: guard(p,False,0o600)
 for p in entries: p.unlink()
 path.rmdir(); syncdir(BASE)
def cleanup(nonce):
 if not exists(BASE): return {'cleanupVerified':True}
 ensure_base(); lock=BASE/'.operation-lock'
 if not exists(lock):
  need(not exists(BASE/('staging-'+nonce)) and not exists(BASE/('recipient-staging-'+nonce)))
  return {'cleanupVerified':True}
 own(lock,nonce)
 remove_owned(BASE/('staging-'+nonce),nonce,('owner.json','snapshot.dump.cms','received.json','plaintext.partial','receipt.json'))
 remove_owned(BASE/('recipient-staging-'+nonce),nonce,('owner.json','recipient.key','recipient.crt'))
 remove_owned(lock,nonce,('owner.json',))
 return {'cleanupVerified':True}
def recipient():
 root=BASE/'recipient'; private_dir(root)
 key=root/'recipient.key'; cert=root/'recipient.crt'
 guard(key,False,0o600); guard(cert,False,0o600)
 need(cert.stat().st_size<=16384)
 pem=cert.read_bytes(); der=command(['openssl','x509','-outform','DER'],pem)
 text=command(['openssl','x509','-noout','-text','-subject','-nameopt','RFC2253','-checkend','2592000'],pem).decode('ascii')
 need('subject=CN=Xmail offsite backup recipient v1' in text and 'Public-Key: (3072 bit)' in text
  and 'rsaEncryption' in text and 'CA:FALSE' in text and 'Key Encipherment' in text)
 public=command(['openssl','x509','-pubkey','-noout'],pem)
 cert_public=command(['openssl','pkey','-pubin','-outform','DER'],public)
 key_public=command(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'])
 need(cert_public==key_public)
 return pem.decode('ascii'),hashlib.sha256(der).hexdigest()
def prepare(nonce):
 ensure_base(True); need(shutil.disk_usage(BASE).free>=268435456)
 archives=BASE/'archives'; private_dir(archives,True); need(not exists(archives/ID))
 lock=BASE/'.operation-lock'; lock.mkdir(mode=0o700); write_json(lock/'owner.json',marker(nonce)); syncdir(lock); syncdir(BASE)
 stage=BASE/('staging-'+nonce); stage.mkdir(mode=0o700); write_json(stage/'owner.json',marker(nonce)); syncdir(stage)
 if not exists(BASE/'recipient'):
  pending=BASE/('recipient-staging-'+nonce); pending.mkdir(mode=0o700); write_json(pending/'owner.json',marker(nonce))
  command(['openssl','req','-x509','-newkey','rsa:3072','-nodes','-sha256','-days','3650',
   '-subj','/CN=Xmail offsite backup recipient v1','-addext','basicConstraints=critical,CA:FALSE',
   '-addext','keyUsage=critical,keyEncipherment','-keyout',str(pending/'recipient.key'),'-out',str(pending/'recipient.crt')],stdout=subprocess.DEVNULL)
  for path in (pending/'recipient.key',pending/'recipient.crt'):
   os.chmod(path,0o600); guard(path,False,0o600)
   with path.open('rb') as f: os.fsync(f.fileno())
  syncdir(pending); rename_new(pending,BASE/'recipient'); syncdir(BASE)
 pem,fp=recipient()
 return {'prepared':True,'hostVerified':True,'recipientPublicPem':pem,'recipientDerSha256':fp}
def encrypt(packet):
 pem=packet.get('recipientPublicPem','').encode('ascii'); need(len(pem)<=16384 and b'PRIVATE KEY' not in pem)
 fp=hashlib.sha256(command(['openssl','x509','-outform','DER'],pem)).hexdigest(); need(fp==packet.get('recipientDerSha256'))
 fd,before=source_open(); certfd=os.memfd_create('offsite-public-recipient',os.MFD_CLOEXEC)
 try:
  os.write(certfd,pem); os.lseek(certfd,0,os.SEEK_SET)
  command(['openssl','cms','-encrypt','-binary','-stream','-outform','DER','-aes-256-gcm',
   '-recip','/proc/self/fd/'+str(certfd),'-keyopt','rsa_padding_mode:oaep','-keyopt','rsa_oaep_md:sha256',
   '-keyopt','rsa_mgf1_md:sha256','-in','/proc/self/fd/'+str(fd)],stdout=sys.stdout.buffer,pass_fds=(fd,certfd))
  after=os.fstat(fd); need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns))
  os.lseek(fd,0,os.SEEK_SET); h=hashlib.sha256()
  for data in iter(lambda:os.read(fd,65536),b''): h.update(data)
  need(h.hexdigest()==SHA)
 finally: os.close(fd); os.close(certfd)
def receive(packet,nonce):
 ensure_base(); own(BASE/'.operation-lock',nonce); stage=BASE/('staging-'+nonce); own(stage,nonce)
 _,fp=recipient(); need(fp==packet.get('recipientDerSha256'))
 h=hashlib.sha256(); size=0
 fd=os.open(stage/'snapshot.dump.cms',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:
  for data in iter(lambda:sys.stdin.buffer.read(65536),b''):
   size+=len(data); need(size<=MAX); h.update(data); out.write(data)
  need(size>SIZE); out.flush(); os.fsync(out.fileno())
 result={'received':True,'cipherSha256':h.hexdigest(),'cipherBytes':size,'recipientDerSha256':fp}
 write_json(stage/'received.json',result); syncdir(stage); return result
def cms_algorithms(path):
 p=subprocess.Popen(['openssl','cms','-cmsout','-print','-inform','DER','-in',str(path)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 ACTIVE.add(p); head=b''
 try:
  while len(head)<65536 and b'encryptedContent:' not in head:
   chunk=p.stdout.read1(4096)
   if not chunk: break
   head+=chunk
  text=head.decode('ascii','strict')
  need(re.search(r'contentType:\s+id-smime-ct-authEnvelopedData\s+\(1\.2\.840\.113549\.1\.9\.16\.1\.23\)',text)
   and re.search(r'algorithm:\s+aes-256-gcm\s+\(2\.16\.840\.1\.101\.3\.4\.1\.46\)',text)
   and re.search(r'algorithm:\s+rsaesOaep\s+\(1\.2\.840\.113549\.1\.1\.7\)',text)
   and text.count('d.ktri:')==1)
 finally:
  if p.poll() is None: p.kill()
  p.wait(timeout=5); p.stdout.close(); ACTIVE.discard(p)
def finalize(packet,nonce):
 ensure_base(); own(BASE/'.operation-lock',nonce); stage=BASE/('staging-'+nonce); own(stage,nonce)
 _,fp=recipient(); need(fp==packet.get('recipientDerSha256'))
 received=read_json(stage/'received.json'); need(received==packet.get('received'))
 encrypted=stage/'snapshot.dump.cms'; h,size=digest(encrypted)
 need((h,size)==(received['cipherSha256'],received['cipherBytes']))
 cms_algorithms(encrypted)
 plaintext=stage/'plaintext.partial'
 fd=os.open(plaintext,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'wb') as out:
   command(['openssl','cms','-decrypt','-binary','-inform','DER','-in',str(encrypted),
    '-recip',str(BASE/'recipient/recipient.crt'),'-inkey',str(BASE/'recipient/recipient.key')],stdout=out)
   out.flush(); os.fsync(out.fileno())
  # No plaintext is accepted/hashed until authenticated decryption returned zero.
  need(digest(plaintext)==(SHA,SIZE))
 finally:
  if exists(plaintext): guard(plaintext,False,0o600); plaintext.unlink(); syncdir(stage)
 proof={'ok':True,'status':'encrypted_snapshot_copied_and_byte_verified','sourceBackup':ID,
  'sourceSha256':SHA,'sourceBytes':SIZE,'cipherSha256':h,'cipherBytes':size,'recipientDerSha256':fp,
  'cmsType':'AuthEnvelopedData','cipher':'AES-256-GCM','keyTransport':'RSA-OAEP-SHA256',
  'aeadVerified':True,'recoveryByteExact':True,'targetHostVerified':True,'published':True,
  'receiptFsynced':True,'newPgRestore':False,'r2Backup':False,'dailySchedule':False,'applicationCutover':False}
 write_json(stage/'receipt.json',proof); syncdir(stage)
 archives=BASE/'archives'; private_dir(archives); rename_new(stage,archives/ID); syncdir(archives); syncdir(BASE)
 cleanup(nonce); return proof
packet={}; action=''
try:
 os.umask(0o077); need(os.geteuid()==0)
 raw=sys.stdin.buffer.readline(32769); need(len(raw)<=32768 and raw.endswith(b'\n'))
 packet=json.loads(raw); action=packet.get('action'); nonce=packet.get('operation','')
 need(re.fullmatch(r'[a-f0-9]{32}',nonce) is not None)
 need(action in ('source-check','target-check','prepare','source-encrypt','receive','finalize','cleanup'))
 expected=S if action in ('source-check','source-encrypt') else T
 need(os.environ.get('SSH_CONNECTION','').split()[2:3]==[expected])
 if action=='source-check':
  fd,_=source_open(); os.close(fd); result={'hostVerified':True,'sourceSha256':SHA,'sourceBytes':SIZE,'reconciledReceipt':True}
 elif action=='target-check':
  guard(pathlib.Path('/opt'),True); need(shutil.disk_usage('/opt').free>=268435456)
  if exists(BASE): ensure_base(); need(not exists(BASE/'archives'/ID))
  version=command(['openssl','version']).decode(); need(version.startswith('OpenSSL 3.'))
  result={'hostVerified':True,'capacityAccepted':True}
 elif action=='prepare': result=prepare(nonce)
 elif action=='receive': result=receive(packet,nonce)
 elif action=='finalize': result=finalize(packet,nonce)
 elif action=='cleanup': result=cleanup(nonce)
 else: encrypt(packet); result=None
 if result is not None: print(json.dumps(result,sort_keys=True))
except BaseException:
 for p in list(ACTIVE):
  if p.poll() is None: p.kill()
 if action!='source-encrypt': print('{"ok":false,"errorCode":"OFFSITE_REMOTE_OPERATION_FAILED"}')
 sys.exit(2)
`;

const REMOTE_COMMAND = `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(REMOTE).toString('base64')}"))'`;
const fail = (code) => { throw new Error(code); };
const need = (value, code) => { if (!value) fail(code); };
const digestPattern = /^[a-f0-9]{64}$/;
function sshEnvironment(env = process.env) {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'userprofile', 'homedrive', 'homepath',
    'programdata', 'ssh_auth_sock', 'temp', 'tmp', 'home', 'lang', 'lc_all']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())));
}
function remote(host, packet, binary = false, allowInterrupted = false) {
  need([SOURCE, TARGET].includes(host), 'HOST_PIN_MISMATCH');
  need(!interrupted || allowInterrupted, 'INTERRUPTED');
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2', `root@${host}`, REMOTE_COMMAND],
  { windowsHide: true, shell: false, env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let output = [], bytes = 0, invalid = false;
  child.stderr.on('data', () => {}); // Never forward raw remote/SSH/OpenSSL diagnostics.
  if (!binary) child.stdout.on('data', (data) => {
    bytes += data.length;
    if (bytes > 65536) { invalid = true; child.kill(); } else output.push(data);
  });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill(), 240000);
  const completion = new Promise((resolve) => {
    child.once('error', () => { invalid = true; resolve({ code: -1 }); });
    child.once('close', (code) => { clearTimeout(timer); children.delete(child); resolve({ code }); });
  });
  child.stdin.write(JSON.stringify(packet) + '\n');
  return { child, completion, async json() {
    const { code } = await completion;
    need(code === 0 && !invalid, 'SSH_OPERATION_FAILED');
    let result;
    try { result = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { fail('REMOTE_METADATA_INVALID'); }
    need(result && result.ok !== false, 'REMOTE_OPERATION_FAILED');
    return result;
  } };
}
async function metadata(host, packet, allowInterrupted = false) {
  const operation = remote(host, packet, false, allowInterrupted);
  operation.child.stdin.end();
  return operation.json();
}
async function relay(operation, prepared) {
  const target = remote(TARGET, { action: 'receive', operation,
    recipientDerSha256: prepared.recipientDerSha256 });
  const source = remote(SOURCE, { action: 'source-encrypt', operation,
    recipientPublicPem: prepared.recipientPublicPem, recipientDerSha256: prepared.recipientDerSha256 }, true);
  source.child.stdin.end();
  try {
    const [received, sourceExit] = await Promise.all([
      target.json(), source.completion, pipeline(source.child.stdout, target.child.stdin),
    ]);
    need(sourceExit.code === 0, 'SOURCE_ENCRYPTION_FAILED');
    return received;
  } finally {
    if (source.child.exitCode === null) source.child.kill();
    if (target.child.exitCode === null) target.child.kill();
    await Promise.all([source.completion, target.completion]);
  }
}
function validateSource(value) {
  need(value.hostVerified === true && value.reconciledReceipt === true && value.sourceSha256 === SOURCE_SHA
    && value.sourceBytes === SOURCE_BYTES, 'SOURCE_PROOF_MISMATCH');
}
function validatePrepared(value) {
  need(value.prepared === true && value.hostVerified === true && digestPattern.test(value.recipientDerSha256)
    && typeof value.recipientPublicPem === 'string' && value.recipientPublicPem.length <= 16384
    && !value.recipientPublicPem.includes('PRIVATE KEY'), 'RECIPIENT_PROOF_MISMATCH');
}
function validateReceived(value, prepared) {
  need(value.received === true && digestPattern.test(value.cipherSha256)
    && Number.isSafeInteger(value.cipherBytes) && value.cipherBytes > SOURCE_BYTES && value.cipherBytes <= MAX_CIPHER
    && value.recipientDerSha256 === prepared.recipientDerSha256, 'CIPHER_RECEIPT_MISMATCH');
}
function validateFinal(value, received) {
  need(value.ok === true && value.sourceBackup === BACKUP && value.sourceSha256 === SOURCE_SHA
    && value.sourceBytes === SOURCE_BYTES && value.cipherSha256 === received.cipherSha256
    && value.cipherBytes === received.cipherBytes && value.recipientDerSha256 === received.recipientDerSha256
    && value.cmsType === 'AuthEnvelopedData' && value.cipher === 'AES-256-GCM'
    && value.keyTransport === 'RSA-OAEP-SHA256' && value.aeadVerified === true && value.recoveryByteExact === true
    && value.targetHostVerified === true && value.published === true && value.receiptFsynced === true
    && value.newPgRestore === false && value.r2Backup === false && value.dailySchedule === false
    && value.applicationCutover === false, 'FINAL_RECOVERY_PROOF_MISMATCH');
}
const real = {
  source: (operation) => metadata(SOURCE, { action: 'source-check', operation }),
  target: (operation) => metadata(TARGET, { action: 'target-check', operation }),
  prepare: (operation) => metadata(TARGET, { action: 'prepare', operation }), relay,
  finalize: (operation, prepared, received) => metadata(TARGET,
    { action: 'finalize', operation, recipientDerSha256: prepared.recipientDerSha256, received }),
  cleanup: (operation) => metadata(TARGET, { action: 'cleanup', operation }, true),
};
async function execute(deps = real, operation = randomBytes(16).toString('hex')) {
  let started = false, published = false;
  try {
    const [source, target] = await Promise.all([deps.source(operation), deps.target(operation)]);
    validateSource(source);
    need(target.hostVerified === true && target.capacityAccepted === true, 'TARGET_PROOF_MISMATCH');
    started = true;
    const prepared = await deps.prepare(operation); validatePrepared(prepared);
    const received = await deps.relay(operation, prepared); validateReceived(received, prepared);
    const proof = await deps.finalize(operation, prepared, received); validateFinal(proof, received);
    published = true;
    return proof;
  } finally {
    if (started && !published) {
      const proof = await deps.cleanup(operation);
      need(proof.cleanupVerified === true, 'CLEANUP_REQUIRES_REVIEW');
    }
  }
}
async function selfTest() {
  let tests = 0;
  const source = { hostVerified: true, reconciledReceipt: true, sourceSha256: SOURCE_SHA, sourceBytes: SOURCE_BYTES };
  const prepared = { prepared: true, hostVerified: true, recipientPublicPem: 'PUBLIC CERTIFICATE', recipientDerSha256: '1'.repeat(64) };
  const received = { received: true, cipherSha256: '2'.repeat(64), cipherBytes: SOURCE_BYTES + 2000, recipientDerSha256: prepared.recipientDerSha256 };
  const proof = { ok: true, sourceBackup: BACKUP, sourceSha256: SOURCE_SHA, sourceBytes: SOURCE_BYTES,
    ...received, cmsType: 'AuthEnvelopedData', cipher: 'AES-256-GCM', keyTransport: 'RSA-OAEP-SHA256',
    aeadVerified: true, recoveryByteExact: true, targetHostVerified: true, published: true, receiptFsynced: true,
    newPgRestore: false, r2Backup: false, dailySchedule: false, applicationCutover: false };
  const fixture = () => {
    const calls = [];
    return { calls, source: async () => { calls.push('source'); return source; },
      target: async () => { calls.push('target'); return { hostVerified: true, capacityAccepted: true }; },
      prepare: async () => { calls.push('prepare'); return prepared; },
      relay: async () => { calls.push('relay'); return received; },
      finalize: async () => { calls.push('finalize'); return proof; },
      cleanup: async () => { calls.push('cleanup'); return { cleanupVerified: true }; } };
  };
  const good = fixture(); await execute(good); assert.deepEqual(good.calls, ['source', 'target', 'prepare', 'relay', 'finalize']); tests++;
  for (const change of [{ sourceSha256: '0'.repeat(64) }, { sourceBytes: 1 }, { hostVerified: false }]) {
    const f = fixture(); f.source = async () => ({ ...source, ...change });
    await assert.rejects(execute(f)); assert(!f.calls.includes('prepare')); tests++;
  }
  const wrongHost = fixture(); wrongHost.target = async () => ({ hostVerified: false, capacityAccepted: true });
  await assert.rejects(execute(wrongHost)); assert(!wrongHost.calls.includes('prepare')); tests++;
  for (const change of [{ aeadVerified: false }, { sourceSha256: '0'.repeat(64) }, { published: false },
    { receiptFsynced: false }, { cipher: 'AES-256-CBC' }, { newPgRestore: true }]) {
    const f = fixture(); f.finalize = async () => ({ ...proof, ...change });
    await assert.rejects(execute(f)); assert(f.calls.includes('cleanup')); tests++;
  }
  const truncated = fixture(); truncated.relay = async () => ({ ...received, cipherBytes: 1 });
  await assert.rejects(execute(truncated)); assert(!truncated.calls.includes('finalize')); assert(truncated.calls.includes('cleanup')); tests++;
  const failedStream = fixture(); failedStream.relay = async () => fail('SIMULATED_SOURCE_FAILURE');
  await assert.rejects(execute(failedStream)); assert(!failedStream.calls.includes('finalize')); assert(failedStream.calls.includes('cleanup')); tests++;
  const env = sshEnvironment({ ProgramData: 'PUBLIC', PATH: 'PUBLIC', DATABASE_URL: 'PRIVATE', TOKEN: 'PRIVATE' });
  assert.deepEqual(env, { ProgramData: 'PUBLIC', PATH: 'PUBLIC' }); tests++;
  assert.equal(SOURCE, '49.13.197.250'); assert.equal(TARGET, '188.245.112.3');
  assert.equal(BASE, '/opt/xmail/offsite-backups/v1'); tests++;
  console.log(JSON.stringify({ ok: true, offlineTests: tests, sshCalls: 0, hostWrites: false }));
}
const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--self-test') await selfTest();
  else if (args.length === 0 || args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify({ mode: 'plan', networkCalls: false, hostWrites: false, sourceHost: SOURCE,
      sourceBackup: BACKUP, sourceSha256: SOURCE_SHA, sourceBytes: SOURCE_BYTES, targetHost: TARGET, destination: BASE,
      cipher: 'CMS AuthEnvelopedData / AES-256-GCM / RSA-3072 OAEP-SHA256', newPgRestore: false,
      r2Backup: false, dailySchedule: false, applicationCutover: false }, null, 2));
  } else {
    need(args.length === 1 && args[0] === '--execute', 'INVALID_ARGUMENTS');
    const stop = () => { interrupted = true; for (const child of children) child.kill(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const timer = setTimeout(stop, 360000);
    try { console.log(JSON.stringify(await execute(), null, 2)); } finally { clearTimeout(timer); }
  }
} catch {
  for (const child of children) child.kill();
  console.error('{"ok":false,"errorCode":"OFFSITE_BACKUP_FAILED_REVIEW_REQUIRED"}');
  process.exitCode = 2;
}
