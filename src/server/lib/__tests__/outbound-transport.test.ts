/**
 * O transporte de saída é o único ponto que decide relay vs. entrega direta. Estes testes travam
 * as três coisas que já quebraram de verdade:
 *
 *  - relay só conta com host E usuário (host sozinho não autentica);
 *  - o HELO tem de ser `MAIL_HOST`, porque é ele que precisa casar com o PTR do IP;
 *  - agrupamento de destinatários por domínio, que é o que a entrega direta precisa fazer e o
 *    antigo `direct: true` do nodemailer nunca fez (ele ia para `localhost`).
 */
import { describe, expect, it } from 'vitest'
import {
    describeOutbound,
    describeSendFailure,
    DirectDeliveryError,
    domainOfAddress,
    heloName,
    isRelayConfigured,
    outboundMode,
} from '../outbound-transport'

const RELAY = { SMTP_HOST: 'smtp-relay.example.com', SMTP_USER: 'user', SMTP_PASS: 'pw', MAIL_HOST: 'mx.skale.club' }
const DIRECT = { MAIL_HOST: 'mx.skale.club' }

describe('isRelayConfigured / outboundMode', () => {
    it('exige host E usuário', () => {
        expect(isRelayConfigured(RELAY)).toBe(true)
        expect(isRelayConfigured({ SMTP_HOST: 'smtp.example.com' })).toBe(false)
        expect(isRelayConfigured({ SMTP_USER: 'user' })).toBe(false)
        expect(isRelayConfigured({})).toBe(false)
    })
    it('sem relay o modo é entrega direta', () => {
        expect(outboundMode(RELAY)).toBe('relay')
        expect(outboundMode(DIRECT)).toBe('direct')
    })
})

describe('heloName', () => {
    it('prefere MAIL_HOST — é o nome que precisa casar com o PTR do IP', () => {
        expect(heloName({ MAIL_HOST: 'mx.skale.club', MAIL_DOMAIN: 'skale.club' })).toBe('mx.skale.club')
    })
    it('cai para MAIL_DOMAIN e depois localhost', () => {
        expect(heloName({ MAIL_DOMAIN: 'skale.club' })).toBe('skale.club')
        expect(heloName({})).toBe('localhost')
    })
})

describe('describeOutbound', () => {
    it('descreve o relay sem vazar a senha', () => {
        const described = describeOutbound(RELAY)
        expect(described).toContain('smtp-relay.example.com')
        expect(described).toContain('user')
        expect(described).not.toContain('pw')
    })
    it('descreve a entrega direta com o HELO em uso', () => {
        expect(describeOutbound(DIRECT)).toBe('direct delivery as mx.skale.club')
    })
})

describe('domainOfAddress', () => {
    it('extrai o domínio, normalizado', () => {
        expect(domainOfAddress('Info@Skale.Club')).toBe('skale.club')
        expect(domainOfAddress('a@b.example.com')).toBe('b.example.com')
    })
    it('tolera a forma com colchete final', () => {
        expect(domainOfAddress('info@skale.club>')).toBe('skale.club')
    })
})

describe('DirectDeliveryError', () => {
    it('carrega code/responseCode/command do erro original — é o que a classificação lê', () => {
        const cause = Object.assign(new Error('Connection refused'), { code: 'ECONNECTION', command: 'CONN' })
        const err = new DirectDeliveryError('example.com', ['mx1.example.com', 'mx2.example.com'], cause)
        expect(err).toBeInstanceOf(Error)
        expect(err.name).toBe('DirectDeliveryError')
        expect(err.message).toBe('direct delivery to example.com failed on all 2 MX host(s) (mx1.example.com, mx2.example.com): Connection refused')
        expect(err).toMatchObject({ code: 'ECONNECTION', command: 'CONN', domain: 'example.com' })
        expect(err.cause).toBe(cause)
    })

    it('preserva a resposta SMTP numérica', () => {
        const cause = Object.assign(new Error('Greylisted'), { responseCode: 451, response: '451 4.7.1 try later', command: 'RCPT' })
        const err = new DirectDeliveryError('example.com', ['mx.example.com'], cause)
        expect(err).toMatchObject({ responseCode: 451, response: '451 4.7.1 try later', command: 'RCPT' })
    })

    it('tolera ausência de causa', () => {
        const err = new DirectDeliveryError('example.com', ['example.com'], null)
        expect(err.message).toContain('unknown error')
        expect(err.code).toBeUndefined()
    })
})

describe('describeSendFailure', () => {
    it('começa pela classe em palavras, que sobrevive à normalização do alerta de pico', () => {
        expect(describeSendFailure(Object.assign(new Error('x'), { responseCode: 451, command: 'RCPT' }))).toBe('transient smtp-451 at RCPT')
        expect(describeSendFailure(Object.assign(new Error('x'), { responseCode: 550 }))).toBe('permanent smtp-550')
        expect(describeSendFailure(Object.assign(new Error('x'), { code: 'ECONNECTION', command: 'CONN' }))).toBe('transient ECONNECTION at CONN')
        expect(describeSendFailure(Object.assign(new Error('x'), { code: 'EAUTH' }))).toBe('unclassified EAUTH')
        expect(describeSendFailure(new Error('something   odd\nhappened'))).toBe('unclassified something odd happened')
        expect(describeSendFailure('plain string')).toBe('unclassified plain string')
    })

    it('lê através do embrulho da entrega direta', () => {
        const wrapped = new DirectDeliveryError('example.com', ['mx.example.com'], Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
        expect(describeSendFailure(wrapped)).toBe('transient ECONNREFUSED')
    })
})
