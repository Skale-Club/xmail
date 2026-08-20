/**
 * Estes alertas existem porque, em 2026-08-15, sete defeitos foram encontrados de uma vez e
 * NENHUM teria disparado um alerta existente. Cada caso abaixo reproduz um defeito real daquele
 * dia e exige que ele agora seja percebido — e, igualmente importante, que a operação normal
 * continue silenciosa, senão o alerta vira ruído e é ignorado quando importar.
 */
import { describe, expect, it } from 'vitest'
import { buildSilenceAlerts, type SilenceMetrics } from '../outreach-silence'

const NOW = new Date('2026-08-15T15:00:00Z')

function metrics(overrides: Partial<SilenceMetrics> = {}): SilenceMetrics {
    return {
        warmupEligibleInboxes: 7,
        warmupSends24h: 12,
        credentialKeyMismatches24h: 0,
        enrichedRunsWithoutLeads: 0,
        enrichedRunsWithoutEnrichmentCount: 0,
        doubleEncodedJsonbColumns: [],
        staleAdvisoryLocks: [],
        ...overrides,
    }
}

const kinds = (m: SilenceMetrics) => buildSilenceAlerts(m, NOW).map((a) => a.kind)

describe('sistema saudável', () => {
    it('não emite alerta nenhum', () => {
        expect(buildSilenceAlerts(metrics(), NOW)).toEqual([])
    })
})

describe('mesh de warm-up parado', () => {
    it('alerta como crítico quando há participantes e zero envios', () => {
        // O defeito real: a fase SEND morria no primeiro remetente a cada tick, e de fora o job
        // parecia apenas ocioso. Sem o mesh a rampa não anda e nenhuma campanha ativa.
        const alerts = buildSilenceAlerts(metrics({ warmupSends24h: 0 }), NOW)
        expect(alerts).toHaveLength(1)
        expect(alerts[0]).toMatchObject({ severity: 'critical', kind: 'warmup_mesh_silent' })
        expect(alerts[0].message).toContain('7 eligible inboxes')
    })

    it('fica calado com menos de dois participantes — zero envios é o correto', () => {
        // Sem par possível, silêncio não é defeito. Alertar aqui treinaria o operador a ignorar.
        expect(kinds(metrics({ warmupEligibleInboxes: 1, warmupSends24h: 0 }))).toEqual([])
        expect(kinds(metrics({ warmupEligibleInboxes: 0, warmupSends24h: 0 }))).toEqual([])
    })

    it('fica calado quando o mesh está enviando', () => {
        expect(kinds(metrics({ warmupSends24h: 1 }))).toEqual([])
    })
})

describe('credencial cifrada com outra chave', () => {
    it('alerta como crítico', () => {
        // O defeito real: um servidor de desenvolvimento apontado para o banco de produção gravou
        // as credenciais SMTP com a chave do .env local, e produção não conseguia decifrá-las.
        const alerts = buildSilenceAlerts(metrics({ credentialKeyMismatches24h: 5 }), NOW)
        expect(alerts[0]).toMatchObject({ severity: 'critical', kind: 'credential_key_mismatch' })
        expect(alerts[0].message).toContain('OUTLOOK_TOKEN_ENCRYPTION_KEY')
    })
})

describe('jsonb duplo-codificado', () => {
    it('alerta como crítico e nomeia as colunas afetadas', () => {
        // O defeito real: 373 linhas desde março, sem erro nenhum, porque o ORM desfazia a
        // codificação na leitura. Só o SQL do servidor enxergava o escalar.
        const alerts = buildSilenceAlerts(
            metrics({ doubleEncodedJsonbColumns: ['leads.custom_fields', 'mail_messages.headers'] }),
            NOW,
        )
        expect(alerts[0]).toMatchObject({ severity: 'critical', kind: 'double_encoded_jsonb' })
        expect(alerts[0].message).toContain('leads.custom_fields')
        expect(alerts[0].message).toContain('mail_messages.headers')
        // A mensagem tem que dizer o que fazer, não só que está errado.
        expect(alerts[0].message).toContain('jsonbParam')
    })
})

