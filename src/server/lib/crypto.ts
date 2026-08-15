import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

/**
 * Lançado quando o payload está íntegro mas a authentication tag não fecha: quase sempre significa
 * que o dado foi cifrado com OUTRA chave, não que está corrompido.
 *
 * Existe porque o Node devolve `Unsupported state or unable to authenticate data` para esse caso —
 * uma mensagem que não nomeia a causa nem o registro afetado. Em 2026-08-15 ela apareceu no
 * `last_error` de cada envio do mesh de warm-up e não dizia nada sobre chave de criptografia.
 */
export class CredentialKeyMismatchError extends Error {
    constructor(context?: string) {
        super(
            `Stored credential could not be decrypted with the current OUTLOOK_TOKEN_ENCRYPTION_KEY${context ? ` (${context})` : ''}. ` +
            'It was almost certainly encrypted with a different key — e.g. by a dev server pointed at this database. ' +
            'Re-enter the credential through this environment, or re-encrypt it to this key.'
        )
        this.name = 'CredentialKeyMismatchError'
    }
}

/**
 * SEM fallback para JWT_SECRET, deliberadamente.
 *
 * O fallback tornava a chave de criptografia dependente de QUAL variável estava setada em cada
 * ambiente: um servidor com só JWT_SECRET cifrava com uma chave, outro com
 * OUTLOOK_TOKEN_ENCRYPTION_KEY cifrava com outra, e os dois gravavam no mesmo banco sem reclamar.
 * O dado só se revelava ilegível muito depois, no ponto de uso. Uma chave ausente precisa falhar
 * na hora, não produzir silenciosamente registros que ninguém mais consegue ler.
 */
function getEncryptionKey(): Buffer {
    const secret = process.env.OUTLOOK_TOKEN_ENCRYPTION_KEY

    if (!secret) {
        throw new Error('Missing OUTLOOK_TOKEN_ENCRYPTION_KEY')
    }

    return crypto.createHash('sha256').update(secret).digest()
}

export function encryptSecret(value: string): string {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return [
        iv.toString('base64url'),
        tag.toString('base64url'),
        encrypted.toString('base64url'),
    ].join('.')
}

export function decryptSecret(payload: string, context?: string): string {
    const [ivPart, tagPart, encryptedPart] = payload.split('.')

    if (!ivPart || !tagPart || !encryptedPart) {
        throw new Error('Invalid encrypted payload')
    }

    // getEncryptionKey() fica FORA do try: chave ausente é erro de configuração e deve subir como
    // tal — envolvê-la aqui a mascararia de incompatibilidade de chave, que é outro diagnóstico.
    const key = getEncryptionKey()

    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'))
        decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))

        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(encryptedPart, 'base64url')),
            decipher.final(),
        ])

        return decrypted.toString('utf8')
    } catch {
        throw new CredentialKeyMismatchError(context)
    }
}
