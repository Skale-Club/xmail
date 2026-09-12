/**
 * Fase 1 Part A.1 (docs/outbound-authentication-audit.md) — creates the native mailbox that
 * receives DMARC aggregate reports: `dmarc@skale.club`. `skale.club`'s DMARC `rua` now names
 * this address (see the audit doc); the reports bounce until the mailbox actually exists.
 *
 * DECISION: dedicated new platform user, not reuse of an existing one.
 *
 * `mailboxes.email` is 1:1 with the OWNING user's email — `createUserMailbox()`
 * (native-mail.ts) keys everything off `owner.email`, and MX inbound delivery
 * (mx-server.ts's `findLocalNativeMailbox`) matches the recipient address against
 * `mailboxes.email` for a specific `userId`. There is no way to receive mail at
 * `dmarc@skale.club` through an existing user whose own address is something else — the
 * address IS the identity here, so a new user is not a choice made for tidiness, it is the
 * only shape the platform supports. This mirrors exactly what `warmup-seed-native.ts` already
 * does for `contato@`/`agenda@`/`info@`: one user per address, every time.
 *
 * NOT wired into the mesh, and deliberately carries NO `email_accounts` row at all (unlike
 * `warmup-seed-native.ts`, which always creates one — either mesh-enrolled or `--no-mesh`).
 * `email_accounts` exists for OUTREACH: warm-up participation, campaign sending, reply/bounce
 * monitoring. This mailbox never sends anything and is read only by
 * `src/server/lib/dmarc-ingest.ts` querying `mail_messages` directly — giving it an
 * `email_accounts` row would risk it being picked up as a candidate campaign-sending address
 * by outreach UI/logic that lists native accounts for an organization. A `users` row + a
 * native `mailboxes` row + default `mail_folders` is the complete, minimal shape MX delivery
 * needs (see mx-server.ts) and nothing more.
 *
 * Same production-safety pattern as warmup-seed-native.ts and for the same reason: this does
 * NOT call `createUserMailbox()` (native-mail.ts), because that encrypts the mailbox's SMTP/
 * IMAP placeholder with `encryptSecret`, which depends on `OUTLOOK_TOKEN_ENCRYPTION_KEY` in
 * the environment the SCRIPT runs in — not the environment the app runs in. A local `.env`
 * pointed at a remote DATABASE_URL would write a placeholder production can never decrypt
 * (see CLAUDE.md's 2026-08-15 incident). Instead the placeholder is COPIED byte-for-byte from
 * an existing native mailbox already in the SAME database, so it is guaranteed to already be
 * encrypted with whichever key that database's own writer used.
 *
 * Idempotent: every insert is `ON CONFLICT DO NOTHING`; re-running after a partial failure
 * (e.g. Supabase Auth user created but the DB insert failed) is safe.
 *
 * Usage:
 *   DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/seed-dmarc-mailbox.ts
 *   npx tsx scripts/seed-dmarc-mailbox.ts --dry-run
 *   npx tsx scripts/seed-dmarc-mailbox.ts --email dmarc@skale.club   # override the default
 *
 * Per the task this was written for: do NOT run this against production — a human runs it,
 * once, in the correct environment.
 */
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcrypt'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

const DRY_RUN = process.argv.includes('--dry-run')

function argValue(flag: string): string | undefined {
    const i = process.argv.indexOf(`--${flag}`)
    return i >= 0 ? process.argv[i + 1] : undefined
}

const EMAIL = (argValue('email') || 'dmarc@skale.club').trim().toLowerCase()

function localPartName(email: string): string {
    const local = email.split('@')[0]
    return local.charAt(0).toUpperCase() + local.slice(1)
}

