import bcrypt from 'bcrypt'
import postgres from 'postgres'
import { resolveDatabaseTarget } from '../../../db/database-target'
import { resolveDatabasePoolBudget } from '../../../db/pool-budget'
import { encryptSecret } from '../crypto'
import { createOwnedUserAdminStore } from './owned-user-admin-store'

let store: ReturnType<typeof createOwnedUserAdminStore> | undefined
export async function getOwnedUserAdminStore() {
    if (store) return store
    // Keep sensitive hash/placeholder parameters out of development query logs.
    // The existing explicit target resolver also prevents production fallback in dev.
    const target = resolveDatabaseTarget(process.env)
    const budget = resolveDatabasePoolBudget(process.env, target)
    const sql = postgres(target.databaseUrl, {
        max: budget.admin, prepare: false, connect_timeout: 5, idle_timeout: 30,
        debug: false, onnotice: () => {},
    })
    store = createOwnedUserAdminStore(sql, {
        hashPassword: password => bcrypt.hash(password, 12),
        nativeSettings: () => {
            const smtpPort = Number(process.env.SMTP_SUBMISSION_PORT || '2587')
            const imapPort = Number(process.env.IMAP_PORT || '2993')
            if (![smtpPort, imapPort].every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535)) throw new Error('Native mailbox configuration is unavailable.')
            return { host: process.env.MAIL_HOST || 'localhost', smtpPort, imapPort, placeholder: encryptSecret('__NATIVE__') }
        },
    })
    return store
}
