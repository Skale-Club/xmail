# Phase 13 — MX Hardening + Port 25 Unblock

## Goal
Port 25 is publicly reachable, the MX receiver survives real-world internet traffic (spam + abuse) without degrading service for legitimate mail.

## Current state
- `src/server/mx-server.ts` accepts TCP on port 25 (or 2525 in dev), rejects RCPT TO for non-local/non-routed recipients
- Basic size cap (`size: 25MB`) set
- No rate-limit, no DNSBL, no greylisting

## Hetzner default policy
Hetzner blocks outbound port 25 on new accounts to prevent spam. Inbound port 25 is also blocked unless requested via support.

**Action:** Open ticket at `accounts@hetzner.com` or cloud console → Support, request port 25 unblock. Usually approved within 24-48h for legitimate use cases. Mention:
- Project: transactional/business email for `skale.club`
- SPF/DKIM/DMARC configured (reference Phase 11 + 12 completion)
- Abuse policy: rate-limit, DNSBL, greylisting in place

## Hardening layers

### Layer 1: Connection rate-limit
Per-IP limit on connections/minute; reject at `onConnect`:
```ts
const connectsByIp = new Map<string, { count: number; windowStart: number }>()
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 10

onConnect(session, callback) {
    const ip = session.remoteAddress || 'unknown'
    const now = Date.now()
    const entry = connectsByIp.get(ip)
    if (!entry || now - entry.windowStart > WINDOW_MS) {
        connectsByIp.set(ip, { count: 1, windowStart: now })
    } else if (entry.count >= MAX_PER_WINDOW) {
        return callback(new Error('421 4.7.0 Too many connections from this IP'))
    } else {
        entry.count += 1
    }
    callback()
}
```

### Layer 2: DNSBL (Spamhaus / SORBS)
Lookup `<reversed-ip>.zen.spamhaus.org` — if A record exists, IP is listed:
```ts
import { promises as dns } from 'dns'

async function isBlacklisted(ip: string): Promise<boolean> {
    if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return false
    const reversed = ip.split('.').reverse().join('.')
    try {
        await dns.resolve4(`${reversed}.zen.spamhaus.org`)
        return true
    } catch {
        return false
    }
}
```

Call in `onConnect` after rate-limit.

### Layer 3: Greylisting
First contact from (IP, from, to) triple is rejected with `451 4.7.1`. Store triple + timestamp. Second contact after ≥5min accepted. Legit MTAs retry; most spam bots don't.

Storage: either in-memory Map (reset on restart — fine for small scale) or a `greylist` table in Supabase.

```ts
// greylist.ts
const entries = new Map<string, number>()
const HOLD_MS = 5 * 60 * 1000
const TTL_MS = 24 * 60 * 60 * 1000

export function shouldGreylist(ip: string, from: string, to: string): boolean {
    const key = `${ip}|${from}|${to}`
    const first = entries.get(key)
    const now = Date.now()
    if (!first) {
        entries.set(key, now)
        return true
    }
    if (now - first < HOLD_MS) return true
    return false
}

setInterval(() => {
    const now = Date.now()
    for (const [k, t] of entries) if (now - t > TTL_MS) entries.delete(k)
}, 60 * 60 * 1000).unref()
```

Call in `onRcptTo`:
```ts
if (shouldGreylist(session.remoteAddress, session.envelope.mailFrom.address, address.address)) {
    return callback(new Error('451 4.7.1 Greylisted; please retry'))
}
```

### Layer 4: Header / content checks
- Max 50 recipients per session: `new SMTPServer({ maxRecipients: 50, ... })`
- Reject if `From:` header missing
- Reject if message has no `Date:` header or `Date:` >30 days old
- Reject if `Content-Type:` malformed

### Layer 5: Sender reputation
Optional: keep rolling count of (sender-IP, accepts, rejects) in DB. Auto-throttle high-rejection senders.

## Not in scope
- Full Bayesian spam classifier (SpamAssassin / rspamd) — hand off to 3rd-party if needed
- DMARC reporting aggregation (consume `rua=` mail)
- MTA-STS enforcement for outbound (policy-based TLS) — nice-to-have for Phase 14
