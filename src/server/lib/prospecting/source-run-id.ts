/**
 * Normaliza a chave de atribuição de run em `leads.custom_fields`.
 *
 * `measureProspectingOutcomes` credita um lead a um run pelo caminho (b):
 *
 *     leads.custom_fields->>'source_run_id' = prospecting_runs.idempotency_key
 *
 * É o caminho REAL de produção — o xcraper descobre, o Xphere chama
 * `POST /api/outreach/leads/bulk-import` sem nunca tocar em `prospect_candidates`, e registra o run
 * à parte em `POST /external-runs`. O caminho (a), via candidatos, é o do Apollo e nunca rodou em
 * produção.
 *
 * O defeito encontrado em 2026-08-15: o Xmail espera `source_run_id`, o Xphere carimba
 * `xcraper_run_id`. Chaves diferentes, então o join nunca casa e **todo run de xcraper fica com
 * `outcome_*` zerado para sempre** — reply, bounce e unsubscribe nunca voltam para creditar o run
 * que originou o lead. Custo por resposta vira custo dividido por zero. Como o `leads.ts` só
 * PRESERVA `source_run_id` no re-import e nunca o gera, ninguém o escrevia.
 *
 * Consertar o Xphere seria o ideal, mas ele é outro sistema. O Xmail é quem sofre a consequência,
 * então é ele que passa a ser tolerante: aceita os apelidos conhecidos e, em último caso, extrai o
 * id do próprio `source` (`xcraper:<uuid>`), que já vem preenchido.
 *
 * **Primeiro toque continua valendo:** quando `source_run_id` já existe, ele vence e nada é
 * reescrito. Deixar um run posterior sobrescrever deixaria dois runs reivindicarem o mesmo humano.
 */

/** Ordem importa: o primeiro apelido presente vence. */
const ALIASES = ['source_run_id', 'xcraper_run_id', 'external_run_id', 'prospecting_run_id'] as const

/** `xcraper:d3925cef-...` → `d3925cef-...`. O prefixo é o provider, o resto é o id do run. */
const SOURCE_PATTERN = /^[a-z0-9_-]+:(.+)$/i

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function readNonEmpty(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

/**
 * Resolve o id do run de origem a partir dos custom fields e, como último recurso, do `source`.
 * Devolve null quando não há sinal — melhor não atribuir do que atribuir ao run errado.
 */
export function resolveSourceRunId(customFields: unknown, source?: string | null): string | null {
    const fields = asRecord(customFields)

    if (fields) {
        for (const alias of ALIASES) {
            const value = readNonEmpty(fields[alias])
            if (value) return value
        }
    }

    const rawSource = readNonEmpty(source)
    if (rawSource) {
        const match = SOURCE_PATTERN.exec(rawSource)
        const fromSource = match ? readNonEmpty(match[1]) : null
        if (fromSource) return fromSource
    }

    return null
}

/**
 * Devolve os custom fields com `source_run_id` carimbado quando dá para resolvê-lo.
 *
 * Idempotente e não destrutiva: se `source_run_id` já existe, o objeto volta inalterado — inclusive
 * a mesma referência, para deixar claro no call site que nada foi reescrito. Os apelidos originais
 * são preservados; o Xphere continua dono do que envia, e só ganhamos a chave canônica ao lado.
 */
export function withSourceRunId(
    customFields: unknown,
    source?: string | null,
): Record<string, unknown> | undefined {
    const fields = asRecord(customFields)

    if (fields && readNonEmpty(fields.source_run_id)) return fields

    const resolved = resolveSourceRunId(customFields, source)
    if (!resolved) return fields ?? undefined

    return { ...(fields ?? {}), source_run_id: resolved }
}
