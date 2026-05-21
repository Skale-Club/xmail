# Phase 12 — DKIM Signing (Outbound) + Mail-Auth (Inbound)

## Goal
Outbound mail is DKIM-signed using the per-domain private key from the DB. Inbound mail on port 25 is verified for SPF/DKIM/DMARC; failed-DMARC emails are rejected or quarantined per domain policy.

## What already exists
- `src/db/schema.ts domains` table has `dkim_private_key`, `dkim_public_key`, `dkim_selector` (default: `skaleclub`), `dkim_status`
- `src/server/routes/domains.ts` has DNS verification endpoint — checks whether a DKIM TXT record is published at `<selector>._domainkey.<domain>`
- `nodemailer` is already a dependency and supports DKIM signing via `createTransport({ dkim: {...} })` option
- `src/server/lib/outreach-sender.ts` sends outbound via nodemailer; `src/server/smtp-server.ts relayMessage()` also uses nodemailer for relay
- `src/server/mx-server.ts` parses inbound via `parseRawEmail` but does NOT call any verification library

## What's missing
1. **Outbound:** no code fetches `dkim_private_key` from DB and passes to nodemailer. The private key sits unused.
2. **Inbound:** no SPF/DKIM/DMARC verification on MX arrivals; spoofers accepted blindly.

## Approach

### Outbound DKIM signing
Helper `src/server/lib/dkim.ts`:
```ts
import { db } from '../../db'
import { domains } from '../../db/schema'
import { eq } from 'drizzle-orm'

interface DkimConfig { domainName: string; keySelector: string; privateKey: string }

const cache = new Map<string, DkimConfig>()

export async function getDkimConfigForEmail(fromEmail: string): Promise<DkimConfig | null> {
    const host = fromEmail.split('@')[1]?.toLowerCase()
    if (!host) return null
    if (cache.has(host)) return cache.get(host)!

    const row = await db.query.domains.findFirst({
        where: eq(domains.name, host),
        columns: { name: true, dkimSelector: true, dkimPrivateKey: true },
    })
    if (!row?.dkimPrivateKey) return null

    const cfg = {
        domainName: row.name,
        keySelector: row.dkimSelector || 'skaleclub',
        privateKey: row.dkimPrivateKey,
    }
    cache.set(host, cfg)
    return cfg
}

export function invalidateDkimCache(host: string) { cache.delete(host.toLowerCase()) }
```

Then in `smtp-server.ts relayMessage` and `outreach-sender.ts`:
```ts
const dkim = await getDkimConfigForEmail(fromAddress)
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
    dkim: dkim ? {
        domainName: dkim.domainName,
        keySelector: dkim.keySelector,
        privateKey: dkim.privateKey,
    } : undefined,
})
```

When the admin rotates the DKIM key (future feature), call `invalidateDkimCache(host)`.

### Inbound verification (mailauth)
`npm install mailauth` — RFC-compliant SPF/DKIM/DMARC/ARC/BIMI check in a single call.

In `mx-server.ts onData`:
```ts
import { authenticate as mailAuth } from 'mailauth'

// after collecting `raw` buffer
const authResult = await mailAuth(raw, {
    ip: session.remoteAddress,
    helo: session.hostNameAppearsAs,
    mta: process.env.MAIL_HOST,
    sender: session.envelope.mailFrom?.address,
})

// authResult.spf.status, .dkim.results, .dmarc.status, .arc.status

const dmarcAction = authResult.dmarc?.policy || 'none'
const dmarcPass = authResult.dmarc?.status?.result === 'pass'

if (!dmarcPass && dmarcAction === 'reject') {
    return callback(new Error('550 5.7.1 DMARC policy violation'))
}

// Prepend Authentication-Results header; mailauth provides the formatted string
const authHeader = authResult.headers  // formatted Authentication-Results header
const sealed = Buffer.concat([Buffer.from(authHeader + '\r\n'), raw])

// Store `sealed` instead of `raw`; mark is_spam=true if !dmarcPass && dmarcAction === 'quarantine'
```

### Deliverability testing
- `check-auth@verifier.port25.com` — echo service that returns SPF/DKIM/DMARC pass/fail
- `mail-tester.com` — score out of 10; aim for ≥9
- Real Gmail/Outlook accounts — send test, inspect headers

## Dependencies
- **Phase 11 MUST be complete** — DKIM public key must be published in DNS before signing has any effect

## Out of scope
- ARC sealing (forwarding mail while preserving auth) — nice-to-have; mailauth supports it but we don't forward
- Key rotation UI — current flow: admin updates `dkim_private_key` in DB + republishes DNS; invalidate cache manually
- BIMI (brand logos in Gmail) — deferred
