/**
 * A verificação de SPF exigia `include:spf.skaleclub.com` — um host que hoje é CNAME para um
 * domínio de terceiro cujo SPF autoriza hosts desconhecidos a enviar em nosso nome. Estes testes
 * travam o critério novo: aceitar quem autoriza os remetentes REAIS da plataforma.
 */
import { describe, expect, it } from 'vitest'
import { isAcceptableSpf } from '../spf-policy'

describe('isAcceptableSpf', () => {
    it('aceita o SPF que publicamos nos domínios novos', () => {
        expect(isAcceptableSpf('v=spf1 mx include:spf.brevo.com ~all')).toBe(true)
    })

    it('aceita só o mecanismo mx (entrega direta pelo nosso MX)', () => {
        expect(isAcceptableSpf('v=spf1 mx ~all')).toBe(true)
        expect(isAcceptableSpf('v=spf1 +mx -all')).toBe(true)
    })

    it('continua aceitando o include legado dos domínios antigos', () => {
        expect(isAcceptableSpf('v=spf1 include:spf.skaleclub.com ~all')).toBe(true)
    })

    it('reprova SPF que não autoriza nenhum remetente nosso', () => {
        expect(isAcceptableSpf('v=spf1 include:_spf.mail.hostinger.com ~all')).toBe(false)
        expect(isAcceptableSpf('v=spf1 -all')).toBe(false)
    })

    it('não confunde substring: "mx" precisa ser um termo, não parte de outro', () => {
        expect(isAcceptableSpf('v=spf1 include:mx.exemplo.com ~all')).toBe(false)
        expect(isAcceptableSpf('v=spf1 a:naomx ~all')).toBe(false)
    })

    it('ignora o que não é SPF', () => {
        expect(isAcceptableSpf('v=DKIM1; k=rsa; p=AAAA')).toBe(false)
        expect(isAcceptableSpf('google-site-verification=abc')).toBe(false)
    })
})
