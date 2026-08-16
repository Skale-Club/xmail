/**
 * O ÚNICO lugar que decide como uma mensagem sai daqui: por relay autenticado ou por entrega
 * direta ao MX do destinatário.
 *
 * Dois problemas reais motivaram este módulo, ambos medidos em 2026-08-16.
 *
 * 1. **A "entrega direta" que existia nunca entregou nada.** O código passava
 *    `nodemailer.createTransport({ direct: true, … })`, mas o nodemailer 6 NÃO tem transporte
 *    direto — `direct` era um pacote separado da era v2/v3. A opção é ignorada e o
 *    smtp-connection cai no default `host: 'localhost'`, então a mensagem batia na porta 25 do
 *    NOSSO próprio container. O sintoma era um erro de TLS confuso
 *    (`Host: localhost is not in the cert's altnames: DNS:mx.skale.club` — o certificado era o
 *    nosso), e não "não consegui entregar". Aqui a resolução de MX é feita explicitamente.
 *
 * 2. **Dois caminhos desistiam em silêncio sem relay.** `jobs/processQueue.ts` fazia
 *    `'SMTP_HOST not configured, skipping delivery'` e `lib/route-matcher.ts` tinha um
 *    `if (host)` sem `else`. Enquanto havia relay isso nunca aparecia; no dia da migração para
 *    entrega direta viraria perda silenciosa de fila e de encaminhamento.
 *
 * Entrega direta exige, no host: porta 25 de SAÍDA liberada e PTR do IP casando com o HELO
 * (`MAIL_HOST`). Ver `.env.example` para os testes dos dois pré-requisitos.
 */

import { promises as dns } from 'node:dns'
import nodemailer from 'nodemailer'

export interface OutboundDkim {
    domainName: string
    keySelector: string
    privateKey: string
}

export type OutboundMode = 'relay' | 'direct'

/** Relay só conta como configurado com host E usuário — host sozinho não autentica. */
export function isRelayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.SMTP_HOST && env.SMTP_USER)
}

export function outboundMode(env: NodeJS.ProcessEnv = process.env): OutboundMode {
    return isRelayConfigured(env) ? 'relay' : 'direct'
}

/** Nome anunciado no HELO. Precisa casar com o PTR do IP público. */
export function heloName(env: NodeJS.ProcessEnv = process.env): string {
    return env.MAIL_HOST || env.MAIL_DOMAIN || 'localhost'
}

/** Descrição curta do modo para log — sem credencial. */
export function describeOutbound(env: NodeJS.ProcessEnv = process.env): string {
    return isRelayConfigured(env)
        ? `relay ${env.SMTP_HOST}:${env.SMTP_PORT || '587'} as ${env.SMTP_USER}`
        : `direct delivery as ${heloName(env)}`
}

export function domainOfAddress(address: string): string {
    return address.split('@').pop()?.trim().toLowerCase().replace(/>$/, '') ?? ''
}

/**
 * MX do domínio, em ordem de preferência. Sem registro MX, o RFC 5321 §5.1 manda usar o próprio
 * A/AAAA do domínio como destino implícito — é o que o fallback faz.
 */
export async function resolveMxHosts(domain: string): Promise<string[]> {
    try {
        const records = await dns.resolveMx(domain)
        if (records.length > 0) {
            return records
                .sort((a, b) => a.priority - b.priority)
                .map((record) => record.exchange)
                .filter(Boolean)
        }
    } catch {
        // Sem MX (NXDOMAIN/ENODATA) cai no fallback abaixo.
    }
    return [domain]
}

function relayTransport(dkim: OutboundDkim | undefined, env: NodeJS.ProcessEnv): nodemailer.Transporter {
    const port = parseInt(env.SMTP_PORT || '587')
    return nodemailer.createTransport({
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: { user: env.SMTP_USER as string, pass: env.SMTP_PASS },
        name: heloName(env),
        dkim,
    })
}

/**
 * Conexão com UM servidor MX. TLS é oportunista com `rejectUnauthorized: false` de propósito:
 * entre MTAs, certificado auto-assinado ou com nome divergente é comum, e recusar a conexão
 * significaria não entregar — o padrão da internet aqui é criptografar quando dá e seguir em
 * texto claro quando não dá, nunca falhar a entrega por causa do certificado.
 */
function directTransport(mxHost: string, dkim: OutboundDkim | undefined, env: NodeJS.ProcessEnv): nodemailer.Transporter {
    return nodemailer.createTransport({
        host: mxHost,
        port: 25,
        secure: false,
        ignoreTLS: false,
        requireTLS: false,
        name: heloName(env),
        tls: { rejectUnauthorized: false },
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 60_000,
        dkim,
    })
}

export interface OutboundResult {
    /** Resposta do último servidor que aceitou. */
    response: string
    /** 'relay' ou o host MX que aceitou. */
    via: string
}

/**
 * Envia `mail` para todos os destinatários de `recipients`.
 *
 * Em modo relay é uma conexão só. Em modo direto os destinatários são agrupados por domínio, e
 * cada grupo é tentado nos MX em ordem de preferência até um aceitar — se todos falharem, o erro
 * do último sobe para quem chamou (que grava a falha e reagenda). Nunca devolve sucesso sem que
 * um servidor tenha aceitado.
 */
export async function sendOutbound(
    mail: nodemailer.SendMailOptions,
    recipients: string[],
    dkim?: OutboundDkim,
    env: NodeJS.ProcessEnv = process.env,
): Promise<OutboundResult> {
    if (recipients.length === 0) throw new Error('sendOutbound: no recipients')

    if (isRelayConfigured(env)) {
        const info = await relayTransport(dkim, env).sendMail(mail)
        return { response: info.response || info.messageId || 'accepted', via: 'relay' }
    }

    const byDomain = new Map<string, string[]>()
    for (const recipient of recipients) {
        const domain = domainOfAddress(recipient)
        byDomain.set(domain, [...(byDomain.get(domain) ?? []), recipient])
    }

    let last: OutboundResult | null = null
    for (const [domain, groupRecipients] of byDomain) {
        const mxHosts = await resolveMxHosts(domain)
        let delivered = false
        let lastError: Error | null = null
        for (const mxHost of mxHosts) {
            try {
                const envelope = { from: (mail.envelope?.from ?? mail.from) as string, to: groupRecipients }
                const info = await directTransport(mxHost, dkim, env).sendMail({ ...mail, envelope })
                last = { response: info.response || info.messageId || 'accepted', via: mxHost }
                delivered = true
                break
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error))
            }
        }
        if (!delivered) {
            throw new Error(
                `direct delivery to ${domain} failed on all ${mxHosts.length} MX host(s) (${mxHosts.join(', ')}): ${lastError?.message ?? 'unknown error'}`,
            )
        }
    }
    return last as OutboundResult
}
