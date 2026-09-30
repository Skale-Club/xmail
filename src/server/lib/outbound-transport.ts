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
import net from 'node:net'
import nodemailer from 'nodemailer'
// nodemailer 10 ships its own declarations and exports these as named types; the
// `nodemailer.Transporter` namespace form only existed in the @types/nodemailer stub.
import type { SendMailOptions, Transporter } from 'nodemailer'

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

function relayTransport(dkim: OutboundDkim | undefined, env: NodeJS.ProcessEnv): Transporter {
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
 * Endereço de conexão para um MX, forçado a IPv4 quando possível (Fase 42,
 * docs/campaign-activation-plan.md). Medido em relatórios DMARC agregados 12/09→29/09: 815 das
 * 1697 mensagens (48%) saíram por `2a01:4f8:c2c:c870::1` (IPv6) e NENHUMA alinhou SPF
 * (`softfail`) — o PTR do IPv6 é `skaleclub-mail.`, um nome sem domínio, inválido; o do IPv4
 * (`49.13.197.250`) é `mx.skale.club`, correto, e 866 de 867 mensagens por ele alinharam.
 *
 * Por que isso acontecia, verificado no código instalado (nodemailer 10.0.1,
 * node_modules/nodemailer/dist/cjs/shared/index.js, função `resolveHostname`): quando `host` é
 * um nome (não um literal IP), o nodemailer chama `dns.resolve4` E `dns.resolve6`, concatena os
 * dois resultados (`ipv4Addresses.concat(ipv6Addresses)`) e `formatDNSValue` escolhe um índice
 * AO ACASO desse array combinado (`addresses[Math.floor(Math.random() * addresses.length)]`) —
 * não é "prefere IPv4 e cai para IPv6", é sorteio entre os dois a cada conexão. Com o MX do
 * Gmail anunciando A e AAAA, isso divide o tráfego quase 50/50, batendo com os 48% medidos.
 * `smtp-connection/index.js` confirma o curto-circuito do outro lado: se `host` já é um literal
 * IP (`net.isIP(host)` verdadeiro), `resolveHostname` devolve esse endereço direto, sem consultar
 * DNS e sem sorteio (linhas 123-132 do arquivo).
 *
 * A correção então é resolver o MX para IPv4 nós mesmos (`resolveDirectConnectHost` abaixo) e
 * passar o literal como `host` — não `localAddress`. `localAddress` amarraria o socket de saída a
 * UM IP local específico; o container de produção roda em rede Docker bridge (`--network
 * coolify`), não é dono de `49.13.197.250` (esse IP é do host Hetzner, mapeado por NAT/publish),
 * então `localAddress: '49.13.197.250'` daria `EADDRNOTAVAIL` e derrubaria TODA a entrega direta,
 * não só a fração IPv6. Forçar o destino (não a origem) evita esse problema por completo.
 *
 * TLS continua oportunista com `rejectUnauthorized: false` de propósito: entre MTAs, certificado
 * auto-assinado ou com nome divergente é comum, e recusar a conexão significaria não entregar —
 * o padrão da internet aqui é criptografar quando dá e seguir em texto claro quando não dá, nunca
 * falhar a entrega por causa do certificado. Mas com `host` como IP literal, o construtor do
 * smtp-connection (`this.servername = ... !net.isIP(this.host) ? this.host : false`) zera o SNI
 * por padrão — por isso `tls.servername` é passado explicitamente como o NOME do MX: ele entra em
 * `opts` antes da checagem "ensure servername for SNI" em `_upgradeConnection`, então o servidor
 * ainda recebe o SNI correto no STARTTLS mesmo conectando por IP.
 */
async function resolveDirectConnectHost(mxHost: string): Promise<string> {
    // Já é um literal (IPv4 ou IPv6): nada a resolver, nodemailer trataria do mesmo jeito.
    if (net.isIP(mxHost)) return mxHost
    try {
        const addresses = await dns.resolve4(mxHost)
        if (addresses.length > 0) return addresses[0]
    } catch {
        // ENODATA/ENOTFOUND: o MX não tem registro A, só AAAA. Não derruba a entrega — cai no
        // comportamento de hoje (nodemailer resolve e sorteia, ver o comentário acima). Fixar em
        // IPv6 aqui produziria o MESMO problema de alinhamento que esta fase corrige, e recusar
        // a entrega por completo seria pior que o sorteio atual.
    }
    return mxHost
}

/**
 * Conexão com UM servidor MX. `connectHost` é o endereço efetivamente discado — um literal IPv4
 * quando `resolveDirectConnectHost` achou um, senão o próprio nome do MX (ver o comentário
 * acima). `mxHost` continua sendo o nome usado no SNI/TLS (`tls.servername`), porque o
 * certificado do destino é emitido para o nome, não para o IP.
 */
function directTransport(mxHost: string, connectHost: string, dkim: OutboundDkim | undefined, env: NodeJS.ProcessEnv): Transporter {
    return nodemailer.createTransport({
        host: connectHost,
        port: 25,
        secure: false,
        ignoreTLS: false,
        requireTLS: false,
        name: heloName(env),
        tls: { rejectUnauthorized: false, servername: mxHost },
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 60_000,
        dkim,
    })
}

/**
 * Campos estruturados que o smtp-connection do nodemailer põe no erro original. São eles — não o
 * texto — que `normalizeProviderFailure` (outreach-dispatch.ts) lê para decidir se a falha é
 * transitória (tenta de novo com backoff), terminal (desiste) ou ambígua (segura o lead para
 * revisão humana).
 */
export interface StructuredSendFailure {
    /** `ECONNECTION`, `EDNS`, `ETIMEDOUT`, `ESOCKET`, `EAUTH`, `EMESSAGE`, … */
    code?: string
    /** Código de resposta SMTP (4xx/5xx) quando o servidor chegou a responder. */
    responseCode?: number
    /** Última linha de resposta do servidor. */
    response?: string
    /** Comando SMTP em curso quando falhou: `CONN`, `EHLO`, `MAIL`, `RCPT`, `DATA`, … */
    command?: string
}

function structuredFieldsOf(error: unknown): StructuredSendFailure {
    if (typeof error !== 'object' || error === null) return {}
    const record = error as Record<string, unknown>
    const out: StructuredSendFailure = {}
    if (typeof record.code === 'string') out.code = record.code
    if (typeof record.responseCode === 'number') out.responseCode = record.responseCode
    if (typeof record.response === 'string') out.response = record.response
    if (typeof record.command === 'string') out.command = record.command
    return out
}

/**
 * Falha de entrega direta depois de esgotar todos os MX de um domínio.
 *
 * Antes (incidente de 2026-09-02, 07:00): o `throw new Error(`direct delivery to … failed …`)`
 * que existia aqui descartava `code`/`responseCode`/`command` do erro original. Sem esses
 * campos, `normalizeProviderFailure` classificava TODA falha de entrega direta — uma porta 25
 * bloqueada, um greylist 451, um 550 definitivo — como `ambiguous`, e o dispatcher põe o lead
 * em `held` para revisão humana, sem nunca tentar de novo. Um soluço de rede de cinco minutos
 * virava quinze leads presos. Esta classe carrega os campos do último erro, então a
 * classificação volta a ser a correta: transitório → backoff, terminal → falha, e `held` só
 * quando o servidor de fato não disse nada (timeout após DATA).
 */
export class DirectDeliveryError extends Error implements StructuredSendFailure {
    readonly domain: string
    readonly mxHosts: string[]
    readonly cause: Error | null
    readonly code?: string
    readonly responseCode?: number
    readonly response?: string
    readonly command?: string

    constructor(domain: string, mxHosts: string[], cause: Error | null) {
        super(
            `direct delivery to ${domain} failed on all ${mxHosts.length} MX host(s) (${mxHosts.join(', ')}): ${cause?.message ?? 'unknown error'}`,
        )
        this.name = 'DirectDeliveryError'
        this.domain = domain
        this.mxHosts = mxHosts
        this.cause = cause
        Object.assign(this, structuredFieldsOf(cause))
    }
}

/**
 * Resumo curto e estável de uma falha de envio, para a PRIMEIRA linha do log.
 *
 * O detector de picos (error-spike-alert.ts) agrupa erros pelos primeiros 80 caracteres da
 * mensagem, com números substituídos por `<n>`. `[Send:Relay] FAILED via direct delivery as
 * mx.skale.club:` já gastava os 80 — o alerta no Telegram dizia QUE falhou, nunca POR QUÊ.
 * Este resumo cabe antes disso e começa pela classe da falha em palavras, que sobrevive à
 * troca de números: `transient ECONNECTION`, `transient smtp-451 at RCPT`,
 * `permanent smtp-550 at RCPT`, `unclassified ...`.
 */
export function describeSendFailure(error: unknown): string {
    const fields = structuredFieldsOf(error)
    const message = error instanceof Error ? error.message : String(error)
    const at = fields.command ? ` at ${fields.command}` : ''

    if (fields.responseCode != null) {
        const klass = fields.responseCode >= 500 ? 'permanent' : fields.responseCode >= 400 ? 'transient' : 'unclassified'
        return `${klass} smtp-${fields.responseCode}${at}`
    }
    if (fields.code) {
        const transportCodes = ['EDNS', 'ECONNECTION', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET']
        const klass = transportCodes.includes(fields.code.toUpperCase()) ? 'transient' : 'unclassified'
        return `${klass} ${fields.code}${at}`
    }
    const head = message.replace(/\s+/g, ' ').trim().slice(0, 60)
    return `unclassified ${head || 'unknown error'}`
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
    mail: SendMailOptions,
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
                const connectHost = await resolveDirectConnectHost(mxHost)
                const envelope = { from: (mail.envelope?.from ?? mail.from) as string, to: groupRecipients }
                const info = await directTransport(mxHost, connectHost, dkim, env).sendMail({ ...mail, envelope })
                last = { response: info.response || info.messageId || 'accepted', via: mxHost }
                delivered = true
                break
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error))
            }
        }
        if (!delivered) {
            // Preserva code/responseCode/command do último erro — ver DirectDeliveryError.
            throw new DirectDeliveryError(domain, mxHosts, lastError)
        }
    }
    return last as OutboundResult
}
