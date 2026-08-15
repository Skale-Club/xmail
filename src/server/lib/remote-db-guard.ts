/**
 * Impede que um servidor de desenvolvimento escreva no banco de PRODUÇÃO.
 *
 * O incidente (2026-08-15): alguém rodou `npm run dev:server` com um `.env` cujo `DATABASE_URL`
 * apontava para produção. O servidor subiu normalmente e cadastrou as cinco caixas SMTP de
 * outreach — cifrando as senhas com o `OUTLOOK_TOKEN_ENCRYPTION_KEY` do `.env` LOCAL. Produção,
 * que tem outra chave, não conseguia decifrá-las. Ninguém percebeu por dias, porque o dado só
 * falha no momento do uso: o mesh de warm-up morria em toda tentativa de envio com
 * `Unsupported state or unable to authenticate data`, e de fora parecia um job ocioso.
 *
 * Aviso não resolveria: um log de startup entre dezenas de linhas é exatamente o que já foi
 * ignorado. Por isso o processo **recusa subir**. É reversível numa variável de ambiente para
 * quem realmente precisa (debug contra prod acontece), mas exige a decisão explícita — que é
 * justamente o que faltou.
 *
 * Escopo deliberado: só o servidor. Scripts pontuais contra produção (`db:studio`, os runners de
 * migration, consultas de diagnóstico) continuam livres — eles não cadastram credencial, que é o
 * dado que quebra em silêncio.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'db', 'postgres', 'host.docker.internal'])

export const ALLOW_REMOTE_DB_ENV = 'XMAIL_ALLOW_REMOTE_DB'

export interface RemoteDbGuardInput {
    databaseUrl: string | undefined
    nodeEnv: string | undefined
    allowRemote: string | undefined
}

/** Extrai o host sem depender de a URL ser perfeitamente bem formada. */
export function hostOfDatabaseUrl(databaseUrl: string | undefined): string | null {
    if (!databaseUrl) return null
    try {
        const host = new URL(databaseUrl).hostname.trim().toLowerCase()
        return host.length > 0 ? host : null
    } catch {
        return null
    }
}

export function isLocalDatabaseHost(host: string | null): boolean {
    if (!host) return false
    return LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.localhost')
}

/**
 * Devolve a mensagem de recusa, ou `null` quando pode seguir.
 *
 * Só bloqueia fora de produção: em produção o banco remoto é o esperado. Host desconhecido ou URL
 * ilegível **não** bloqueia — falhar por não conseguir parsear seria pior que o problema, e a
 * ausência de `DATABASE_URL` já é tratada em `db/index.ts`.
 */
export function checkRemoteDbGuard(input: RemoteDbGuardInput): string | null {
    if (input.nodeEnv === 'production') return null
    if (input.allowRemote === 'true') return null

    const host = hostOfDatabaseUrl(input.databaseUrl)
    if (host === null) return null
    if (isLocalDatabaseHost(host)) return null

    return `Refusing to start: NODE_ENV is "${input.nodeEnv ?? 'undefined'}" but DATABASE_URL points at the remote host "${host}".\n`
        + '\n'
        + 'A dev server against the production database once wrote the outreach mailbox credentials\n'
        + 'encrypted with the LOCAL OUTLOOK_TOKEN_ENCRYPTION_KEY. Production could not decrypt them,\n'
        + 'and the failure only surfaced days later, at send time.\n'
        + '\n'
        + `If this is deliberate, set ${ALLOW_REMOTE_DB_ENV}=true. Be aware that anything this server\n`
        + 'encrypts will only ever be readable with the key in THIS environment.'
}
