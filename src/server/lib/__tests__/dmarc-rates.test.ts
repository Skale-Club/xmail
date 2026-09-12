/**
 * Fase 1 Part A.3 — the pure arithmetic half of "did DKIM/SPF/DMARC pass, for this domain, in
 * this date range". See dmarc-rates.ts's module header for why raw pass rate and DMARC-aligned
 * pass rate are computed and reported separately.
 */
import { describe, expect, it } from 'vitest'
import { computeDmarcAuthenticationRates } from '../dmarc-rates'

describe('computeDmarcAuthenticationRates', () => {
    it('retorna null em vez de 0% quando não há mensagens reportadas', () => {
        // Zero é um valor válido (outreach-silence.ts) -- "nenhum dado ainda" não pode ler igual
        // a "0% passou". Ver DMARC_REPORT_GAP em outreach-silence.ts para o caso que isso evita.
        const rates = computeDmarcAuthenticationRates({
            totalMessages: 0,
            dkimPassMessages: 0,
            spfPassMessages: 0,
            dmarcAlignedMessages: 0,
        })
        expect(rates).toEqual({ totalMessages: 0, dkimPassRate: null, spfPassRate: null, dmarcPassRate: null })
    })

    it('calcula as três taxas de forma independente', () => {
        const rates = computeDmarcAuthenticationRates({
            totalMessages: 1000,
            dkimPassMessages: 950,
            spfPassMessages: 800,
            dmarcAlignedMessages: 970,
        })
        expect(rates.totalMessages).toBe(1000)
        expect(rates.dkimPassRate).toBeCloseTo(0.95)
        expect(rates.spfPassRate).toBeCloseTo(0.8)
        expect(rates.dmarcPassRate).toBeCloseTo(0.97)
    })

    it('dmarcPassRate pode exceder tanto dkimPassRate quanto spfPassRate (alinhamento via OR)', () => {
        // O caso que motiva separar cru de alinhado: nenhuma mensagem passou DKIM cru, todas
        // passaram SPF alinhado -- DMARC passa (RFC 7489: qualquer um dos dois mecanismos
        // alinhados basta), então dmarcPassRate = 100% mesmo com dkimPassRate = 0%.
        const rates = computeDmarcAuthenticationRates({
            totalMessages: 100,
            dkimPassMessages: 0,
            spfPassMessages: 100,
            dmarcAlignedMessages: 100,
        })
        expect(rates.dkimPassRate).toBe(0)
        expect(rates.dmarcPassRate).toBe(1)
    })

    it('dkimPassRate cru pode ser 100% com dmarcPassRate 0% -- assinatura válida, domínio errado', () => {
        // O caso oposto: um forwarder assina com SUA própria chave (auth_results/dkim passa),
        // mas o domínio assinante não alinha com header_from, então policy_evaluated/dkim falha.
        const rates = computeDmarcAuthenticationRates({
            totalMessages: 50,
            dkimPassMessages: 50,
            spfPassMessages: 0,
            dmarcAlignedMessages: 0,
        })
        expect(rates.dkimPassRate).toBe(1)
        expect(rates.dmarcPassRate).toBe(0)
    })
})
