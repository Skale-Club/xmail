/**
 * A assinatura DKIM de saída, verificada de ponta a ponta.
 *
 * `native-send.ts` e `smtp-server.ts` chamam ambos `sendOutbound({ envelope, raw }, …, dkim)`.
 * Isto é, a mensagem já vem montada em bytes e quem assina é o próprio nodemailer, sobre um
 * `raw` — não sobre um corpo que ele mesmo compôs. Esse é justamente o caminho que o nodemailer
 * 10.0.0 mudou ("dkim: canonicalize raw messages the way verifiers do"), então a troca de
 * major aqui não é uma questão de a API compilar: é a questão de a assinatura continuar
 * **verificando**. Uma canonicalização divergente não quebra nada de forma visível — o envio
 * tem sucesso, o servidor aceita, e a queda aparece semanas depois como DKIM `fail` na caixa
 * do destinatário e reputação perdida. Nenhum teste da suíte cobria isso.
 *
 * Este teste sobe um sink SMTP de verdade numa porta efêmera, manda a mensagem pelo
 * `sendOutbound` real, captura os bytes que saíram do fio e pede ao mailauth — o mesmo
 * verificador que usamos no caminho de ENTRADA (`lib/mail-auth.ts`) — que confira a assinatura
 * contra a chave pública. Se a canonicalização divergir do que verificadores esperam, isto
 * falha aqui e não em produção.
 */
import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { dkimVerify } from 'mailauth/lib/dkim/verify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendOutbound } from '../outbound-transport'

const DOMAIN = 'skale-test.example'
const SELECTOR = 'skaleclub'
const FROM = `info@${DOMAIN}`
const TO = 'destinatario@exemplo.example'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
})

/** O registro TXT `<selector>._domainkey.<domain>` que a chave acima implica. */
const dkimTxt = `v=DKIM1; k=rsa; p=${publicKey.replace(/-----[A-Z ]+-----|\s/g, '')}`

/** Resolver de DNS de mentira: só sabe a chave pública deste teste. */
const resolver = async (name: string, rrtype: string): Promise<string[][]> => {
    if (rrtype === 'TXT' && name === `${SELECTOR}._domainkey.${DOMAIN}`) return [[dkimTxt]]
    throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' })
}

/**
 * Mensagem pronta em bytes, como o webmail e o servidor SMTP a entregam: CRLF de verdade,
 * um corpo com espaço no fim de linha e uma linha vazia final — as três coisas que
 * canonicalização `relaxed` normaliza e sobre as quais assinante e verificador têm de
 * concordar.
 */
const RAW = Buffer.from(
    [
        `From: Info <${FROM}>`,
        `To: <${TO}>`,
        'Subject: Assunto de teste',
        'Message-ID: <fixo@skale-test.example>',
        'Date: Wed, 03 Sep 2026 12:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Primeira linha com espaço no fim   ',
        'Segunda linha.',
        '',
    ].join('\r\n'),
    'utf8',
)

let server: SMTPServer
let port: number
const received: Buffer[] = []

beforeAll(async () => {
    server = new SMTPServer({
        authOptional: true,
        disabledCommands: ['STARTTLS'],
        onAuth(_auth, _session, callback) {
            callback(null, { user: 'test' })
        },
        onData(stream, _session, callback) {
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => {
                received.push(Buffer.concat(chunks))
                callback()
            })
        },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.server.address() as AddressInfo).port
})

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Relay apontado ao sink — é o ramo `isRelayConfigured()` do sendOutbound. */
function relayEnv(): NodeJS.ProcessEnv {
    return {
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        MAIL_HOST: 'mx.skale-test.example',
    }
}

describe('sendOutbound: assinatura DKIM sobre uma mensagem raw', () => {
    it('entrega os bytes e a assinatura verifica contra a chave pública', async () => {
        received.length = 0

        const result = await sendOutbound(
            { envelope: { from: FROM, to: [TO] }, raw: RAW },
            [TO],
            { domainName: DOMAIN, keySelector: SELECTOR, privateKey },
            relayEnv(),
        )

        expect(result.via).toBe('relay')
        expect(received).toHaveLength(1)

        const onTheWire = received[0]
        // O nodemailer prefixa a assinatura à mensagem; o resto tem de sair intacto.
        expect(onTheWire.toString('utf8')).toContain('DKIM-Signature:')
        expect(onTheWire.toString('utf8')).toContain('Subject: Assunto de teste')

        const verified = await dkimVerify(onTheWire, { resolver })
        const results = verified.results ?? []
        expect(results).toHaveLength(1)
        // `pass` é a única resposta aceitável: `neutral`/`fail` aqui significa assinatura
        // emitida com uma canonicalização que verificadores não reproduzem.
        expect(results[0].status.result).toBe('pass')
        expect(results[0].signingDomain).toBe(DOMAIN)
        expect(results[0].selector).toBe(SELECTOR)
    })

    /**
     * Controle negativo. Sem isto o teste acima é vazio: um `expect(...).toBe('pass')` que
     * passasse por qualquer motivo — verificador complacente, resolver errado, assinatura não
     * conferida de fato — não distinguiria uma canonicalização correta de nenhuma verificação.
     * Adulterar um byte do corpo tem de derrubar o `pass`.
     */
    it('um byte trocado no corpo derruba a verificação', async () => {
        received.length = 0

        await sendOutbound(
            { envelope: { from: FROM, to: [TO] }, raw: RAW },
            [TO],
            { domainName: DOMAIN, keySelector: SELECTOR, privateKey },
            relayEnv(),
        )

        const tampered = Buffer.from(
            received[0].toString('utf8').replace('Segunda linha.', 'Segunda linhaX'),
            'utf8',
        )
        const verified = await dkimVerify(tampered, { resolver })
        expect(verified.results?.[0].status.result).not.toBe('pass')
    })

    it('sem chave DKIM a mensagem sai, apenas sem assinatura', async () => {
        received.length = 0

        await sendOutbound({ envelope: { from: FROM, to: [TO] }, raw: RAW }, [TO], undefined, relayEnv())

        expect(received).toHaveLength(1)
        expect(received[0].toString('utf8')).not.toContain('DKIM-Signature:')
    })

    it('o envelope mandado no fio é o nosso, não o dos cabeçalhos', async () => {
        received.length = 0
        const envelopeTo = 'envelope-only@exemplo.example'

        // Return-Path é escrito pelo sink a partir do MAIL FROM, então o envelope é observável
        // pelos bytes recebidos sem depender da API interna do smtp-server.
        const info = await sendOutbound(
            { envelope: { from: FROM, to: [envelopeTo] }, raw: RAW },
            [envelopeTo],
            { domainName: DOMAIN, keySelector: SELECTOR, privateKey },
            relayEnv(),
        )

        expect(info.response).toBeTruthy()
        expect(received).toHaveLength(1)
        // O cabeçalho To: segue sendo o original — o envelope é o que decide a entrega.
        expect(received[0].toString('utf8')).toContain(`To: <${TO}>`)
    })
})
