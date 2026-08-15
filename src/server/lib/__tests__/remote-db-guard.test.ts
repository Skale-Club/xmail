/**
 * Reproduz o incidente de 2026-08-15: `npm run dev:server` com o `.env` apontando para o banco de
 * produção cadastrou as caixas SMTP de outreach cifradas com a chave LOCAL. Produção não decifrava,
 * e a falha só apareceu dias depois, no envio.
 */
import { describe, expect, it } from 'vitest'
import { checkRemoteDbGuard, hostOfDatabaseUrl, isLocalDatabaseHost } from '../remote-db-guard'

const PROD = 'postgresql://user:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
const LOCAL = 'postgresql://user:pass@localhost:5432/xmail'

describe('bloqueia dev contra banco remoto', () => {
    it('recusa quando NODE_ENV é development e o host é remoto', () => {
        const refusal = checkRemoteDbGuard({ databaseUrl: PROD, nodeEnv: 'development', allowRemote: undefined })
        expect(refusal).toBeTruthy()
        expect(refusal).toContain('aws-0-us-east-1.pooler.supabase.com')
        // A mensagem tem que dizer a saída, não só barrar.
        expect(refusal).toContain('XMAIL_ALLOW_REMOTE_DB=true')
    })

    it('recusa também quando NODE_ENV não está definido', () => {
        // O caso mais perigoso: rodar o entrypoint sem NODE_ENV nenhum.
        expect(checkRemoteDbGuard({ databaseUrl: PROD, nodeEnv: undefined, allowRemote: undefined })).toBeTruthy()
    })
})

describe('não atrapalha quem está certo', () => {
    it('libera em produção — banco remoto é o esperado lá', () => {
        expect(checkRemoteDbGuard({ databaseUrl: PROD, nodeEnv: 'production', allowRemote: undefined })).toBeNull()
    })

    it('libera dev contra banco local', () => {
        expect(checkRemoteDbGuard({ databaseUrl: LOCAL, nodeEnv: 'development', allowRemote: undefined })).toBeNull()
    })

    it('libera com o opt-in explícito', () => {
        // Debugar contra produção acontece; o que faltou no incidente foi a decisão consciente.
        expect(checkRemoteDbGuard({ databaseUrl: PROD, nodeEnv: 'development', allowRemote: 'true' })).toBeNull()
    })

    it('não bloqueia quando a URL é ilegível ou ausente', () => {
        // Falhar por não conseguir parsear seria pior que o problema; a ausência de DATABASE_URL
        // já tem tratamento próprio em db/index.ts.
        expect(checkRemoteDbGuard({ databaseUrl: undefined, nodeEnv: 'development', allowRemote: undefined })).toBeNull()
        expect(checkRemoteDbGuard({ databaseUrl: 'nao-e-url', nodeEnv: 'development', allowRemote: undefined })).toBeNull()
    })
})

describe('classificação de host', () => {
    it('reconhece os hosts locais usuais, incluindo os de container', () => {
        for (const host of ['localhost', '127.0.0.1', '::1', 'db', 'postgres', 'host.docker.internal']) {
            expect(isLocalDatabaseHost(host)).toBe(true)
        }
        expect(isLocalDatabaseHost('meu-app.local')).toBe(true)
    })

    it('trata host remoto como remoto', () => {
        expect(isLocalDatabaseHost('aws-0-us-east-1.pooler.supabase.com')).toBe(false)
        expect(isLocalDatabaseHost(null)).toBe(false)
    })

    it('extrai o host da URL', () => {
        expect(hostOfDatabaseUrl(PROD)).toBe('aws-0-us-east-1.pooler.supabase.com')
        expect(hostOfDatabaseUrl(LOCAL)).toBe('localhost')
        expect(hostOfDatabaseUrl('lixo')).toBeNull()
        expect(hostOfDatabaseUrl(undefined)).toBeNull()
    })
})
