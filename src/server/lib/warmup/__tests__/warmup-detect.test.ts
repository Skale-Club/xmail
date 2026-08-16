/**
 * O groom localiza a cópia entregue por duas chaves. Estes testes travam o caso que ficou
 * cego em produção (2026-08-16): o relay Brevo reescreve o Message-ID das caixas nativas, então
 * a busca por header nunca acha e a mensagem fica em `sent` — 100% do tráfego native→Gmail,
 * inclusive o que caiu em Spam sem resgate. A chave 2 (envelope) precisa achar essa cópia SEM
 * confundir com a resposta em thread ("Re: …") nem com a mensagem do dia anterior de mesmo
 * assunto.
 */
import { describe, expect, it } from 'vitest'
import {
    DETECTION_WINDOW_AFTER_MS,
    DETECTION_WINDOW_BEFORE_MS,
    matchesByEnvelope,
    matchesByMessageId,
    normalizeAddress,
    normalizeMessageId,
    normalizeSubject,
    pickDeliveredCopy,
    type DeliveredCandidate,
    type ExpectedDelivery,
} from '../detect'

const sentAt = new Date('2026-08-16T11:00:10Z')
const expected: ExpectedDelivery = {
    fromAddress: 'info@skale.club',
    subject: 'notas da semana',
    sentAt,
    messageId: 'w.6ac4528d-ae68-4ffb-9154-2725df190e12@skale.club',
}

function candidate(overrides: Partial<DeliveredCandidate> = {}): DeliveredCandidate {
    return {
        fromAddress: 'info@skale.club',
        subject: 'notas da semana',
        date: new Date('2026-08-16T11:00:09Z'),
        messageId: '<f494ab3a-6020-4a2f-ad51-74df7b1ae72a@smtp-relay.sendinblue.com>',
        ...overrides,
    }
}

describe('normalização', () => {
    it('Message-ID ignora colchetes e caixa', () => {
        expect(normalizeMessageId('<W.abc@Skale.club>')).toBe('w.abc@skale.club')
        expect(normalizeMessageId(undefined)).toBe('')
    })
    it('endereço aceita a forma "Nome <a@b>"', () => {
        expect(normalizeAddress('Info Skale <Info@Skale.club>')).toBe('info@skale.club')
        expect(normalizeAddress('  info@skale.club ')).toBe('info@skale.club')
    })
    it('assunto colapsa espaços e caixa', () => {
        expect(normalizeSubject('  Notas   da semana ')).toBe('notas da semana')
    })
})

describe('chave 1 — Message-ID', () => {
    it('casa quando o id sobreviveu, com ou sem colchetes', () => {
        expect(matchesByMessageId(candidate({ messageId: `<${expected.messageId}>` }), expected)).toBe(true)
        expect(matchesByMessageId(candidate({ messageId: expected.messageId }), expected)).toBe(true)
    })
    it('não casa com o id reescrito pelo relay', () => {
        expect(matchesByMessageId(candidate(), expected)).toBe(false)
    })
})

describe('chave 2 — envelope', () => {
    it('casa a cópia reescrita pelo relay: mesmo remetente, assunto e janela', () => {
        expect(matchesByEnvelope(candidate(), expected)).toBe(true)
    })
    it('não confunde a resposta em thread ("Re: …") com a original', () => {
        expect(matchesByEnvelope(candidate({ subject: 'Re: notas da semana' }), expected)).toBe(false)
    })
    it('não casa outro remetente com o mesmo assunto', () => {
        expect(matchesByEnvelope(candidate({ fromAddress: 'info@xkedule.com' }), expected)).toBe(false)
    })
    it('não casa a mensagem de ontem com o mesmo assunto', () => {
        const yesterday = new Date(sentAt.getTime() - 24 * 60 * 60 * 1000 - 60_000)
        expect(matchesByEnvelope(candidate({ date: yesterday }), expected)).toBe(false)
    })
    it('tolera relógio um pouco adiantado e entrega atrasada (greylist/relay)', () => {
        expect(matchesByEnvelope(candidate({ date: new Date(sentAt.getTime() - DETECTION_WINDOW_BEFORE_MS + 1) }), expected)).toBe(true)
        expect(matchesByEnvelope(candidate({ date: new Date(sentAt.getTime() + DETECTION_WINDOW_AFTER_MS - 1) }), expected)).toBe(true)
        expect(matchesByEnvelope(candidate({ date: new Date(sentAt.getTime() - DETECTION_WINDOW_BEFORE_MS - 1) }), expected)).toBe(false)
    })
    it('exige data válida', () => {
        expect(matchesByEnvelope(candidate({ date: null }), expected)).toBe(false)
        expect(matchesByEnvelope(candidate({ date: new Date('nope') }), expected)).toBe(false)
    })
})

describe('pickDeliveredCopy', () => {
    it('prefere o Message-ID exato mesmo se outro candidato casar por envelope', () => {
        const byEnvelope = candidate()
        const byId = candidate({ messageId: `<${expected.messageId}>`, subject: 'outro assunto', date: null })
        expect(pickDeliveredCopy([byEnvelope, byId], expected)).toBe(byId)
    })
    it('sem id, escolhe o candidato de envelope com Date mais próximo do envio', () => {
        const near = candidate({ date: new Date(sentAt.getTime() + 5_000) })
        const far = candidate({ date: new Date(sentAt.getTime() + 3 * 60 * 60 * 1000) })
        expect(pickDeliveredCopy([far, near], expected)).toBe(near)
    })
    it('devolve null quando nada casa', () => {
        expect(pickDeliveredCopy([candidate({ subject: 'agenda' })], expected)).toBeNull()
        expect(pickDeliveredCopy([], expected)).toBeNull()
    })
})
