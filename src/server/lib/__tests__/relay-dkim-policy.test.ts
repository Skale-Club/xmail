/**
 * A assinatura DKIM própria não sobrevive a um relay que reescreve o corpo (Gmail carimba
 * `dkim=neutral (body hash did not verify)` para o nosso domínio); nesses relays deixamos só a
 * assinatura do relay. Estes testes travam a detecção e os overrides por env.
 */
import { describe, expect, it } from 'vitest'
import { shouldSkipOwnDkimForRelay } from '../relay-dkim-policy'

describe('shouldSkipOwnDkimForRelay', () => {
    it('pula a assinatura própria para hosts do Brevo/Sendinblue', () => {
        expect(shouldSkipOwnDkimForRelay('smtp-relay.brevo.com', {})).toBe(true)
        expect(shouldSkipOwnDkimForRelay('smtp-relay.sendinblue.com', {})).toBe(true)
        expect(shouldSkipOwnDkimForRelay('SMTP-RELAY.BREVO.COM', {})).toBe(true)
    })
    it('mantém a assinatura para outros relays e para entrega direta', () => {
        expect(shouldSkipOwnDkimForRelay('smtp.mailgun.org', {})).toBe(false)
        expect(shouldSkipOwnDkimForRelay('notbrevo.com', {})).toBe(false)
        expect(shouldSkipOwnDkimForRelay(undefined, {})).toBe(false)
    })
    it('NATIVE_DKIM_SIGN=always força assinar; =never pula em qualquer relay', () => {
        expect(shouldSkipOwnDkimForRelay('smtp-relay.brevo.com', { NATIVE_DKIM_SIGN: 'always' })).toBe(false)
        expect(shouldSkipOwnDkimForRelay('smtp.mailgun.org', { NATIVE_DKIM_SIGN: 'never' })).toBe(true)
        expect(shouldSkipOwnDkimForRelay(undefined, { NATIVE_DKIM_SIGN: 'never' })).toBe(false)
    })
})
