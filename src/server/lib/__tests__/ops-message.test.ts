import { describe, expect, it } from 'vitest'
import { formatOpsMessage } from '../ops-message'

describe('operations messages', () => {
    it.each([
        ['💥 <b>Xmail crashed</b>', '🔴 Crítico', 'Processo interrompido'],
        ['🛑 <b>Xmail cannot reach its database</b>', '🔴 Crítico', 'Banco de dados inacessível'],
        ['🧠 <b>Xmail memory is high</b>', '🟠 Atenção', 'Uso elevado de memória'],
        ['⚠️ <b>Xmail: unhandled promise rejection</b>', '🟠 Atenção', 'Promessa rejeitada sem tratamento'],
        ['✅ <b>Xmail can reach its database again</b>', '🟢 Resolvido', 'Banco de dados recuperado'],
        ['Startup', '🔵 Informação', 'Startup'],
        ['🚨 <b>Outreach silence: stale</b>', '🔴 Crítico', 'Silêncio de outreach: stale'],
        ['🔇 <b>Outreach silence: stale</b>', '🟠 Atenção', 'Silêncio de outreach: stale'],
    ])('formats %s', (title, severity, heading) => {
        expect(formatOpsMessage(title, '<code>A &amp; B &lt;C&gt;</code>'))
            .toBe(`${severity} | <b>Xmail — ${heading}</b>\n\n<code>A &amp; B &lt;C&gt;</code>`)
    })
    it('translates static labels and dedupe suffixes without changing values', () => {
        expect(formatOpsMessage('✅ <b>Xmail memory is back to normal</b>', '<b>Last error:</b> token &lt;redacted&gt;\n\n<i>Recovered after 2h 3min.</i>'))
            .toContain('<b>Último erro:</b> token &lt;redacted&gt;\n\n<i>Recuperado após 2h 3min.</i>')
    })
    it('does not mistake a recovered word in diagnostics for recovery', () => {
        expect(formatOpsMessage('💥 <b>Xmail crashed</b>', 'recovered ✅')).toMatch(/^🔴 Crítico/)
    })
})
