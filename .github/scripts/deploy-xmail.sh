#!/usr/bin/env bash
set -euo pipefail

APP_NAME="xmail"
NEXT_NAME="xmail-next"
LEGACY_IMAGE_NAME="skaleclub""-mail"
DEPLOY_VERSION="${DEPLOY_VERSION}"
DEPLOYED_AT="${DEPLOYED_AT}"
TRAEFIK_DYN="/data/coolify/proxy/dynamic/xmail.yaml"
LEGACY_TRAFIK_DYN="/data/coolify/proxy/dynamic/skaleclub""-mail.yaml"

echo "::group::Log in to GHCR"
echo "${GHCR_AUTH_TOKEN}" | docker login ghcr.io -u "${GHCR_ACTOR}" --password-stdin
# The GITHUB_TOKEN is an ephemeral GitHub App installation token (ghs_*,
# ~1h TTL). Leaving it in /root/.docker/config.json after the run poisons
# every later ghcr.io pull on the host (e.g. Coolify self-updates) with
# "denied" once it expires. Drop it on exit no matter how the script ends.
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
echo "::endgroup::"

echo "::group::Disk space check"
DISK_FREE_KB=$(df / | awk 'NR==2 {print $4}')
DISK_FREE_GB=$((DISK_FREE_KB / 1024 / 1024))
echo "Free: ${DISK_FREE_GB}GB"
if [ "$DISK_FREE_GB" -lt 2 ]; then
  echo "Less than 2GB free, aborting"
  exit 1
fi
echo "::endgroup::"

echo "::group::Prepare images"
if docker images "${APP_NAME}:latest" --format "{{.ID}}" | grep -q .; then
  docker tag "${APP_NAME}:latest" "${APP_NAME}:previous" || true
elif docker images "${LEGACY_IMAGE_NAME}:latest" --format "{{.ID}}" | grep -q .; then
  docker tag "${LEGACY_IMAGE_NAME}:latest" "${APP_NAME}:previous" || true
fi

docker pull "${IMAGE_NAME}:latest"
docker tag "${IMAGE_NAME}:latest" "${APP_NAME}:latest"
docker tag "${IMAGE_NAME}:latest" "${APP_NAME}:${DEPLOY_VERSION}"
echo "::endgroup::"

USING_COOLIFY=false
NETWORK_FLAG=""
if docker network ls --format "{{.Name}}" | grep -qE "^coolify$"; then
  USING_COOLIFY=true
  NETWORK_FLAG="--network coolify"
  echo "Coolify network detected"
fi

# Saida de e-mail: SMTP_HOST e SMTP_USER NAO sao passados ao container de proposito.
# Sem eles a plataforma resolve o MX de cada destinatario e entrega direto, assinando
# com a chave DKIM do dominio remetente — medido no Gmail em 2026-08-16:
# dkim=pass header.i=@skale.club, spf=pass smtp.mailfrom=info@skale.club, dmarc=pass.
# Por relay de terceiro o corpo era reescrito e a nossa assinatura chegava como
# dkim=neutral (body hash did not verify).
# Pre-requisitos ja satisfeitos neste host: porta 25 de SAIDA liberada pela Hetzner e
# PTR de 49.13.197.250 = mx.skale.club. Testes no .env.example.
# ROLLBACK: re-adicionar as duas linhas -e SMTP_HOST=... e -e SMTP_USER=... na lista
# de -e abaixo (os secrets continuam no repositorio).
GOOGLE_RUNTIME_PARENT_DIR="/opt"
GOOGLE_RUNTIME_ROOT="/opt/xmail"
GOOGLE_RUNTIME_OPS_DIR="${GOOGLE_RUNTIME_ROOT}/google-identity-ops"
GOOGLE_RUNTIME_ENV_FILE="${GOOGLE_RUNTIME_OPS_DIR}/google-auth.env"
GOOGLE_RUNTIME_HOST_DIR="${GOOGLE_RUNTIME_ROOT}/google-identity-runtime"
GOOGLE_RUNTIME_CONTAINER_DIR="/run/secrets/xmail-google-identity"
GOOGLE_RUNTIME_ARGS=""

google_runtime_failure() {
  echo "::error::The fixed Xmail Google runtime binding failed host-file validation." >&2
  return 1
}

google_runtime_check_directory() {
  local path="$1"
  local expected_mode="$2"
  local metadata uid gid mode links permissions
  [ -d "$path" ] && [ ! -L "$path" ] || return 1
  metadata=$(stat -c '%u:%g:%a:%h' -- "$path" 2>/dev/null) || return 1
  IFS=: read -r uid gid mode links <<< "$metadata"
  [ "$uid" = "0" ] && [ "$gid" = "0" ] || return 1
  if [ "$expected_mode" = "safe" ]; then
    permissions=$((8#$mode))
    (( (permissions & 18) == 0 )) || return 1
  else
    [ "$mode" = "$expected_mode" ] || return 1
  fi
}

google_runtime_check_file() {
  local path="$1"
  local maximum="$2"
  local metadata uid gid mode links size
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  metadata=$(stat -c '%u:%g:%a:%h:%s' -- "$path" 2>/dev/null) || return 1
  IFS=: read -r uid gid mode links size <<< "$metadata"
  [ "$uid" = "0" ] && [ "$gid" = "0" ] && [ "$mode" = "600" ] \
    && [ "$links" = "1" ] && [ "$size" -gt 0 ] && [ "$size" -le "$maximum" ]
}

prepare_google_runtime_binding() {
  GOOGLE_RUNTIME_ARGS=""
  # No staged file means the existing production invocation and image defaults
  # are unchanged. A dangling symlink counts as present and fails closed below.
  if [ ! -e "$GOOGLE_RUNTIME_ENV_FILE" ] && [ ! -L "$GOOGLE_RUNTIME_ENV_FILE" ]; then
    return 0
  fi

  google_runtime_check_directory "$GOOGLE_RUNTIME_PARENT_DIR" safe \
    && google_runtime_check_directory "$GOOGLE_RUNTIME_ROOT" safe \
    && google_runtime_check_directory "$GOOGLE_RUNTIME_OPS_DIR" 700 \
    && google_runtime_check_directory "$GOOGLE_RUNTIME_HOST_DIR" 750 \
    || { google_runtime_failure; return 1; }
  google_runtime_check_file "$GOOGLE_RUNTIME_ENV_FILE" 16384 \
    || { google_runtime_failure; return 1; }
  if ! awk '
    /^[[:space:]]*($|#)/ { next }
    {
      separator = index($0, "=")
      if (!separator) exit 1
      key = substr($0, 1, separator - 1)
      if (key !~ /^XMAIL_GOOGLE_AUTH_[A-Z0-9_]+$/ || seen[key]++) exit 1
      count++
    }
    END { if (!count) exit 1 }
  ' "$GOOGLE_RUNTIME_ENV_FILE" >/dev/null 2>&1; then
    google_runtime_failure
    return 1
  fi

  for runtime_file in adc.json certificate-config.json client.crt client.key trust-chain.pem; do
    case "$runtime_file" in
      adc.json) maximum=65536 ;;
      certificate-config.json) maximum=16384 ;;
      client.crt|client.key) maximum=32768 ;;
      trust-chain.pem) maximum=131072 ;;
    esac
    google_runtime_check_file "${GOOGLE_RUNTIME_HOST_DIR}/${runtime_file}" "$maximum" \
      || { google_runtime_failure; return 1; }
  done
  expected_entries=$(printf '%s\n' adc.json certificate-config.json client.crt client.key trust-chain.pem | LC_ALL=C sort)
  actual_entries=$(find "$GOOGLE_RUNTIME_HOST_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | LC_ALL=C sort) \
    || { google_runtime_failure; return 1; }
  [ "$actual_entries" = "$expected_entries" ] || { google_runtime_failure; return 1; }

  # This is the one fixed Xmail Google config file, never the workflow env set.
  GOOGLE_RUNTIME_ARGS="--env-file ${GOOGLE_RUNTIME_ENV_FILE} --mount type=bind,source=${GOOGLE_RUNTIME_HOST_DIR},target=${GOOGLE_RUNTIME_CONTAINER_DIR},readonly"
}

