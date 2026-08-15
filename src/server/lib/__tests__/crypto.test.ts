/**
 * Contrato de `crypto.ts`, escrito depois do incidente de 2026-08-15.
 *
 * As 5 caixas SMTP de outreach ficaram com senha ilegível em produção porque um servidor de
 * desenvolvimento local, apontado para o banco de produção, cifrou as credenciais com a chave do
 * `.env` local. Produção não conseguia decifrá-las e cada envio do mesh de warm-up falhava com
 * `Unsupported state or unable to authenticate data` — mensagem do Node que não nomeia a causa, não
 * diz qual registro quebrou e não sugere o que fazer.
 *
 * Duas propriedades ficam travadas aqui:
 *
 *  1. **Sem fallback para JWT_SECRET.** Era ele que permitia dois servidores cifrarem com chaves
 *     diferentes no mesmo banco sem nenhum sinal. Chave ausente tem que falhar na hora.
 *  2. **Erro nomeado para tag que não fecha.** Payload íntegro que não decifra é quase sempre chave
 *     errada, e o erro precisa dizer isso — com o registro afetado, quando o chamador informa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialKeyMismatchError, decryptSecret, encryptSecret } from '../crypto'

const KEY_A = 'key-alpha-0000000000000000000000000000'
const KEY_B = 'key-bravo-1111111111111111111111111111'

beforeEach(() => {
    vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', KEY_A)
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('crypto — ida e volta', () => {
    it('decifra o que cifrou com a mesma chave', () => {
        expect(decryptSecret(encryptSecret('senha-secreta'))).toBe('senha-secreta')
    })

    it('gera IV novo a cada chamada, então o mesmo texto não produz o mesmo payload', () => {
        expect(encryptSecret('igual')).not.toBe(encryptSecret('igual'))
    })
})

describe('crypto — sem fallback para JWT_SECRET', () => {
    it('falha quando OUTLOOK_TOKEN_ENCRYPTION_KEY está ausente, mesmo com JWT_SECRET setado', () => {
        // Exatamente o cenário que produzia bancos com credenciais em duas chaves distintas.
        vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', '')
        vi.stubEnv('JWT_SECRET', 'um-jwt-secret-perfeitamente-valido')

        expect(() => encryptSecret('x')).toThrow(/Missing OUTLOOK_TOKEN_ENCRYPTION_KEY/)
        expect(() => decryptSecret('a.b.c')).toThrow(/Missing OUTLOOK_TOKEN_ENCRYPTION_KEY/)
    })

    it('mantém a substring que mailboxes.ts usa para devolver erro estruturado', () => {
        // routes/mail/mailboxes.ts casa em 'Missing OUTLOOK_TOKEN_ENCRYPTION_KEY' para responder um
        // erro de configuração legível em vez de 500 cru. Reescrever a mensagem quebraria isso em
        // silêncio, então a dependência fica explícita aqui.
        vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', '')
        expect(() => encryptSecret('x')).toThrow(/Missing OUTLOOK_TOKEN_ENCRYPTION_KEY/)
    })
})

describe('crypto — incompatibilidade de chave', () => {
    it('lança CredentialKeyMismatchError quando o payload foi cifrado com outra chave', () => {
        const cifradoComA = encryptSecret('senha-secreta')
        vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', KEY_B)

        expect(() => decryptSecret(cifradoComA)).toThrow(CredentialKeyMismatchError)
        // O que o operador precisa ler para agir, e que a mensagem do Node não dava.
        expect(() => decryptSecret(cifradoComA)).toThrow(/encrypted with a different key/)
    })

    it('inclui o contexto do chamador para identificar o registro afetado', () => {
        const cifradoComA = encryptSecret('senha-secreta')
        vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', KEY_B)

        expect(() => decryptSecret(cifradoComA, 'smtp_password of email_account abc-123'))
            .toThrow(/smtp_password of email_account abc-123/)
    })

    it('nunca deixa vazar o texto claro na mensagem de erro', () => {
        const cifradoComA = encryptSecret('senha-ultra-secreta')
        vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', KEY_B)

        try {
            decryptSecret(cifradoComA, 'conta xyz')
            expect.unreachable('deveria ter lançado')
        } catch (err) {
            expect((err as Error).message).not.toContain('senha-ultra-secreta')
        }
    })

    it('distingue payload malformado de chave errada', () => {
        // Estrutura inválida não é problema de chave e não deve ser diagnosticada como tal.
        expect(() => decryptSecret('nao-tem-tres-partes')).toThrow(/Invalid encrypted payload/)
    })
})
