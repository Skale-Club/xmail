#!/usr/bin/env python3
"""Install only Xmail's dedicated backup transport and daily timer. Offline default."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

SOURCE='49.13.197.250';TARGET='188.245.112.3'
HOST_SHA='76811c7f728946b63c41a9f656caee1015bd91db43eb6f6363efd699976b62cb'
OPS=Path('/opt/xmail/owned-backup-ops')
SERVICE='''[Unit]
Description=Xmail owned SQL encrypted offsite backup and isolated restore proof
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=root
Group=root
UMask=0077
ExecStart=/usr/bin/python3 -B /opt/xmail/owned-backup-ops/code/xmail-owned-backup.py --backup
TimeoutStartSec=650
CPUQuota=50%
MemoryMax=256M
Nice=10
IOSchedulingClass=idle
StandardOutput=journal
StandardError=journal
'''
TIMER='''[Unit]
Description=Daily verified Xmail owned SQL offsite backup

[Timer]
OnCalendar=*-*-* 03:15:00 UTC
RandomizedDelaySec=15m
Persistent=true
Unit=xmail-owned-backup.service

[Install]
WantedBy=timers.target
'''


def need(value):
    if not value:raise ValueError('Backup installation refused')


def public_key(value):
    need(isinstance(value,str) and re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]{60,100}={0,2}(?: xmail-owned-backup-v2)?',value))
    raw=base64.b64decode(value.split()[1],validate=True)
    need(len(raw)==51 and raw[:15]==b'\x00\x00\x00\x0bssh-ed25519')
    return ' '.join(value.split()[:2])


def authorized_line(key):
    return 'from="'+SOURCE+'",restrict,command="/usr/bin/python3 -B '+str(OPS)+'/code/xmail-owned-backup.py --receive" '+public_key(key)+' xmail-owned-backup-v2'


def host_line(value):
    need(isinstance(value,str) and '\n' not in value and '\r' not in value)
    parts=value.split();need(len(parts)==3 and parts[:2]==[TARGET,'ssh-ed25519']
        and hashlib.sha256(base64.b64decode(parts[2],validate=True)).hexdigest()==HOST_SHA)
    return value+'\n'


def run(args):
    need(sys.platform.startswith('linux') and os.geteuid()==0 and args.role in ['source','target']
        and re.fullmatch(r'[a-f0-9]{64}',args.backup_script_sha256 or ''))
    path=Path(__file__).with_name('xmail-owned-backup.py');raw=path.read_bytes().replace(b'\r\n',b'\n')
    need(hashlib.sha256(raw).hexdigest()==args.backup_script_sha256)
    spec=importlib.util.spec_from_file_location('reviewed_owned_backup',path);op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)
    m,c=op.libraries();os.umask(0o077)
    expected=SOURCE if args.role=='source' else TARGET
    need(os.environ.get('SSH_CONNECTION','').split()[2:3]==[expected])
    op.private_dir(c,OPS,True)
    code=OPS/'code';op.private_dir(c,code,True)
    def exact_file(destination,content):
        if os.path.lexists(destination):c['guard'](destination,False,0o600);need(destination.read_bytes()==content)
        else:m.durable_file(destination,content)
    for name in ['xmail-owned-backup.py','xmail-offsite-backup.mjs','prepare-xmail-final-data-cutover.py']:
        incoming=Path(__file__).with_name(name);c['guard'](incoming,False,0o600)
        exact_file(code/name,incoming.read_bytes().replace(b'\r\n',b'\n'))
    payload={}
    if not args.prepare_transport:
        raw_packet=sys.stdin.buffer.read(32769);need(len(raw_packet)<=32768);payload=json.loads(raw_packet)
    if args.role=='target':
        need(not args.prepare_transport and set(payload)=={'transportPublicKey'})
        _,fp=c['recipient']();need(fp==op.RECIPIENT_SHA)
        op.private_dir(c,op.ARCHIVES,True)
        exact_file(OPS/'receiver.lock',b'')
        directory=Path('/root/.ssh');op.private_dir(c,directory)
        keys=directory/'authorized_keys';c['guard'](keys,False,0o600);old=keys.read_bytes()
        need(len(old)<=1024*1024 and b'\x00' not in old)
        line=authorized_line(payload['transportPublicKey']).encode()
        current=[v for v in old.splitlines() if b'xmail-owned-backup-v2' in v]
        need(not current or current==[line])
        if not current:
            need(keys.read_bytes()==old)
            m.durable_file(keys,old+(b'' if not old or old.endswith(b'\n') else b'\n')+line+b'\n',replace=True)
        need(keys.read_bytes().splitlines().count(line)==1)
        return {'targetTransportInstalled':True,'forcedCommandOnly':True,'recipientPreserved':True,'applicationChanged':False}
    key=OPS/'transport.key';pub=OPS/'transport.key.pub'
    if not os.path.lexists(key):
        need(not os.path.lexists(pub))
        c['command'](['ssh-keygen','-q','-t','ed25519','-N','','-C','xmail-owned-backup-v2','-f',str(key)])
        os.chmod(key,0o600);os.chmod(pub,0o600)
        for p in [key,pub]:
            with p.open('rb') as stream:os.fsync(stream.fileno())
        c['syncdir'](OPS)
    c['guard'](key,False,0o600);c['guard'](pub,False,0o600)
    derived=public_key(c['command'](['ssh-keygen','-y','-f',str(key)]).decode().strip())
    need(derived==public_key(pub.read_text().strip()))
    if args.prepare_transport:return {'transportPublicKey':derived,'privateKeyStayedOnSource':True}
    need(set(payload)=={'recipientPublicPem','targetKnownHost'})
    pem=payload['recipientPublicPem'].encode('ascii');need(len(pem)<=16384 and b'PRIVATE KEY' not in pem)
    need(hashlib.sha256(c['command'](['openssl','x509','-outform','DER'],pem)).hexdigest()==op.RECIPIENT_SHA)
    exact_file(OPS/'recipient.crt',pem);exact_file(OPS/'known_hosts',host_line(payload['targetKnownHost']).encode())
    exact_file(OPS/'backup.lock',b'');op.private_dir(c,OPS/'local-archives',True)
    for name,content in [('xmail-owned-backup.service',SERVICE),('xmail-owned-backup.timer',TIMER)]:
        destination=Path('/etc/systemd/system')/name
        if os.path.lexists(destination):
            c['guard'](destination,False);need(stat.S_IMODE(destination.stat().st_mode)==0o644 and destination.read_text()==content)
        else:
            m.durable_file(destination,content.encode());os.chmod(destination,0o644)
            with destination.open('rb') as stream:os.fsync(stream.fileno())
            m.fsync_directory(destination.parent)
    c['command'](['systemd-analyze','verify','/etc/systemd/system/xmail-owned-backup.service','/etc/systemd/system/xmail-owned-backup.timer'])
    c['command'](['systemctl','daemon-reload']);c['command'](['systemctl','enable','xmail-owned-backup.timer'])
    # Start the timer only after the first successful manually reviewed run.
    return {'sourceTransportInstalled':True,'timerEnabled':True,'timerStarted':False,'privateKeyStayedOnSource':True,'applicationChanged':False}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');p.add_argument('--role',choices=['source','target']);p.add_argument('--prepare-transport',action='store_true');p.add_argument('--backup-script-sha256')
    args=p.parse_args()
    if not args.apply:print('PLAN ONLY: root-only dedicated transport, existing recipient and daily timer; no I/O or host changes.');return
    print(json.dumps(run(args)))


if __name__=='__main__':
    try:main()
    except Exception:
        print('Owned backup installation refused/failed; diagnostics suppressed; app and existing credentials unchanged.',file=sys.stderr);sys.exit(1)