async function main(): Promise<void> {
    const url = process.env.DATABASE_URL
    const supabaseUrl = process.env.SUPABASE_URL
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !supabaseUrl || !serviceRole) {
        console.error('Precisa de DATABASE_URL, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.')
        process.exit(1)
    }

    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => {} })
    const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })

    try {
        const domain = EMAIL.split('@')[1]
        const [dom] = await sql<{ organization_id: string; org_name: string }[]>`
            SELECT d.organization_id, o.name AS org_name FROM domains d JOIN organizations o ON o.id = d.organization_id
            WHERE lower(d.name) = ${domain} AND d.verification_status = 'verified'`
        if (!dom) {
            console.error(`✗ domínio ${domain} não está verificado na plataforma — abortando.`)
            process.exit(1)
        }

        const [reference] = await sql<{ smtp_password_encrypted: string; imap_password_encrypted: string; smtp_host: string; smtp_port: number; imap_host: string; imap_port: number }[]>`
            SELECT smtp_password_encrypted, imap_password_encrypted, smtp_host, smtp_port, imap_host, imap_port
            FROM mailboxes WHERE is_native = true AND is_active = true ORDER BY created_at LIMIT 1`
        if (!reference) {
            console.error('Nenhuma mailbox nativa existente para copiar o placeholder cifrado. Crie a primeira pela UI.')
            process.exit(1)
        }

        console.log(`→ ${EMAIL} (org ${dom.org_name})${DRY_RUN ? ' [dry-run]' : ''}`)
        if (DRY_RUN) return

        // 1. Usuário dedicado (Supabase Auth + users). Não há usuário para reaproveitar: ver o
        // comentário de topo do arquivo — o endereço É a identidade aqui.
        let [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = ${EMAIL}`
        if (!user) {
            const password = randomBytes(24).toString('base64url')
            const { data, error } = await supabase.auth.admin.createUser({
                email: EMAIL,
                password,
                email_confirm: true,
                user_metadata: { firstName: localPartName(EMAIL), dmarcReportMailbox: true },
            })
            if (error || !data.user) {
                console.error(`✗ ${EMAIL}: Supabase Auth recusou: ${error?.message ?? 'sem usuário'}`)
                process.exit(1)
            }
            const passwordHash = await bcrypt.hash(password, 10)
            ;[user] = await sql<{ id: string }[]>`
                INSERT INTO users (id, email, first_name, is_admin, email_verified, password_hash)
                VALUES (${data.user.id}, ${EMAIL}, ${localPartName(EMAIL)}, false, true, ${passwordHash})
                RETURNING id`
            console.log(`   usuário criado ${user.id}`)
        } else {
            console.log(`   usuário já existia ${user.id}`)
        }

        // 2. Vínculo com a organização dona do domínio.
        await sql`
            INSERT INTO organization_users (organization_id, user_id, role)
            VALUES (${dom.organization_id}, ${user.id}, 'member')
            ON CONFLICT DO NOTHING`

        // 3. Mailbox nativa + pastas padrão (placeholder copiado — ver comentário de topo).
        await sql`
            INSERT INTO mailboxes (
                user_id, email, smtp_host, smtp_port, smtp_username, smtp_password_encrypted, smtp_secure,
                imap_host, imap_port, imap_username, imap_password_encrypted, imap_secure, is_default, is_native
            ) VALUES (
                ${user.id}, ${EMAIL}, ${reference.smtp_host}, ${reference.smtp_port}, ${EMAIL}, ${reference.smtp_password_encrypted}, false,
                ${reference.imap_host}, ${reference.imap_port}, ${EMAIL}, ${reference.imap_password_encrypted}, false, true, true
            ) ON CONFLICT DO NOTHING`
        const [mailbox] = await sql<{ id: string }[]>`
            SELECT id FROM mailboxes WHERE user_id = ${user.id} AND lower(email) = ${EMAIL} AND is_native = true`
        const uidValidity = Math.floor(Date.now() / 1000)
        for (const [remoteId, name, type] of [['INBOX', 'Inbox', 'inbox'], ['Sent', 'Sent', 'sent'], ['Drafts', 'Drafts', 'drafts'], ['Archive', 'Archive', 'archive'], ['Trash', 'Trash', 'trash'], ['Spam', 'Spam', 'spam']]) {
            await sql`
                INSERT INTO mail_folders (mailbox_id, remote_id, name, type, uid_validity)
                VALUES (${mailbox.id}, ${remoteId}, ${name}, ${type}, ${uidValidity})
                ON CONFLICT DO NOTHING`
        }
        console.log(`   mailbox ${mailbox.id} com pastas padrão`)

        // Deliberadamente SEM linha em email_accounts — ver comentário de topo do arquivo.

        console.log(`\n✅ ${EMAIL} pronta para receber relatórios DMARC.`)
        console.log('   Confirme que o rua= do domínio aponta para este endereço e que')
        console.log('   src/server/jobs/processDmarcReports.ts está no cron (jobs/index.ts).')
    } finally {
        await sql.end({ timeout: 5 })
    }
}

main().catch((error) => {
    console.error('seed-dmarc-mailbox falhou:', error instanceof Error ? error.message : error)
    process.exit(1)
})
