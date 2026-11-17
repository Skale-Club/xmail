/** Pure formatting for the operations channel only. Input HTML is already
 * escaped by the existing callers; preserve that boundary and diagnostic data. */
const titles: Array<[string, string]> = [
    ['Xmail crashed', 'Processo interrompido'],
    ['Xmail: unhandled promise rejection', 'Promessa rejeitada sem tratamento'],
    ['Xmail: mail servers did NOT start', 'Servidores de e-mail não iniciaram'],
    ['Xmail cannot reach its database', 'Banco de dados inacessível'],
    ['Xmail can reach its database again', 'Banco de dados recuperado'],
    ['Xmail is restarting itself', 'Reinício automático em andamento'],
    ['Xmail outbound queue is stalled', 'Fila de envio parada'],
    ['Xmail outbound queue is draining again', 'Fila de envio recuperada'],
    ['Xmail memory is high', 'Uso elevado de memória'],
    ['Xmail memory is back to normal', 'Memória normalizada'],
    ['Xmail disk is filling up', 'Disco próximo do limite'],
    ['Xmail disk usage is back to normal', 'Uso de disco normalizado'],
    ['Outreach silence cleared:', 'Silêncio de outreach resolvido:'],
    ['Outreach silence:', 'Silêncio de outreach:'],
    ['Xmail error spike', 'Pico de erros'],
]

export function formatOpsMessage(title: string, body = ''): string {
    // Existing callers explicitly distinguish warning/critical silence and
    // recovery with these icons. Never infer recovery from provider error text.
    const severity = /✅|🟢/.test(title) ? '🟢 Resolvido'
        : /⚠️|🔇|🧠|💾|🐌|🟠/.test(title) ? '🟠 Atenção'
        : /🚨|💥|🛑|🔥|📮|🔴/.test(title) ? '🔴 Crítico'
        : '🔵 Informação'
    let heading = title.replace(/^.*?<b>/, '').replace(/<\/b>$/, '')
    for (const [source, translated] of titles) heading = heading.replace(source, translated)
    heading = heading.replace(/^Xmail[: ]*/, '')
    const facts = body
        .replace(/<b>Last error:<\/b>/g, '<b>Último erro:</b>')
        .replace(/<b>Error:<\/b>/g, '<b>Erro:</b>')
        .replace(/^Most frequent:$/gm, 'Mais frequentes:')
        .replace('<i>The process is exiting; Docker will restart it. If the external uptime probe stays green, the restart worked.</i>', '<i>O processo será encerrado; o Docker tentará reiniciá-lo. Confirme a recuperação pela sonda externa.</i>')
        .replace('<i>The process is still running, in an unknown state. Nothing else would have reported this.</i>', '<i>O processo continua ativo em estado desconhecido. Investigue a falha.</i>')
        .replace('SMTP (587), IMAP (993) and/or MX (25) failed to bind.', 'Falha ao iniciar SMTP (587), IMAP (993) e/ou MX (25).')
        .replace('<i>The HTTP app on :9001 is still up, so the uptime probe will stay green. Mail is not being received or sent.</i>', '<i>A aplicação HTTP em :9001 continua ativa, mas o envio e recebimento de e-mails estão afetados.</i>')
        .replace(/^(<b>\d+<\/b>) message\(s\) have been waiting longer than (\d+) minutes\.$/gm, '$1 mensagem(ns) aguardam há mais de $2 minutos.')
        .replace(/^Resident set size is (<b>\d+ MB<\/b>) \(threshold (\d+) MB\)\.$/gm, 'Memória RSS: $1 (limite $2 MB).')
        .replace(/^Resident set size is (\d+) MB\.$/gm, 'Memória RSS: $1 MB.')
        .replace(/^Filesystem at (<b>\d+%<\/b>) \(threshold (\d+)%\)\.$/gm, 'Uso de disco: $1 (limite $2%).')
        .replace(/^Filesystem at (\d+)%\.$/gm, 'Uso de disco: $1%.')
        .replace(/^Queries were failing or hanging for ([^<]+)\.$/gm, 'Consultas falharam ou ficaram sem resposta por $1.')
        .replace(/^The database has been unreachable for (<b>[^<]+<\/b>) \((\d+) consecutive failed probes\)\.$/gm, 'Banco de dados inacessível há $1 ($2 sondas consecutivas falharam).')
        .replace(/^No messages older than the stall window remain\.$/gm, 'Nenhuma mensagem excede a janela de atraso.')
        .replace(/^This condition is no longer present\.$/gm, 'Esta condição não está mais presente.')
        .replace(/<i>Recovered after ([^<]+)\.<\/i>/g, '<i>Recuperado após $1.</i>')
        .replace(/<i>Still failing after ([^<]+) — (\d+) occurrences since the first alert\.<\/i>/g, '<i>Falha persiste há $1 — $2 ocorrências desde o primeiro alerta.</i>')
        .replace(/^(\d+) errors in (\d+) minutes \(threshold (\d+)\)\.$/gm, '$1 erros em $2 minutos (limite $3).')
        .replace(/<i>Quiet for the next (\d+) minutes unless a fresh burst starts\.<\/i>/g, '<i>Silenciado pelos próximos $1 minutos, salvo novo pico.</i>')
    return `${severity} | <b>Xmail — ${heading}</b>${facts ? `\n\n${facts}` : ''}`
}
