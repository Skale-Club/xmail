/**
 * Warm-up content — pure functions, no I/O, no external model required.
 *
 * O conteúdo do aquecimento é o que denuncia o tráfego sintético. Ferramentas ruins mandam a mesma
 * frase milhares de vezes: o filtro aprende o padrão e passa a marcar o remetente. Aqui o texto é
 * combinatório e determinístico por semente — milhares de mensagens curtas plausíveis, sem
 * marcador, sem link, sem anexo, sem assinatura promocional, sem List-Unsubscribe (é correspondência
 * pessoa-a-pessoa, não campanha).
 *
 * `generateWarmupContent` aceita um gerador externo opcional (LLM) via `overrideBody`, para quando
 * houver chave configurada. O padrão combinatório existe para o motor funcionar sem custo nenhum.
 */

import { hashFraction } from './plan'

const OPENERS = [
    'Passando pra alinhar rapidinho',
    'Só um retorno rápido',
    'Consegui olhar aquilo hoje',
    'Anotando aqui antes que eu esqueça',
    'Segue o combinado',
    'Voltando nesse ponto',
    'Aproveitando que lembrei',
    'Resumo do que ficou',
]

const SUBJECTS = [
    'ponto rápido',
    'retorno',
    'aquele assunto',
    'resumo da conversa',
    'próximos passos',
    'alinhamento',
    'follow-up interno',
    'notas da semana',
    'material que comentei',
    'agenda',
]

const BODIES = [
    'Fechei a primeira versão e deixei separado. Se fizer sentido, sigo com o restante amanhã.',
    'Revisei os números e bate com o que a gente tinha estimado. Nada fora do previsto até aqui.',
    'Consegui adiantar metade. O resto depende de uma confirmação que peço ainda hoje.',
    'Deixei anotado o que ficou pendente para não perder na próxima rodada.',
    'Testei do meu lado e funcionou sem ajuste. Vou repetir amanhã para ter certeza.',
    'Separei os pontos principais e tirei o que não era prioridade agora.',
    'Ajustei conforme conversamos. Qualquer coisa diferente do esperado eu aviso.',
    'A parte mais demorada já saiu; o que sobrou é rápido.',
    'Comparei com a versão anterior e a diferença é pequena, mas vale registrar.',
    'Vou consolidar tudo e mando o fechamento no fim da semana.',
]

const CLOSERS = [
    'Qualquer coisa me chama.',
    'Se precisar de mais detalhe, é só falar.',
    'Depois me diz o que achou.',
    'Sem urgência.',
    'Te atualizo assim que avançar.',
    'Obrigado!',
]

const REPLIES = [
    'Perfeito, obrigado por adiantar.',
    'Recebido. Vou olhar com calma e te retorno.',
    'Show, era isso mesmo que eu precisava.',
    'Fechado. Pode seguir assim.',
    'Boa, obrigado pelo resumo.',
    'Anotado aqui. Seguimos.',
]

export interface WarmupContent {
    subject: string
    text: string
}

function pick<T>(items: T[], seed: string, salt: string): T {
    return items[Math.floor(hashFraction(`${seed}:${salt}`) * items.length) % items.length]
}

/**
 * Mensagem curta de aquecimento. `seed` deve ser único por mensagem (usamos o Message-ID), de modo
 * que reenviar a mesma mensagem reproduz o mesmo texto, mas duas mensagens nunca coincidem por
 * acaso.
 */
export function generateWarmupContent(seed: string, overrideBody?: string): WarmupContent {
    const subject = pick(SUBJECTS, seed, 'subject')
    const opener = pick(OPENERS, seed, 'opener')
    const body = overrideBody?.trim() || pick(BODIES, seed, 'body')
    const closer = pick(CLOSERS, seed, 'closer')
    return {
        subject,
        text: `${opener}.\n\n${body}\n\n${closer}\n`,
    }
}

/** Resposta em thread. Curta de propósito: resposta longa demais é o que ninguém escreve. */
export function generateWarmupReply(seed: string, overrideBody?: string): WarmupContent {
    return {
        subject: '',
        text: `${overrideBody?.trim() || pick(REPLIES, seed, 'reply')}\n`,
    }
}

/**
 * Assunto da resposta a partir do original, sem empilhar prefixos ("Re: Re: Re:" é assinatura de
 * automação boba).
 */
export function replySubject(originalSubject: string): string {
    const trimmed = originalSubject.trim()
    return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
}
