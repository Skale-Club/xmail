/**
 * Provision an organization + domain, generating the DKIM keypair.
 *
 * The app has no DKIM key generation anywhere — `domains.dkim_private_key` is only ever
 * READ (src/server/lib/dkim.ts) and `POST /api/domains` inserts the row without one. Every
 * domain in production got its key inserted by hand. This script closes that gap so adding
 * a sending domain is one reproducible command instead of a manual keygen.
 *
 * Idempotent: reuses an existing org (matched by slug) and an existing domain row (matched
 * by org + name), and never regenerates a keypair that already exists — rotating a live key
 * would break DKIM until DNS propagates, so that has to be a deliberate, separate action.
 *
 * Usage:
 *   npx tsx scripts/add-domain.ts --org "Grupo Rodobens" --slug grupo-rodobens \
 *                                 --domain gruporodobens.com.br
 *
 * Prints the exact DNS records to publish at the registrar. Nothing is verified here —
 * run POST /api/domains/:id/verify (or the admin UI) once DNS has propagated.
 */

import 'dotenv/config'
import { generateKeyPairSync } from 'node:crypto'
import postgres from 'postgres'

interface Args {
    org: string
    slug: string
    domain: string
    selector: string
    mailHost: string
}

function parseArgs(): Args {
    const argv = process.argv.slice(2)
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(`--${flag}`)
        return i >= 0 ? argv[i + 1] : undefined
    }

    const org = get('org')
    const slug = get('slug')
    const domain = get('domain')?.toLowerCase().trim()

    if (!org || !slug || !domain) {
        console.error('Usage: npx tsx scripts/add-domain.ts --org "Name" --slug the-slug --domain example.com [--selector skaleclub]')
        process.exit(1)
    }

    // The local .env carries the dev value MAIL_HOST=localhost, which would silently print
    // "MX 10 localhost." into a checklist meant for a registrar. Only trust MAIL_HOST when it
    // actually looks like a public host; otherwise use the production MX.
    const envMailHost = process.env.MAIL_HOST
    const mailHost = get('mail-host')
        || (envMailHost && envMailHost.includes('.') && envMailHost !== 'localhost' ? envMailHost : 'mx.skale.club')

    return { org, slug, domain, selector: get('selector') || 'skaleclub', mailHost }
}

/**
 * 2048-bit RSA, stored as PKCS#8 PEM for the private half (what nodemailer's DKIM signer
 * expects) and bare base64 SPKI for the public half (what goes after `p=` in the TXT record).
 * This matches how xkedule.com is stored; skale.club's public column redundantly includes the
 * `v=DKIM1; k=rsa; p=` prefix, which would be double-printed by the checklist below.
 */
function generateDkimKeypair(): { privateKey: string; publicKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })

    const bare = publicKey
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\s+/g, '')

    return { privateKey, publicKey: bare }
}

async function main() {
    const args = parseArgs()
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL not set')

    const mailHost = args.mailHost
    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => { } })

    try {
        // Owner is the platform admin, mirroring what POST /api/organizations does when an
        // admin creates an org: ownerId = the creating admin, and admins are deliberately NOT
        // inserted into organization_users (they manage orgs from outside the membership model).
        const [admin] = await sql`SELECT id, email FROM users WHERE is_admin = true ORDER BY created_at LIMIT 1`
        if (!admin) throw new Error('No platform admin found — run scripts/set-admin.ts first')

        let [org] = await sql`SELECT id, name, slug FROM organizations WHERE slug = ${args.slug}`
        if (org) {
            console.log(`• org "${org.name}" already exists (${org.id}) — reusing`)
        } else {
            const inserted = await sql`
                INSERT INTO organizations (name, slug, timezone, owner_id)
                VALUES (${args.org}, ${args.slug}, 'America/Sao_Paulo', ${admin.id})
                RETURNING id, name, slug`
            org = inserted[0]
            console.log(`✓ org created: "${org.name}" (${org.id})`)
        }

        let [domain] = await sql`
            SELECT id, name, verification_token, verification_status, dkim_selector,
                   dkim_private_key IS NOT NULL AS has_key, dkim_public_key
            FROM domains WHERE organization_id = ${org.id} AND name = ${args.domain}`

        if (!domain) {
            const keys = generateDkimKeypair()
            const inserted = await sql`
                INSERT INTO domains (
                    organization_id, name, verification_method, verification_token,
                    dkim_private_key, dkim_public_key, dkim_selector
                ) VALUES (
                    ${org.id}, ${args.domain}, 'dns', gen_random_uuid()::text,
                    ${keys.privateKey}, ${keys.publicKey}, ${args.selector}
                )
                RETURNING id, name, verification_token, verification_status, dkim_selector,
                          dkim_private_key IS NOT NULL AS has_key, dkim_public_key`
            domain = inserted[0]
            console.log(`✓ domain created: ${domain.name} (${domain.id}) — DKIM keypair generated`)
        } else if (!domain.has_key) {
            const keys = generateDkimKeypair()
            const updated = await sql`
                UPDATE domains
                SET dkim_private_key = ${keys.privateKey},
                    dkim_public_key = ${keys.publicKey},
                    dkim_selector = ${args.selector},
                    updated_at = now()
                WHERE id = ${domain.id}
                RETURNING id, name, verification_token, verification_status, dkim_selector,
                          dkim_private_key IS NOT NULL AS has_key, dkim_public_key`
            domain = updated[0]
            console.log(`✓ domain ${domain.name} already existed without a key — DKIM keypair generated`)
        } else {
            console.log(`• domain ${domain.name} already exists (${domain.id}) with a DKIM key — left untouched`)
        }

        console.log()
        console.log('─'.repeat(78))
        console.log(` DNS — publique estes registros na zona de ${domain.name}`)
        console.log('─'.repeat(78))
        console.log()
        console.log(`  ${domain.name}.`)
        console.log(`    MX    10 ${mailHost}.`)
        console.log(`    TXT   "skaleclub-verification:${domain.verification_token}"`)
        console.log(`    TXT   "v=spf1 mx ~all"          <- SUBSTITUI o "v=spf1 -all" atual`)
        console.log()
        console.log(`  ${domain.dkim_selector}._domainkey.${domain.name}.`)
        console.log(`    TXT   "v=DKIM1; k=rsa; p=${domain.dkim_public_key}"`)
        console.log()
        console.log(`  _dmarc.${domain.name}.`)
        console.log(`    TXT   "v=DMARC1; p=none; rua=mailto:dmarc@${domain.name}; fo=1"`)
        console.log()
        console.log(`  autoconfig.${domain.name}.    CNAME  ${mailHost}.`)
        console.log(`  autodiscover.${domain.name}.  CNAME  ${mailHost}.`)
        console.log()
        console.log(`  Depois da propagacao, verificar:`)
        console.log(`    POST https://mail.skale.club/api/domains/${domain.id}/verify`)
        console.log()
    } finally {
        await sql.end()
    }
}

main().catch((err) => {
    console.error('Failed:', err)
    process.exit(1)
})
