/**
 * DNS checklist generator for Phase 11.
 *
 * Queries the domains table, fetches the Hetzner public IP (if local env has
 * MAIL_HOST), and prints the exact DNS records needed at the registrar.
 *
 * Usage: npx tsx scripts/dns-checklist.ts
 */

import 'dotenv/config'
import postgres from 'postgres'
import dns from 'dns/promises'

async function main() {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL not set')
    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => { } })

    const mailHost = process.env.MAIL_HOST || 'mail.skale.club'
    let vpsIp: string | null = null
    try {
        const [ip] = await dns.resolve4(mailHost)
        vpsIp = ip
    } catch {
        vpsIp = null
    }

    try {
        const rows = await sql`
            SELECT id, name, dkim_selector, dkim_public_key, dkim_status,
                   spf_status, dmarc_status, mx_status, verification_status
            FROM domains
            ORDER BY created_at ASC
        `

        if (rows.length === 0) {
            console.log('No domains registered.')
            return
        }

        console.log('═'.repeat(80))
        console.log(' DNS CHECKLIST — Phase 11')
        console.log('═'.repeat(80))
        console.log()
        console.log(`MAIL_HOST:  ${mailHost}`)
        console.log(`VPS IPv4:   ${vpsIp ?? '❌ NOT RESOLVING — publish A record first'}`)
        console.log()

        for (const r of rows) {
            const name = r.name as string
            const selector = (r.dkim_selector || 'skaleclub') as string
            const rawKey = r.dkim_public_key as string | null

            console.log('─'.repeat(80))
            console.log(` ${name}`)
            console.log('─'.repeat(80))
            console.log(`Current status:`)
            console.log(`  verification = ${r.verification_status}`)
            console.log(`  spf = ${r.spf_status}   dkim = ${r.dkim_status}   dmarc = ${r.dmarc_status}   mx = ${r.mx_status}`)
            console.log()

            if (!rawKey) {
                console.log('  ❌ No DKIM key generated yet. Run domain setup first.')
                console.log()
                continue
            }

            const dkimValue = extractDkimValue(rawKey)

            console.log('Publish these records at your DNS provider:')
            console.log()
            console.log(`  mail.${name}.                    A      ${vpsIp ?? '<VPS_IP>'}`)
            console.log(`  ${name}.                    MX  10 ${mailHost}.`)
            console.log(`  ${name}.                    TXT    "v=spf1 a mx ip4:${vpsIp ?? '<VPS_IP>'} ~all"`)
            console.log(`  ${selector}._domainkey.${name}.  TXT    "v=DKIM1; k=rsa; p=${dkimValue}"`)
            console.log(`  _dmarc.${name}.             TXT    "v=DMARC1; p=none; rua=mailto:dmarc@${name}; fo=1"`)
            console.log(`  autoconfig.${name}.         CNAME  ${mailHost}.`)
            console.log(`  autodiscover.${name}.       CNAME  ${mailHost}.`)
            console.log()
            console.log('After publishing (wait for propagation), verify via:')
            console.log(`  curl -X POST -H "Authorization: Bearer <token>" https://${mailHost}/api/domains/${r.id}/verify`)
            console.log()
        }

        console.log('═'.repeat(80))
        console.log(' Also required (not domain-specific):')
        console.log('═'.repeat(80))
        console.log()
        console.log(`  • Reverse DNS (PTR):  ${vpsIp ?? '<VPS_IP>'} → ${mailHost}.`)
        console.log(`      set via Hetzner Cloud Console → Server → Networking → Reverse DNS`)
        console.log()
        console.log('  • Caddy block for autoconfig subdomain:')
        console.log(`      autoconfig.${rows[0].name}, autodiscover.${rows[0].name} {`)
        console.log('          encode zstd gzip')
        console.log('          reverse_proxy localhost:9001')
        console.log('      }')
        console.log()
    } finally {
        await sql.end()
    }
}

/**
 * DKIM public keys are often stored in PEM format with header/footer.
 * DNS TXT records need only the base64 content between the markers.
 */
function extractDkimValue(rawKey: string): string {
    const pemMatch = rawKey.match(/-----BEGIN PUBLIC KEY-----\s*([\s\S]*?)\s*-----END PUBLIC KEY-----/)
    const content = pemMatch ? pemMatch[1] : rawKey
    return content.replace(/\s+/g, '')
}

main().catch((err) => {
    console.error('Failed:', err)
    process.exit(1)
})