describe('lock advisory presa (runWithLock estourou o timeout, ou algo além dele segura a chave)', () => {
    it('alerta como crítico e nomeia o job e por quanto tempo', () => {
        // O defeito real: replies/bounces/warm-up ficaram idle in transaction por dias segurando a
        // lock advisory, e o único sintoma era a linha rotineira de "skipping".
        const alerts = buildSilenceAlerts(
            metrics({ staleAdvisoryLocks: [{ jobName: 'outreach-replies-processor', heldForSeconds: 3600 }] }),
            NOW,
        )
        expect(alerts).toHaveLength(1)
        expect(alerts[0]).toMatchObject({ severity: 'critical', kind: 'stale_advisory_lock' })
        expect(alerts[0].message).toContain('outreach-replies-processor')
        expect(alerts[0].message).toContain('60min')
    })

    it('lista mais de uma lock presa ao mesmo tempo', () => {
        const alerts = buildSilenceAlerts(
            metrics({
                staleAdvisoryLocks: [
                    { jobName: 'outreach-replies-processor', heldForSeconds: 3600 },
                    { jobName: 'warmup-mesh-processor', heldForSeconds: 120 },
                ],
            }),
            NOW,
        )
        expect(alerts[0].message).toContain('outreach-replies-processor')
        expect(alerts[0].message).toContain('warmup-mesh-processor')
    })

    it('fica calado sem lock presa', () => {
        expect(kinds(metrics({ staleAdvisoryLocks: [] }))).toEqual([])
    })
})

describe('runs enriched sem resultado', () => {
    it('avisa quando um run enriched não tem lead atribuível', () => {
        const alerts = buildSilenceAlerts(metrics({ enrichedRunsWithoutLeads: 2 }), NOW)
        expect(alerts[0]).toMatchObject({ severity: 'warning', kind: 'enriched_runs_without_leads' })
    })

    it('avisa quando enriched_count nunca é populado', () => {
        // É o contador que responde "vale a pena pagar por enriquecimento?". Zero constante é
        // indistinguível de um valor legítimo, que foi exatamente o que escondeu o problema.
        const alerts = buildSilenceAlerts(metrics({ enrichedRunsWithoutEnrichmentCount: 3 }), NOW)
        expect(alerts[0]).toMatchObject({ severity: 'warning', kind: 'enriched_count_never_populated' })
    })

    it('usa aviso e não crítico — o dado está incompleto, ninguém está sendo prejudicado agora', () => {
        const alerts = buildSilenceAlerts(
            metrics({ enrichedRunsWithoutLeads: 1, enrichedRunsWithoutEnrichmentCount: 1 }),
            NOW,
        )
        expect(alerts.every((a) => a.severity === 'warning')).toBe(true)
    })
})

describe('vários defeitos ao mesmo tempo', () => {
    it('reporta cada um separadamente, com crítico antes de aviso', () => {
        // O dia 2026-08-15 em uma linha: foi assim que o sistema realmente estava.
        const alerts = buildSilenceAlerts(metrics({
            warmupSends24h: 0,
            credentialKeyMismatches24h: 5,
            doubleEncodedJsonbColumns: ['leads.custom_fields'],
            staleAdvisoryLocks: [{ jobName: 'outreach-bounces-processor', heldForSeconds: 900 }],
            enrichedRunsWithoutLeads: 2,
            enrichedRunsWithoutEnrichmentCount: 2,
        }), NOW)

        expect(alerts.map((a) => a.kind)).toEqual([
            'warmup_mesh_silent',
            'credential_key_mismatch',
            'double_encoded_jsonb',
            'stale_advisory_lock',
            'enriched_runs_without_leads',
            'enriched_count_never_populated',
        ])
        expect(alerts.filter((a) => a.severity === 'critical')).toHaveLength(4)
        expect(alerts.every((a) => a.since === NOW.toISOString())).toBe(true)
    })
})
