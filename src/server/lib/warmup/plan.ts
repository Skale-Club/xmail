/**
 * Warm-up planning — pure functions, no I/O.
 *
 * Decide QUANTAS mensagens uma caixa manda hoje e PARA QUEM. Duas regras não óbvias e que são o
 * ponto inteiro do módulo:
 *
 *  1. **Volume cresce devagar e sublinearmente.** Provedor não olha só volume: olha consistência.
 *     Uma caixa nova que salta de 2 para 40 mensagens/dia parece comprometida, não popular.
 *
 *  2. **Par do mesmo domínio vale quase nada.** Cinco caixas Google Workspace no mesmo domínio
 *     trocando mensagens é um loop fechado: o tráfego provavelmente nem sai da infra do Google e
 *     não constrói reputação com ninguém. O seletor por isso prioriza destinatários de OUTRO
 *     domínio e, dentro disso, de OUTRO provedor — e só cai no mesmo domínio se não houver mais
 *     nada disponível.
 */

export interface WarmupRecipient {
    address: string
    accountId: string
    /** Domínio do destinatário, minúsculo. */
    domain: string
    /** 'gmail' | 'outlook' | 'native' | ... quando conhecido. */
    providerHint?: string
}

export interface WarmupSender {
    accountId: string
    address: string
    domain: string
    providerHint?: string
    /** Dia da rampa já cumprido (dias com envio real). */
    warmupCurrentDay: number
    warmupDays: number
    /** Quantas mensagens de aquecimento já saíram hoje. */
    warmupSentToday: number
}

/**
 * Alvo diário de mensagens de aquecimento para o dia `day` de uma rampa de `warmupDays`.
 *
 * Começa em 2/dia e cresce até 20/dia no fim da rampa, com curva côncava (raiz quadrada): o
 * crescimento é mais rápido no começo, quando o risco é baixo, e desacelera perto do teto.
 */
export function warmupDailyTarget(day: number, warmupDays: number): number {
    const total = Math.max(1, warmupDays)
    const current = Math.max(0, Math.min(day, total))
    const start = 2
    const peak = 20
    const progress = Math.sqrt(current / total)
    return Math.round(start + (peak - start) * progress)
}

/**
 * Alvo de manutenção após a rampa. Reputação não é conquista permanente: se o mesh parar no dia
 * em que a campanha começa, o provedor vê um degrau de padrão — por isso o aquecimento continua
 * em volume reduzido depois de "formado".
 */
export const WARMUP_MAINTENANCE_TARGET = 8

/** Quantas ainda faltam hoje para essa caixa. Nunca negativo. */
export function remainingWarmupQuota(sender: WarmupSender): number {
    const target = sender.warmupCurrentDay >= sender.warmupDays
        ? WARMUP_MAINTENANCE_TARGET
        : warmupDailyTarget(sender.warmupCurrentDay, sender.warmupDays)
    return Math.max(0, target - sender.warmupSentToday)
}

/**
 * Fração das mensagens recebidas que deve ser respondida. Resposta em thread é o sinal de
 * engajamento mais forte que conseguimos produzir, mas 100% de resposta é um padrão que nenhuma
 * caixa humana tem — por isso a fração e não "responder tudo".
 */
export const WARMUP_REPLY_RATE = 0.35

export function shouldReply(messageId: string, rate: number = WARMUP_REPLY_RATE): boolean {
    // Determinístico por mensagem: o mesmo id decide igual em qualquer retry, então um tick
    // repetido nunca gera uma segunda resposta para a mesma mensagem.
    return hashFraction(messageId) < rate
}

/**
 * Ordena destinatários candidatos pelo valor de reputação que entregam ao remetente.
 * Melhor primeiro: outro domínio + outro provedor > outro domínio > mesmo domínio.
 *
 * **Empate é desempatado por remetente, não pela ordem do banco.** Com um mesh de N caixas de um
 * lado e M do outro, todos os N remetentes veem os mesmos M candidatos com a mesma pontuação; sem
 * desempate, a ordenação estável faz todos escolherem o MESMO primeiro endereço, e a distribuição
 * de recebimento fica torta (uma caixa recebe tudo, as outras nada — e como quem responde é quem
 * recebe, as caixas ociosas nunca produzem o sinal de engajamento). O hash de (remetente,
 * destinatário) dá a cada remetente uma ordem própria e estável entre ticks.
 */
export function rankRecipients(sender: WarmupSender, recipients: WarmupRecipient[]): WarmupRecipient[] {
    return [...recipients]
        .filter((recipient) => recipient.address.toLowerCase() !== sender.address.toLowerCase())
        .map((recipient) => {
            const differentDomain = recipient.domain !== sender.domain
            const differentProvider = Boolean(recipient.providerHint)
                && Boolean(sender.providerHint)
                && recipient.providerHint !== sender.providerHint
            const score = (differentDomain ? 2 : 0) + (differentProvider ? 1 : 0)
            const tiebreak = hashFraction(`${sender.accountId}:${recipient.accountId}`)
            return { recipient, score, tiebreak }
        })
        .sort((a, b) => (b.score - a.score) || (a.tiebreak - b.tiebreak))
        .map((entry) => entry.recipient)
}

/**
 * Escolhe os destinatários do próximo lote, distribuindo em vez de repetir o melhor par.
 * `alreadySentToday` evita martelar o mesmo endereço várias vezes no mesmo dia.
 */
export function selectRecipients(
    sender: WarmupSender,
    recipients: WarmupRecipient[],
    count: number,
    alreadySentToday: string[] = [],
): WarmupRecipient[] {
    if (count <= 0) return []
    const sentSet = new Set(alreadySentToday.map((address) => address.toLowerCase()))
    const ranked = rankRecipients(sender, recipients)
    const fresh = ranked.filter((recipient) => !sentSet.has(recipient.address.toLowerCase()))
    // Só reutiliza um endereço já usado hoje quando não há nenhum inédito sobrando.
    const pool = fresh.length >= count ? fresh : [...fresh, ...ranked.filter((r) => sentSet.has(r.address.toLowerCase()))]
    return pool.slice(0, count)
}

/**
 * Distribui `count` envios ao longo da janela restante do dia, com espaçamento irregular.
 * Rajada é o padrão de robô; o jitter derivado do id mantém o resultado determinístico por conta.
 */
export function scheduleSendTimes(
    count: number,
    now: Date,
    windowEndHourUtc = 21,
    seed = 'warmup',
): Date[] {
    if (count <= 0) return []
    const end = new Date(now)
    end.setUTCHours(windowEndHourUtc, 0, 0, 0)
    const availableMs = end.getTime() - now.getTime()
    // Fora da janela: agenda tudo colado no próximo tick, o job decide se envia.
    if (availableMs <= 0) return Array.from({ length: count }, () => new Date(now))

    const slot = availableMs / count
    return Array.from({ length: count }, (_, index) => {
        const jitter = (hashFraction(`${seed}:${index}`) - 0.5) * slot * 0.6
        return new Date(now.getTime() + slot * index + slot * 0.5 + jitter)
    })
}

/** Hash estável em [0,1). FNV-1a — não precisa ser criptográfico, precisa ser reprodutível. */
export function hashFraction(value: string): number {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return ((hash >>> 0) % 100000) / 100000
}
