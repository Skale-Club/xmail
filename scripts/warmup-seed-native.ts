/**
 * Cria caixas nativas dedicadas ao warm-up (seeds) — usuário da plataforma + mailbox nativa +
 * conta de outreach `provider='native'`, `warmup_source='internal'`, `warmup_only=true`.
 *
 * Uso:
 *   npx tsx scripts/warmup-seed-native.ts contato@skale.club agenda@xkedule.com …
 *   npx tsx scripts/warmup-seed-native.ts --dry-run contato@skale.club
 *
 * Pré-condições por endereço: o domínio existe em `domains` com `verification_status='verified'`
 * (é dele que sai a organização), e o e-mail ainda não é usuário. Idempotente: se o usuário/
 * mailbox/conta já existem, só garante o vínculo com o mesh.
 *
 * Por que NÃO usa `createUserMailbox()` daqui: ela cifra o placeholder da mailbox com
 * `encryptSecret`, que depende de OUTLOOK_TOKEN_ENCRYPTION_KEY do ambiente onde o script roda. Um
 * `.env` local com chave diferente da de produção gravaria um payload que produção não decifra —
 * exatamente o incidente de 2026-08-15. Aqui o placeholder é COPIADO de uma mailbox nativa já
 * existente no mesmo banco (portanto cifrado com a chave certa, seja ela qual for).
 *
 * A senha do usuário é aleatória e descartada: seeds não fazem login; o mesh envia pelo caminho
 * nativo da plataforma, sem credencial.
 */
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcrypt'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

const DRY_RUN = process.argv.includes('--dry-run')
const emails = process.argv.slice(2).filter((arg) => !arg.startsWith('--')).map((e) => e.trim().toLowerCase())

function localPartName(email: string): string {
    const local = email.split('@')[0]
    return local.charAt(0).toUpperCase() + local.slice(1)
}

async function main(): Promise<void> {
    if (emails.length === 0) {
        console.error('Informe pelo menos um e-mail.')
        process.exit(1)
    }
    const url = process.env.DATABASE_URL
    const supabaseUrl = process.env.SUPABASE_URL
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !supabaseUrl || !serviceRole) {
        console.error('Precisa de DATABASE_URL, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.')
        process.exit(1)
    }
    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => { } })
    const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })

    try {
        const [reference] = await sql<{ smtp_password_encrypted: string; imap_password_encrypted: string; smtp_host: string; smtp_port: number; imap_host: string; imap_port: number }[]>`
            SELECT smtp_password_encrypted, imap_password_encrypted, smtp_host, smtp_port, imap_host, imap_port
            FROM mailboxes WHERE is_native = true AND is_active = true ORDER BY created_at LIMIT 1`
        if (!reference) {
            console.error('Nenhuma mailbox nativa existente para copiar o placeholder cifrado. Crie a primeira pela UI.')
            process.exit(1)
        }

        for (const email of emails) {
            const domain = email.split('@')[1]
            const [dom] = await sql<{ organization_id: string; org_name: string }[]>`
                SELECT d.organization_id, o.name AS org_name FROM domains d JOIN organizations o ON o.id = d.organization_id
                WHERE lower(d.name) = ${domain} AND d.verification_status = 'verified'`
            if (!dom) {
                console.error(`✗ ${email}: domínio ${domain} não está verificado na plataforma — pulando.`)
                continue
            }
            console.log(`\n→ ${email} (org ${dom.org_name})${DRY_RUN ? ' [dry-run]' : ''}`)
            if (DRY_RUN) continue

            // 1. Usuário (Supabase Auth + users)
            let [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = ${email}`
            if (!user) {
                const password = randomBytes(24).toString('base64url')
                const { data, error } = await supabase.auth.admin.createUser({
                    email,
                    password,
                    email_confirm: true,
                    user_metadata: { firstName: localPartName(email), warmupSeed: true },
                })
                if (error || !data.user) {
                    console.error(`✗ ${email}: Supabase Auth recusou: ${error?.message ?? 'sem usuário'}`)
                    continue
                }
                const passwordHash = await bcrypt.hash(password, 10)
                ;[user] = await sql<{ id: string }[]>`
                    INSERT INTO users (id, email, first_name, is_admin, email_verified, password_hash)
                    VALUES (${data.user.id}, ${email}, ${localPartName(email)}, false, true, ${passwordHash})
                    RETURNING id`
                console.log(`   usuário criado ${user.id}`)
            } else {
                console.log(`   usuário já existia ${user.id}`)
            }

            // 2. Vínculo com a organização dona do domínio
            await sql`
                INSERT INTO organization_users (organization_id, user_id, role)
                VALUES (${dom.organization_id}, ${user.id}, 'member')
                ON CONFLICT DO NOTHING`

            // 3. Mailbox nativa + pastas padrão (mesma forma de createUserMailbox, placeholder copiado)
            await sql`
                INSERT INTO mailboxes (
                    user_id, email, smtp_host, smtp_port, smtp_username, smtp_password_encrypted, smtp_secure,
                    imap_host, imap_port, imap_username, imap_password_encrypted, imap_secure, is_default, is_native
                ) VALUES (
                    ${user.id}, ${email}, ${reference.smtp_host}, ${reference.smtp_port}, ${email}, ${reference.smtp_password_encrypted}, false,
                    ${reference.imap_host}, ${reference.imap_port}, ${email}, ${reference.imap_password_encrypted}, false, true, true
                ) ON CONFLICT DO NOTHING`
            const [mailbox] = await sql<{ id: string }[]>`
                SELECT id FROM mailboxes WHERE user_id = ${user.id} AND lower(email) = ${email} AND is_native = true`
            const uidValidity = Math.floor(Date.now() / 1000)
            for (const [remoteId, name, type] of [['INBOX', 'Inbox', 'inbox'], ['Sent', 'Sent', 'sent'], ['Drafts', 'Drafts', 'drafts'], ['Archive', 'Archive', 'archive'], ['Trash', 'Trash', 'trash'], ['Spam', 'Spam', 'spam']]) {
                await sql`
                    INSERT INTO mail_folders (mailbox_id, remote_id, name, type, uid_validity)
                    VALUES (${mailbox.id}, ${remoteId}, ${name}, ${type}, ${uidValidity})
                    ON CONFLICT DO NOTHING`
            }
            console.log(`   mailbox ${mailbox.id} com pastas padrão`)

            // 4. Conta de outreach nativa no mesh, warm-up only (mesma forma de warmup-mesh.ts --add-native --only)
            const [account] = await sql<{ email: string }[]>`
                INSERT INTO email_accounts (
                    organization_id, email, provider, mailbox_provider, status, verified_at,
                    daily_send_limit, warmup_enabled, warmup_days,
                    warmup_source, warmup_only, warmup_started_at
                ) VALUES (
                    ${dom.organization_id}, ${email}, 'native', 'manual', 'verified', now(),
                    50, true, 14,
                    'internal', true, now()
                )
                ON CONFLICT (organization_id, lower(email)) DO UPDATE SET
                    warmup_source = 'internal', warmup_only = true,
                    warmup_started_at = coalesce(email_accounts.warmup_started_at, now()),
                    updated_at = now()
                RETURNING email`
            console.log(`   ✅ seed no mesh (warm-up only): ${account.email}`)
        }
    } finally {
        await sql.end({ timeout: 5 })
    }
}

main().catch((error) => {
    console.error('warmup-seed-native falhou:', error instanceof Error ? error.message : error)
    process.exit(1)
})