# BEGIN XMAIL OWNED POLICY (offline fixtures execute this exact heredoc)
OWNED_RUNTIME_OPS_DIR="/opt/xmail/owned-runtime-ops"
OWNED_RUNTIME_ENV_FILE="${OWNED_RUNTIME_OPS_DIR}/owned-runtime.env"
OWNED_READER_ENV_FILE="${OWNED_RUNTIME_OPS_DIR}/reader.env"
OWNED_BASE_ENV_FILE="${OWNED_RUNTIME_OPS_DIR}/production-base.env"
OWNED_MODE="legacy"
OWNED_IMAGE_ID=""
OWNED_SOURCE_SHA=""
OWNED_PROFILE_SHA=""

owned_policy() {
  python3 - "$@" <<'XMAIL_OWNED_POLICY_PY'
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit, unquote, parse_qsl

ROOT = Path('/opt/xmail/owned-runtime-ops')
TARGET = 'e12scyfsrp822dag7m9wwd4x'
PG_IMAGE = 'sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
IDENTITY = ['xmail_identity_bindings', 'xmail_identity_browser_challenges', 'xmail_identity_owned_sessions', 'xmail_identity_user_controls']
BASE_KEYS = set('NODE_ENV PORT SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY JWT_SECRET ENCRYPTION_KEY OUTLOOK_TOKEN_ENCRYPTION_KEY MAIL_DOMAIN OUTREACH_PROTECTED_DOMAINS OUTREACH_HOME_BASE_ZIP OUTREACH_HOME_RADIUS_MILES MAIL_HOST MAIL_TLS_CERT_PATH MAIL_TLS_KEY_PATH APP_COMPANY_NAME APP_APPLICATION_NAME SMTP_PASS SMTP_FROM FRONTEND_URL SMTP_SUBMISSION_PORT MX_PORT IMAP_PORT ENABLE_MAIL_SERVER XMAIL_SERVICE_KEY XMAIL_SERVICE_USER_ID XMAIL_SERVICE_ORGANIZATION_ID XPHERE_EVENTS_URL XPHERE_EVENTS_API_KEY APOLLO_API_KEY XCRAPER_SERVICE_URL XCRAPER_SERVICE_KEY PROSPECTING_DAILY_BUDGET_USD R2_ACCOUNT_ID R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PUBLIC_BASE_URL MONITOR_API_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID DB_LIVENESS_INTERVAL_MS DB_LIVENESS_PROBE_TIMEOUT_MS DB_LIVENESS_EXIT_AFTER_MS'.split())
PROFILE_KEYS = set('DATABASE_URL DIRECT_URL XMAIL_BROWSER_AUTH_AUTHORITY XMAIL_USER_ADMIN_AUTHORITY DB_POOL_MAX DB_JOB_POOL_MAX XMAIL_ADMIN_DB_POOL_MAX XMAIL_DB_ROLE_CONNECTION_LIMIT XMAIL_DB_CONNECTION_RESERVE XMAIL_DB_PROCESS_COUNT XMAIL_OWNED_AUTH_PHASE XMAIL_OWNED_DEPLOY_MODE XMAIL_OWNED_APPROVED_IMAGE_ID XMAIL_OWNED_APPROVED_SOURCE_SHA XMAIL_OWNED_RECEIPT_SHA256'.split())
READER_KEYS = set('NODE_ENV XMAIL_STAGING_HTTP_ONLY XMAIL_STAGING_ORIGIN XMAIL_STAGING_DATABASE_URL XMAIL_GOOGLE_AUTH_ENABLED GOOGLE_AUTH_ENABLED'.split())
PROOF_FILES = {'freeze': 'freeze-receipt.json', 'snapshot': 'snapshot-receipt.json', 'final-import': 'final-import-receipt.json', 'controls': 'controls-receipt.json', 'admin-acceptance': 'admin-acceptance-receipt.json'}
COMMON = set('version app kind target database role postgresImage applicationImage sourceSha authPhase sourceKind oldContainerId createdAt expiresAt facts'.split())

def need(value):
    if not value: raise ValueError('Owned deployment policy refused')

def sha(raw): return hashlib.sha256(raw).hexdigest()

def digest(value): return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None

def image(value): return isinstance(value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value) is not None

def secure_directory(path, private=False):
    m = path.lstat()
    need(stat.S_ISDIR(m.st_mode) and not path.is_symlink() and m.st_uid == 0 and m.st_gid == 0)
    need(stat.S_IMODE(m.st_mode) == 0o700 if private else stat.S_IMODE(m.st_mode) & 0o022 == 0)

def secure_read(path, maximum=65536):
    m = path.lstat()
    need(stat.S_ISREG(m.st_mode) and m.st_uid == 0 and m.st_gid == 0 and m.st_nlink == 1
         and stat.S_IMODE(m.st_mode) == 0o600 and 0 < m.st_size <= maximum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(fd)
        need((actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns) == (m.st_dev, m.st_ino, m.st_size, m.st_mtime_ns))
        raw = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        need(len(raw) == m.st_size and (after.st_size, after.st_mtime_ns) == (m.st_size, m.st_mtime_ns))
        return raw
    finally: os.close(fd)

def env_file(raw, allowed, exact=True):
    text = raw.decode('utf-8')
    need('\r' not in text and '\x00' not in text)
    result = {}
    for line in text.split('\n'):
        if not line or line.startswith('#'): continue
        key, separator, value = line.partition('=')
        need(separator and key in allowed and key not in result and not any(ord(c) < 32 for c in value))
        result[key] = value
    need(set(result) == allowed if exact else bool(result))
    return result

def json_file(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            need(key not in value)
            value[key] = item
        return value
    value = json.loads(raw, object_pairs_hook=unique)
    need(isinstance(value, dict))
    return value

def database_url(value, role):
    url = urlsplit(value)
    need(url.scheme in ('postgres', 'postgresql') and url.hostname == TARGET and url.port == 5432
         and url.path == '/xmail' and unquote(url.username or '') == role and bool(url.password)
         and not any(c in unquote(url.password) for c in '\r\n\x00') and not url.query and not url.fragment)

def source_database_url(value):
    url = urlsplit(value)
    user = unquote(url.username or '')
    ref = 'zzbudkfkcmqkavgwselc'
    need(url.scheme in ['postgres', 'postgresql'] and url.path == '/postgres' and url.port in [5432, 6543]
         and bool(url.password) and not url.fragment
         and ((url.hostname == 'db.'+ref+'.supabase.co' and user == 'postgres')
              or (re.fullmatch(r'aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com', url.hostname or '') and user == 'postgres.'+ref)))
    options = parse_qsl(url.query)
    need(len({k for k, v in options}) == len(options) and all(k in ['sslmode', 'application_name']
         and (k != 'sslmode' or v in ['require', 'verify-ca', 'verify-full']) for k, v in options))

def timestamp(value):
    need(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value))
    return dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)

def live_window(value, now):
    created, expiry = timestamp(value['createdAt']), timestamp(value['expiresAt'])
    need(dt.timedelta(0) < expiry-created <= dt.timedelta(minutes=15)
         and created <= now < expiry and now-created <= dt.timedelta(minutes=15))
    return created

def docker(args, payload=None):
    result = subprocess.run(['docker']+args, input=payload, capture_output=True, timeout=10, check=False)
    need(result.returncode == 0 and len(result.stdout) <= 2*1024*1024)
    return result.stdout

def inspect(identifier):
    values = json.loads(docker(['inspect', identifier]))
    need(isinstance(values, list) and len(values) == 1)
    return values[0]

def container_env(value):
    result = {}
    for line in value['Config'].get('Env') or []:
        key, _, item = line.partition('=')
        need(key not in result)
        result[key] = item
    return result

def profiles(root=ROOT):
    need(os.geteuid() == 0)
    secure_directory(root.parent.parent); secure_directory(root.parent); secure_directory(root, True)
    raw = secure_read(root/'owned-runtime.env', 16384)
    p = env_file(raw, PROFILE_KEYS)
    need(p['XMAIL_OWNED_DEPLOY_MODE'] in ('preview', 'promote') and image(p['XMAIL_OWNED_APPROVED_IMAGE_ID'])
         and re.fullmatch(r'[a-f0-9]{40}', p['XMAIL_OWNED_APPROVED_SOURCE_SHA']))
    need(p['XMAIL_OWNED_AUTH_PHASE'] in ['data', 'identity'])
    authority = 'owned' if p['XMAIL_OWNED_AUTH_PHASE'] == 'identity' else 'legacy'
    need(p['XMAIL_BROWSER_AUTH_AUTHORITY'] == p['XMAIL_USER_ADMIN_AUTHORITY'] == authority)
    for key in ['DATABASE_URL', 'DIRECT_URL']: database_url(p[key], 'xmail_runtime')
    numbers = {}
    for key in ['DB_POOL_MAX', 'DB_JOB_POOL_MAX', 'XMAIL_ADMIN_DB_POOL_MAX', 'XMAIL_DB_ROLE_CONNECTION_LIMIT', 'XMAIL_DB_CONNECTION_RESERVE', 'XMAIL_DB_PROCESS_COUNT']:
        need(re.fullmatch(r'[1-9][0-9]*', p[key]))
        numbers[key] = int(p[key])
    n = numbers
    need(n['XMAIL_DB_ROLE_CONNECTION_LIMIT'] == 20 and n['XMAIL_DB_CONNECTION_RESERVE'] >= 2
         and n['XMAIL_DB_PROCESS_COUNT'] == 1 and 1 <= n['XMAIL_ADMIN_DB_POOL_MAX'] <= 2
         and n['DB_JOB_POOL_MAX'] >= 12
         and n['DB_POOL_MAX']+n['DB_JOB_POOL_MAX']+n['XMAIL_ADMIN_DB_POOL_MAX']+n['XMAIL_DB_CONNECTION_RESERVE'] <= 20)
    need(digest(p['XMAIL_OWNED_RECEIPT_SHA256']) if p['XMAIL_OWNED_DEPLOY_MODE'] == 'promote' else p['XMAIL_OWNED_RECEIPT_SHA256'] == '')
    reader_raw = secure_read(root/'reader.env', 16384)
    reader = env_file(reader_raw, READER_KEYS)
    need(reader['NODE_ENV'] == 'production' and reader['XMAIL_STAGING_HTTP_ONLY'] == 'true'
         and reader['XMAIL_STAGING_ORIGIN'] == 'http://127.0.0.1:9001'
         and reader['XMAIL_GOOGLE_AUTH_ENABLED'] == reader['GOOGLE_AUTH_ENABLED'] == 'false')
    database_url(reader['XMAIL_STAGING_DATABASE_URL'], 'xmail_staging_reader')
    unsigned = {k: v for k, v in p.items() if k != 'XMAIL_OWNED_RECEIPT_SHA256'}
    profile_digest = sha(json.dumps(unsigned, sort_keys=True, separators=(',', ':')).encode())
    return p, reader, profile_digest, sha(raw), sha(reader_raw)

def scoped(value, kind, p, old, source, now):
    need(set(value) == COMMON and type(value['version']) is int and value['version'] == 1
         and value['app'] == 'xmail' and value['kind'] == kind and value['target'] == TARGET
         and value['database'] == 'xmail' and value['role'] == 'xmail_runtime' and value['postgresImage'] == PG_IMAGE
         and value['applicationImage'] == p['XMAIL_OWNED_APPROVED_IMAGE_ID']
         and value['sourceSha'] == p['XMAIL_OWNED_APPROVED_SOURCE_SHA'] and value['oldContainerId'] == old
         and value['authPhase'] == p['XMAIL_OWNED_AUTH_PHASE'] and value['sourceKind'] == source)
    return live_window(value, now)

def exact_facts(value, expected):
    return set(value) == set(expected) and all(type(value[k]) is type(v) and value[k] == v for k, v in expected.items())

def receipt(p, profile_digest, root=ROOT, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    raw = secure_read(root/'cutover-receipt.json')
    need(sha(raw) == p['XMAIL_OWNED_RECEIPT_SHA256'])
    r = json_file(raw)
    keys = set('version app target database role postgresImage applicationImage sourceSha authPhase sourceKind oldContainerId oldImageId profileDigest baseEnvironmentSha256 createdAt expiresAt proofs'.split())
    need(set(r) == keys and type(r['version']) is int and r['version'] == 1 and r['app'] == 'xmail'
         and r['target'] == TARGET and r['database'] == 'xmail' and r['role'] == 'xmail_runtime'
         and r['postgresImage'] == PG_IMAGE and r['applicationImage'] == p['XMAIL_OWNED_APPROVED_IMAGE_ID']
         and r['sourceSha'] == p['XMAIL_OWNED_APPROVED_SOURCE_SHA'] and digest(r['oldContainerId'])
         and image(r['oldImageId']) and r['profileDigest'] == profile_digest and digest(r['baseEnvironmentSha256'])
         and r['authPhase'] == p['XMAIL_OWNED_AUTH_PHASE'] and r['sourceKind'] in ['supabase', 'owned']
         and (r['authPhase'] != 'identity' or r['sourceKind'] == 'owned'))
    captured = live_window(r, now)
    expected_proofs = {'freeze', 'snapshot', 'controls'}
    if r['sourceKind'] == 'supabase': expected_proofs.add('final-import')
    if r['authPhase'] == 'identity': expected_proofs.add('admin-acceptance')
    need(isinstance(r['proofs'], dict) and set(r['proofs']) == expected_proofs)
    proofs, times = {}, {}
    for kind, filename in PROOF_FILES.items():
        if kind not in expected_proofs: continue
        pointer = r['proofs'][kind]
        need(isinstance(pointer, dict) and set(pointer) == {'file', 'sha256'} and pointer['file'] == filename and digest(pointer['sha256']))
        proof_raw = secure_read(root/filename)
        need(sha(proof_raw) == pointer['sha256'])
        proof = json_file(proof_raw)
        times[kind] = scoped(proof, kind, p, r['oldContainerId'], r['sourceKind'], now)
        need(isinstance(proof['facts'], dict))
        proofs[kind] = proof['facts']
    need(times['freeze'] <= times['snapshot'] <= times['controls'] <= captured)
    if 'final-import' in times: need(times['snapshot'] <= times['final-import'] <= times['controls'])
    if 'admin-acceptance' in times: need(times['controls'] <= times['admin-acceptance'] <= captured)
    need(exact_facts(proofs['freeze'], {'allSourceWritersStopped': True, 'oldContainerStopped': True}))
    snap = proofs['snapshot']
    need(set(snap) == {'sourceReadOnlySnapshotComplete', 'snapshotDigest', 'businessTables'}
         and snap['sourceReadOnlySnapshotComplete'] is True and digest(snap['snapshotDigest']) and type(snap['businessTables']) is int and snap['businessTables'] == 70)
    if 'final-import' in proofs:
        need(exact_facts(proofs['final-import'], {'snapshotReceiptSha256': r['proofs']['snapshot']['sha256'], 'restoredAndReconciled': True,
             'nativeHashesPreserved': True, 'referenceMetadataPreserved': True, 'identityTables': 4, 'businessTables': 70}))
    need(exact_facts(proofs['controls'], {'snapshotReceiptSha256': r['proofs']['snapshot']['sha256'], 'exactUuidControlsReviewed': True,
         'disabledStatePreserved': True, 'noContactAutoLinks': True, 'runtimeGrantsReviewed': True}))
    if 'admin-acceptance' in proofs:
        acceptance = proofs['admin-acceptance']
        ids = ['adminUserId', 'bindingId']
        need(set(acceptance) == set(ids+['sessionHash', 'independentLegacyProof', 'freshGoogleProof', 'ownedSessionAccepted', 'applicationAdminVerified'])
             and all(isinstance(acceptance[k], str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', acceptance[k]) for k in ids)
             and digest(acceptance['sessionHash']) and all(acceptance[k] is True for k in
                 ['independentLegacyProof', 'freshGoogleProof', 'ownedSessionAccepted', 'applicationAdminVerified']))
        r['_acceptedAdmin'] = acceptance
    base_raw = secure_read(root/'production-base.env', 32768)
    need(sha(base_raw) == r['baseEnvironmentSha256'])
    return r, env_file(base_raw, BASE_KEYS, False)

def runtime_state(p, r, base, admitted=None):
    old = inspect(r['oldContainerId'])
    need(old['Id'] == r['oldContainerId'] and old['Image'] == r['oldImageId'] and old['State']['Running'] is False
         and old['State'].get('Pid', 0) == 0 and old['Name'] in ['/xmail', '/xmail-frozen-'+r['oldContainerId'][:12]])
    old_env = container_env(old)
    need({k: v for k, v in old_env.items() if k in BASE_KEYS} == base)
    if r['sourceKind'] == 'owned':
        for key in ['DATABASE_URL', 'DIRECT_URL']: database_url(old_env.get(key, ''), 'xmail_runtime')
    else:
        need(old_env.get('SUPABASE_URL', '').rstrip('/') == 'https://zzbudkfkcmqkavgwselc.supabase.co')
        source_database_url(old_env.get('DATABASE_URL', ''))
        source_database_url(old_env.get('DIRECT_URL') or old_env.get('DATABASE_URL', ''))
    if p['XMAIL_OWNED_AUTH_PHASE'] == 'data':
        need(old_env.get('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy') == old_env.get('XMAIL_USER_ADMIN_AUTHORITY', 'legacy') == 'legacy')
    pg = inspect(TARGET)
    pgdata = [m for m in pg.get('Mounts', []) if m.get('Destination') == '/var/lib/postgresql/data']
    need(pg['Image'] == PG_IMAGE and pg['State']['Running'] is True and pg['State'].get('Health', {}).get('Status') == 'healthy'
         and not any((pg['NetworkSettings'].get('Ports') or {}).values())
         and len(pgdata) == 1 and pgdata[0].get('Type') == 'volume' and pgdata[0].get('RW') is True
         and pgdata[0].get('Name') == 'postgres-data-e12scyfsrp822dag7m9wwd4x')
    ids = docker(['ps', '-q']).decode().split()
    need(len(ids) <= 1000)
    for identifier in ids:
        live = inspect(identifier)
        if admitted and live['Id'] == admitted: continue
        env = container_env(live)
        labels = live['Config'].get('Labels') or {}
        writer = live['Name'] in ['/xmail', '/xmail-next', '/skaleclub-mail'] or live['Image'] in [r['oldImageId'], r['applicationImage']] or labels.get('com.skale.xmail.runtime') == 'owned-full'
        for key in ['DATABASE_URL', 'DIRECT_URL']:
            try:
                u = urlsplit(env.get(key, ''))
                writer = writer or u.hostname == TARGET and unquote(u.username or '') == 'xmail_runtime'
            except Exception: pass
        need(not writer)
    return old

def verify_linked_admin(r):
    a = r['_acceptedAdmin']
    # UUID/hash fields were strictly validated above. Sensitive hashes stay on
    # stdin; no email, contact matching, raw session token or SQL value is logged.
    query = """BEGIN READ ONLY; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic';
    SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='500ms';
    SELECT EXISTS(SELECT 1 FROM public.users u
      JOIN public.xmail_identity_user_controls c ON c.user_id=u.id
      JOIN public.xmail_identity_bindings b ON b.user_id=u.id
      JOIN public.xmail_identity_owned_sessions s ON s.binding_id=b.id
      WHERE u.id='%s'::uuid AND u.is_admin AND c.disabled_at IS NULL
      AND b.id='%s'::uuid AND b.project_id='skaleclub' AND b.disabled_at IS NULL
      AND b.proof_reference='legacy-session:'||u.id::text
      AND s.token_hash='%s' AND s.revoked_at IS NULL AND s.expires_at>transaction_timestamp()
      AND s.authenticated_at>=extract(epoch FROM transaction_timestamp())-300
      AND s.authenticated_at<=extract(epoch FROM transaction_timestamp())+5
      AND c.sessions_valid_after<=to_timestamp(s.authenticated_at)); ROLLBACK;""" % (a['adminUserId'], a['bindingId'], a['sessionHash'])
    result = docker(['exec', '-i', TARGET, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'xmail_owner', '-d', 'xmail'], query.encode())
    need(result.strip() == b't')

def execute(action, root=ROOT, admitted=None):
    p, reader, profile_digest, raw_sha, reader_sha = profiles(root)
    img = inspect(p['XMAIL_OWNED_APPROVED_IMAGE_ID'])
    need(img['Id'] == p['XMAIL_OWNED_APPROVED_IMAGE_ID']
         and (img['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') == p['XMAIL_OWNED_APPROVED_SOURCE_SHA'])
    if action == 'preview-readback':
        need(digest(admitted))
        stage = inspect(admitted)
        env = container_env(stage)
        need(stage['Image'] == p['XMAIL_OWNED_APPROVED_IMAGE_ID'] and stage['State']['Running'] is True
             and stage['Name'] == '/xmail-owned-preview' and all(env.get(k) == v for k, v in reader.items())
             and not any((stage['NetworkSettings'].get('Ports') or {}).values())
             and not any(env.get(k) for k in (BASE_KEYS-{'NODE_ENV', 'PORT'}))
             and not env.get('DATABASE_URL') and not env.get('DIRECT_URL')
             and not any(k.startswith(('GOOGLE_AUTH_', 'XMAIL_GOOGLE_AUTH_')) and k not in ['GOOGLE_AUTH_ENABLED', 'XMAIL_GOOGLE_AUTH_ENABLED'] for k in env)
             and stage['HostConfig']['ReadonlyRootfs'] is True
             and stage['Config'].get('Entrypoint') == ['node'] and stage['Config'].get('Cmd') == ['dist/server/index.js']
             and (stage['Config'].get('Labels') or {}).get('com.skale.xmail.runtime') == 'isolated-preview'
             and all(m.get('Type') == 'tmpfs' and m.get('Destination') == '/tmp' for m in stage.get('Mounts', [])))
        networks = stage['NetworkSettings'].get('Networks') or {}
        need(list(networks) == ['xmail-owned-preview'])
        network = json.loads(docker(['network', 'inspect', networks['xmail-owned-preview']['NetworkID']]))[0]
        need(network['Internal'] is True and (network.get('Labels') or {}).get('com.skale.xmail.runtime') == 'isolated-preview'
             and set(network['Containers']) == {admitted, inspect(TARGET)['Id']})
        print('isolated-preview-readback-ok')
        return
    old_id = '-'
    if p['XMAIL_OWNED_DEPLOY_MODE'] == 'promote':
        r, base = receipt(p, profile_digest, root)
        old = runtime_state(p, r, base, admitted)
        google_path = Path('/opt/xmail/google-identity-ops')
        secure_directory(google_path, True)
        google = env_file(secure_read(google_path/'google-auth.env', 16384),
             set('XMAIL_GOOGLE_AUTH_ENABLED XMAIL_GOOGLE_AUTH_PROJECT_ID XMAIL_GOOGLE_AUTH_PROJECT_NUMBER XMAIL_GOOGLE_AUTH_WEB_API_KEY XMAIL_GOOGLE_AUTH_ADC_FILE XMAIL_GOOGLE_AUTH_ADC_AUDIENCE XMAIL_GOOGLE_AUTH_ADC_SERVICE_ACCOUNT XMAIL_GOOGLE_AUTH_ADC_SUBJECT'.split()))
        expected_google = 'true' if r['authPhase'] == 'identity' else 'false' if r['sourceKind'] == 'supabase' else None
        need(google['XMAIL_GOOGLE_AUTH_ENABLED'] in ['true', 'false']
             and (expected_google is None or google['XMAIL_GOOGLE_AUTH_ENABLED'] == expected_google))
        if r['authPhase'] == 'identity': verify_linked_admin(r)
        old_id = r['oldContainerId']
        if action == 'readback':
            need(digest(admitted))
            live = inspect(admitted)
            env = container_env(live)
            need(live['Name'] == '/xmail' and live['Image'] == r['applicationImage'] and live['State']['Running'] is True
                 and live['State'].get('Health', {}).get('Status') == 'healthy'
                 and (live['Config'].get('Labels') or {}).get('com.skale.xmail.runtime') == 'owned-full'
                 and all(env.get(k) == v for k, v in {**base, **p, **google}.items())
                 and live['HostConfig'].get('PortBindings') == old['HostConfig'].get('PortBindings'))
            mounts = [m for m in live.get('Mounts', []) if m.get('Destination') == '/run/secrets/xmail-google-identity']
            need(len(mounts) == 1 and mounts[0].get('Source') == '/opt/xmail/google-identity-runtime' and mounts[0].get('RW') is False)
    else: need(action == 'inspect')
    need(action in ['inspect', 'assert-promote', 'readback'])
    print(' '.join([p['XMAIL_OWNED_DEPLOY_MODE'], p['XMAIL_OWNED_APPROVED_IMAGE_ID'], p['XMAIL_OWNED_APPROVED_SOURCE_SHA'], raw_sha, reader_sha, old_id]))

if __name__ == '__main__':
    try: execute(sys.argv[1], admitted=sys.argv[2] if len(sys.argv) == 3 else None)
    except Exception:
        print('Owned deployment policy refused; private diagnostics suppressed.', file=sys.stderr)
        sys.exit(1)
XMAIL_OWNED_POLICY_PY
}

prepare_owned_runtime_profile() {
  local response
  OWNED_MODE="legacy"
  if [ ! -e "$OWNED_RUNTIME_ENV_FILE" ] && [ ! -L "$OWNED_RUNTIME_ENV_FILE" ]; then return 0; fi
  response=$(owned_policy inspect) || return 1
  read -r OWNED_MODE OWNED_IMAGE_ID OWNED_SOURCE_SHA OWNED_PROFILE_SHA OWNED_READER_SHA OWNED_OLD_ID <<< "$response"
  [ "$OWNED_SOURCE_SHA" = "${GITHUB_SOURCE_SHA}" ] || return 1
}
# END XMAIL OWNED POLICY


run_app_container() {
  NAME="$1"
  IMAGE="$2"
  PUBLISH_PORTS="$3"

  prepare_google_runtime_binding || return 1

  PUBLISH_ARGS=""
  if [ "$PUBLISH_PORTS" = "true" ]; then
    # 9001 is bound to loopback only. Traefik reaches the container over the
    # 'coolify' Docker network at http://xmail:9001 (see write_traefik_route),
    # and wait_for_container_health probes it via `docker exec` from inside the
    # container's own netns — neither needs the host-published mapping. Publishing
    # 9001 on 0.0.0.0 would let a request reach Express directly, bypassing
    # Traefik: the app trusts X-Forwarded-For (`trust proxy`) for the 100
    # req/IP/15min rate limiter, so a client hitting the public port straight
    # could spoof that header and dodge the limiter entirely. 25/587/993 stay
    # public — they are raw TCP with no proxy in front and no header-based trust
    # to spoof.
    PUBLISH_ARGS="-p 127.0.0.1:9001:9001 -p 25:25 -p 587:587 -p 993:993"
  fi
  TRAEFIK_ENABLED="true"
  if [ "$NAME" != "$APP_NAME" ]; then
    TRAEFIK_ENABLED="false"
  fi

  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    $NETWORK_FLAG \
    $PUBLISH_ARGS \
    -v /etc/letsencrypt:/etc/letsencrypt:ro \
    $GOOGLE_RUNTIME_ARGS \
    -e NODE_ENV=production \
    -e PORT=9001 \
    -e DEPLOY_VERSION="$DEPLOY_VERSION" \
    -e DEPLOYED_AT="$DEPLOYED_AT" \
    -e SUPABASE_URL="$SUPABASE_URL" \
    -e SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
    -e SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
    -e DATABASE_URL="$DATABASE_URL" \
    -e DIRECT_URL="$DIRECT_URL" \
    -e JWT_SECRET="$JWT_SECRET" \
    -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
    -e OUTLOOK_TOKEN_ENCRYPTION_KEY="$OUTLOOK_TOKEN_ENCRYPTION_KEY" \
    -e MAIL_DOMAIN="$MAIL_DOMAIN" \
    -e OUTREACH_PROTECTED_DOMAINS="xkedule.com,xphere.app,endenemy.com,xareable.com,stuscle.com,xtimator.com,skleanings.com,fluenverse.com,brasilshowdown.com" \
    -e OUTREACH_HOME_BASE_ZIP="01702" \
    -e OUTREACH_HOME_RADIUS_MILES="30" \
    -e MAIL_HOST="mx.skale.club" \
    -e MAIL_TLS_CERT_PATH="/etc/letsencrypt/live/mx.skale.club/fullchain.pem" \
    -e MAIL_TLS_KEY_PATH="/etc/letsencrypt/live/mx.skale.club/privkey.pem" \
    -e APP_COMPANY_NAME="$APP_COMPANY_NAME" \
    -e APP_APPLICATION_NAME="$APP_APPLICATION_NAME" \
    -e SMTP_PASS="$SMTP_PASS" \
    -e SMTP_FROM="$SMTP_FROM" \
    -e FRONTEND_URL="$FRONTEND_URL" \
    -e SMTP_SUBMISSION_PORT=587 \
    -e MX_PORT=25 \
    -e IMAP_PORT=993 \
    -e ENABLE_MAIL_SERVER=true \
    -e XMAIL_SERVICE_KEY="$XMAIL_SERVICE_KEY" \
    -e XMAIL_SERVICE_USER_ID="$XMAIL_SERVICE_USER_ID" \
    -e XMAIL_SERVICE_ORGANIZATION_ID="$XMAIL_SERVICE_ORGANIZATION_ID" \
    -e XPHERE_EVENTS_URL="$XPHERE_EVENTS_URL" \
    -e XPHERE_EVENTS_API_KEY="$XPHERE_EVENTS_API_KEY" \
    -e APOLLO_API_KEY="$APOLLO_API_KEY" \
    -e XCRAPER_SERVICE_URL="$XCRAPER_SERVICE_URL" \
    -e XCRAPER_SERVICE_KEY="$XCRAPER_SERVICE_KEY" \
    -e PROSPECTING_DAILY_BUDGET_USD="$PROSPECTING_DAILY_BUDGET_USD" \
    -e R2_ACCOUNT_ID="$R2_ACCOUNT_ID" \
    -e R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e R2_PUBLIC_BASE_URL="$R2_PUBLIC_BASE_URL" \
    -e MONITOR_API_TOKEN="$MONITOR_API_TOKEN" \
    -e TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
    -e TELEGRAM_CHAT_ID="$TELEGRAM_CHAT_ID" \
    -e DB_LIVENESS_INTERVAL_MS="${DB_LIVENESS_INTERVAL_MS}" \
    -e DB_LIVENESS_PROBE_TIMEOUT_MS="${DB_LIVENESS_PROBE_TIMEOUT_MS}" \
    -e DB_LIVENESS_EXIT_AFTER_MS="${DB_LIVENESS_EXIT_AFTER_MS}" \
    --label "traefik.enable=${TRAEFIK_ENABLED}" \
    --label "traefik.docker.network=coolify" \
    --label "traefik.http.routers.${NAME}.rule=Host(\`mail.skale.club\`)" \
    --label "traefik.http.routers.${NAME}.entrypoints=https" \
    --label "traefik.http.routers.${NAME}.tls=true" \
    --label "traefik.http.routers.${NAME}.tls.certresolver=letsencrypt" \
    --label "traefik.http.services.${NAME}.loadbalancer.server.port=9001" \
    "$IMAGE"
}

# Gates the blue/green handoff: only a container that passes this is allowed to
# take (or keep) traffic. /health is liveness only — "the Express process is up
# and answering" — which is true long before the app can actually serve a
# request correctly (DB pool not yet connected, Supabase Auth unreachable). Using
# only /health here previously meant a candidate could get promoted with a dead
# database behind it. /health/ready (src/server/lib/health.ts) runs the real
# checks (`select 1` through the pool, a Supabase Auth probe) and returns 503 if
# either fails, so it is the one that actually gates promotion. /health is kept
# as a first, cheap check so a container that isn't even listening yet fails fast
# with a clearer signal than a slower /health/ready timeout would give.
wait_for_container_health() {
  NAME="$1"
  for i in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
    sleep "$HEALTH_CHECK_INTERVAL"
    if ! docker ps --filter "name=^/${NAME}$" --filter "status=running" -q | grep -q .; then
      echo "Container $NAME is not running"
      docker logs "$NAME" --tail 80 2>&1 || true
      return 1
    fi
    if ! docker exec "$NAME" node -e "fetch('http://127.0.0.1:9001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
      echo "$NAME health attempt $i/$HEALTH_CHECK_RETRIES failed (liveness)"
      continue
    fi
    if docker exec "$NAME" node -e "fetch('http://127.0.0.1:9001/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
      echo "$NAME passed health check on attempt $i (liveness + ready)"
      return 0
    fi
    echo "$NAME health attempt $i/$HEALTH_CHECK_RETRIES failed (not ready — DB/auth)"
  done
  docker logs "$NAME" --tail 100 2>&1 || true
  return 1
}

write_traefik_route() {
  TARGET_NAME="$1"
  if [ "$USING_COOLIFY" != "true" ]; then
    return 0
  fi
  if [ ! -d "$(dirname "$TRAEFIK_DYN")" ]; then
    echo "Traefik dynamic directory not found, relying on Docker labels"
    return 0
  fi
  rm -f "$LEGACY_TRAFIK_DYN"
  printf '%s\n' \
    'http:' \
    '  routers:' \
    '    xmail-https:' \
    '      rule: "Host(`mail.skale.club`)"' \
    '      service: xmail-svc' \
    '      entryPoints:' \
    '        - https' \
    '      tls:' \
    '        certResolver: letsencrypt' \
    '    xmail-http:' \
    '      rule: "Host(`mail.skale.club`)"' \
    '      service: xmail-svc' \
    '      entryPoints:' \
    '        - http' \
    '      middlewares:' \
    '        - redirect-to-https' \
    '  middlewares:' \
    '    redirect-to-https:' \
    '      redirectScheme:' \
    '        scheme: https' \
    '        permanent: true' \
    '  services:' \
    '    xmail-svc:' \
    '      loadBalancer:' \
    '        servers:' \
    "          - url: \"http://${TARGET_NAME}:9001\"" \
    '        passHostHeader: true' \
    > "$TRAEFIK_DYN"
  echo "Traefik route now points to ${TARGET_NAME}"
}

cleanup_container() {
  NAME="$1"
  if docker ps -a --filter "name=^/${NAME}$" --format "{{.ID}}" | grep -q .; then
    # `docker stop` sends SIGTERM first (falling back to SIGKILL only after the
    # timeout), so src/server/index.ts's SIGTERM handler — closing the mail
    # servers and the DB pool before exit — actually gets to run. A bare
    # `docker rm -f` sends SIGKILL immediately and skips that entirely: in-flight
    # SMTP/IMAP connections get dropped mid-command instead of finished, and
    # pooled DB connections aren't returned cleanly. 20s comfortably covers the
    # shutdown path without stalling the rollout if a container is already wedged.
    docker stop -t 20 "$NAME" || true
    docker rm -f "$NAME" || true
  fi
}

rollback_to_previous() {
  echo "Rolling back to previous image"
  cleanup_container "$APP_NAME"
  if docker images "${APP_NAME}:previous" --format "{{.ID}}" | grep -q .; then
    run_app_container "$APP_NAME" "${APP_NAME}:previous" true
    wait_for_container_health "$APP_NAME"
    write_traefik_route "$APP_NAME"
    cleanup_container "$NEXT_NAME"
  elif docker images "${APP_NAME}:latest" --format "{{.ID}}" | grep -q .; then
    # No ":previous" to fall back to — this only happens when the host never had
    # an earlier ":latest" to preserve (first-ever deploy, or ":previous" was
    # otherwise lost). cleanup_container above already removed the running
    # "$APP_NAME" container, so doing nothing here leaves production with zero
    # containers instead of a degraded one. ":latest" is the same image that just
    # failed its health check, so this is not a fix — but a container that is
    # merely unhealthy can still be inspected (`docker logs`, `docker exec`) and
    # may recover from a transient failure, which is strictly better than nothing
    # answering on 25/587/993/9001 at all.
    echo "::warning::No ${APP_NAME}:previous image to roll back to. Last resort: re-running ${APP_NAME}:latest (the image that just failed its health check) so the host is not left with no container at all."
    run_app_container "$APP_NAME" "${APP_NAME}:latest" true
    wait_for_container_health "$APP_NAME" || echo "::warning::${APP_NAME} restarted on :latest but is still failing its health check — needs a human to look at docker logs ${APP_NAME}."
    write_traefik_route "$APP_NAME"
    cleanup_container "$NEXT_NAME"
  else
    echo "::error::No ${APP_NAME}:previous AND no ${APP_NAME}:latest image on this host — cannot even attempt a restart. Production is down; a manual docker run or redeploy is required."
  fi
}

# Owned previews never execute production-server, jobs or native listeners.
run_owned_preview() (
  set -euo pipefail
  local stage_id="" network_id="" attached=false
  cleanup_owned_preview() {
    local failed=0
    if [ -n "$stage_id" ]; then docker rm -f "$stage_id" >/dev/null 2>&1 || failed=1; fi
    if [ "$attached" = true ]; then docker network disconnect "$network_id" e12scyfsrp822dag7m9wwd4x >/dev/null 2>&1 || failed=1; fi
    if [ -n "$network_id" ]; then docker network rm "$network_id" >/dev/null 2>&1 || failed=1; fi
    return "$failed"
  }
  trap 'status=$?; cleanup_owned_preview || status=1; exit "$status"' EXIT
  network_id=$(docker network create --internal --label com.skale.xmail.runtime=isolated-preview xmail-owned-preview) || exit 1
  docker network connect --alias e12scyfsrp822dag7m9wwd4x "$network_id" e12scyfsrp822dag7m9wwd4x || exit 1
  attached=true
  stage_id=$(docker run -d --name xmail-owned-preview --restart no \
    --network "$network_id" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --memory-swap 128m --cpus 0.25 --pids-limit 64 \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m --no-healthcheck \
    --label com.skale.xmail.runtime=isolated-preview \
    --env-file "$OWNED_READER_ENV_FILE" --entrypoint node "$OWNED_IMAGE_ID" dist/server/index.js) || exit 1
  owned_policy preview-readback "$stage_id" >/dev/null || exit 1
  for attempt in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
    sleep "$HEALTH_CHECK_INTERVAL"
    if docker exec -i "$stage_id" node <<'XMAIL_OWNED_PREVIEW_JS'
(async()=>{
  const get=async path=>{const r=await fetch('http://127.0.0.1:9001'+path,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error();return r.json()};
  const health=await get('/health');if(health.mode!=='staging-http-only'||health.sideEffectsEnabled!==false)throw Error();
  const ready=await get('/health/ready');
  if(!ready.summary||!['users','organization_users','platform_admins','native_password_hashes'].every(k=>Number.isInteger(ready.summary[k])&&ready.summary[k]>=0))throw Error();
})().catch(()=>{process.exitCode=1});
XMAIL_OWNED_PREVIEW_JS
    then
      owned_policy preview-readback "$stage_id" >/dev/null || exit 1
      echo '{"ownedPreviewReady":true,"readOnly":true,"publishedPorts":false,"productionStarted":false}'
      exit 0
    fi
  done
  echo '::error::Isolated owned preview failed; private diagnostics suppressed.' >&2
  exit 1
)

run_owned_deploy() {
  local before response frozen_name new_id="" lock_file="${OWNED_RUNTIME_OPS_DIR}/deploy.lock"
  if [ -e "$lock_file" ] || [ -L "$lock_file" ]; then
    [ -f "$lock_file" ] && [ ! -L "$lock_file" ] \
      && [ "$(stat -c '%u:%g:%a:%h:%s' -- "$lock_file")" = '0:0:600:1:0' ] || return 1
  fi
  umask 077
  exec 9>"$lock_file" || return 1
  flock -n 9 || return 1
  before="$OWNED_MODE $OWNED_IMAGE_ID $OWNED_SOURCE_SHA $OWNED_PROFILE_SHA $OWNED_READER_SHA $OWNED_OLD_ID"
  run_owned_preview || return 1
  response=$(owned_policy inspect) || return 1
  [ "$response" = "$before" ] || return 1
  if [ "$OWNED_MODE" = preview ]; then
    echo '{"ownedPreviewOnly":true,"applicationCutover":false}'
    return 0
  fi
  [ "$USING_COOLIFY" = true ] || return 1
  response=$(owned_policy assert-promote) || return 1
  [ "$response" = "$before" ] || return 1
  prepare_google_runtime_binding || return 1
  [ -n "$GOOGLE_RUNTIME_ARGS" ] || return 1
  frozen_name="xmail-frozen-${OWNED_OLD_ID:0:12}"
  if [ "$(docker inspect --format '{{.Name}}' "$OWNED_OLD_ID")" = /xmail ]; then
    docker rename "$OWNED_OLD_ID" "$frozen_name" || return 1
  fi
  # The consumer just proved all other full writers stopped. The stopped
  # old container is retained by immutable ID; no legacy rollback is called.
  response=$(owned_policy assert-promote) || return 1
  [ "$response" = "$before" ] || return 1
  new_id=$(docker run -d --name xmail --restart unless-stopped --network coolify \
    -p 127.0.0.1:9001:9001 -p 25:25 -p 587:587 -p 993:993 \
    --mount type=bind,source=/etc/letsencrypt,target=/etc/letsencrypt,readonly \
    --env-file "$OWNED_BASE_ENV_FILE" $GOOGLE_RUNTIME_ARGS --env-file "$OWNED_RUNTIME_ENV_FILE" \
    -e DEPLOY_VERSION="$DEPLOY_VERSION" -e DEPLOYED_AT="$DEPLOYED_AT" \
    --label com.skale.xmail.runtime=owned-full --label traefik.enable=false "$OWNED_IMAGE_ID") || return 1
  for attempt in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
    sleep "$HEALTH_CHECK_INTERVAL"
    if docker exec "$new_id" node -e "fetch('http://127.0.0.1:9001/health/ready',{signal:AbortSignal.timeout(12000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      if owned_policy readback "$new_id" >/dev/null; then
        write_traefik_route xmail
        echo '{"ownedRuntimeReady":true,"singleFullWriter":true,"legacyRollback":false}'
        return 0
      fi
    fi
  done
  # An ambiguous/failed promotion stays on the owned database. Never resume
  # the frozen Supabase writer or an image predating owned authority controls.
  docker stop -t 20 "$new_id" >/dev/null 2>&1 || true
  echo '::error::Owned promotion failed closed; frozen legacy writer remains stopped.' >&2
  return 1
}


echo "::group::Deploy"
prepare_owned_runtime_profile || exit 1
if [ "$OWNED_MODE" != legacy ]; then
  run_owned_deploy
  exit $?
fi
if [ "$USING_COOLIFY" = "true" ]; then
  cleanup_container "$NEXT_NAME"

  echo "Starting green HTTP candidate: $NEXT_NAME"
  run_app_container "$NEXT_NAME" "${APP_NAME}:latest" false
  wait_for_container_health "$NEXT_NAME"
  write_traefik_route "$NEXT_NAME"
  sleep 3

  echo "Replacing host-published mail/web container: $APP_NAME"
  cleanup_container "$LEGACY_IMAGE_NAME"
  cleanup_container "$APP_NAME"

  if ! run_app_container "$APP_NAME" "${APP_NAME}:latest" true; then
    rollback_to_previous
    exit 1
  fi
  if ! wait_for_container_health "$APP_NAME"; then
    rollback_to_previous
    exit 1
  fi

  write_traefik_route "$APP_NAME"
  sleep 3
  cleanup_container "$NEXT_NAME"
else
  echo "Coolify network not found, using restart deploy"
  cleanup_container "$LEGACY_IMAGE_NAME"
  cleanup_container "$APP_NAME"
  run_app_container "$APP_NAME" "${APP_NAME}:latest" true
  wait_for_container_health "$APP_NAME"
fi
echo "::endgroup::"

echo "::group::Cleanup"
docker images "$APP_NAME" --format '{{.Tag}}' \
  | grep -v -E '^(latest|previous)$' \
  | xargs -r -I{} docker rmi "$APP_NAME":{} || true
docker image prune -f
docker builder prune -f --keep-storage=500MB || true
echo "::endgroup::"

echo "DEPLOYED version $DEPLOY_VERSION at $DEPLOYED_AT"
