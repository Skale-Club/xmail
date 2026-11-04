import { describe, expect, it } from 'vitest'
import { resolveDatabasePoolBudget as budget } from './pool-budget'

const legacy = { databaseUrl: 'postgres://postgres.source:fixture@source.invalid/postgres', jobDatabaseUrl: 'postgres://postgres.source:fixture@session.invalid/postgres' }
const owned = { databaseUrl: 'postgres://xmail_runtime:fixture@private-db:5432/xmail' }
describe('declared database pool budget (offline; no connection or dotenv)', () => {
    it('preserves existing legacy pool defaults without enforcing a new production limit', () => {
        expect(budget({}, legacy)).toMatchObject({ http: 20, jobs: 12, admin: 2, perProcess: 34, enforced: false })
    })
    it('refuses the unsafe default34 plus reserve against the prepared private role limit20', () => {
        expect(() => budget({}, owned)).toThrow('exceed')
        expect(() => budget({ XMAIL_BROWSER_AUTH_AUTHORITY: 'owned' }, legacy)).toThrow('exceed')
    })
    it('admits an explicit single-process18 plus reserved2 declaration without reducing job defaults silently', () => {
        expect(budget({ DB_POOL_MAX: '4' }, owned)).toMatchObject({ http: 4, jobs: 12, admin: 2, total: 20, roleLimit: 20, processes: 1, enforced: true })
    })
    it('counts rollout overlap instead of pretending two full processes fit one role', () => {
        expect(() => budget({ DB_POOL_MAX: '4', XMAIL_DB_PROCESS_COUNT: '2' }, owned)).toThrow('exceed')
    })
    it('supports reviewed explicit job/admin sizes and a lower declared role limit', () => {
        expect(budget({ DB_POOL_MAX: '3', DB_JOB_POOL_MAX: '10', XMAIL_ADMIN_DB_POOL_MAX: '1', XMAIL_DB_ROLE_CONNECTION_LIMIT: '16' }, owned)).toMatchObject({ total: 16, enforced: true })
    })
    it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '20x', '99999999999999999999'])('rejects malformed HTTP pool size %s', value => {
        expect(() => budget({ DB_POOL_MAX: value }, legacy)).toThrow('Invalid DB_POOL_MAX')
    })
    it('does not let a larger environment number override the prepared role ceiling or remove reserve', () => {
        expect(() => budget({ DB_POOL_MAX: '4', XMAIL_DB_ROLE_CONNECTION_LIMIT: '100' }, owned)).toThrow('Invalid')
        expect(() => budget({ DB_POOL_MAX: '4', XMAIL_DB_CONNECTION_RESERVE: '0' }, owned)).toThrow('Invalid')
        expect(() => budget({ DB_POOL_MAX: '4', XMAIL_ADMIN_DB_POOL_MAX: '3' }, owned)).toThrow('Invalid')
    })
    it('refuses a private HTTP target with legacy job fallback or a different database/role/port', () => {
        for (const jobDatabaseUrl of [legacy.databaseUrl, 'postgres://xmail_runtime:fixture@other-db/xmail',
            'postgres://xmail_runtime:fixture@private-db/other', 'postgres://xmail_runtime:fixture@private-db:6543/xmail']) {
            expect(() => budget({ DB_POOL_MAX: '4' }, { ...owned, jobDatabaseUrl })).toThrow('same reviewed database and role')
        }
        expect(() => budget({ DB_POOL_MAX: '4' }, { ...owned, jobDatabaseUrl: owned.databaseUrl + '?user=other-role' })).toThrow('same reviewed database and role')
    })
    it('accepts matching private targets with default port while never exposing credentials in refusals', () => {
        expect(budget({ DB_POOL_MAX: '4' }, { ...owned, jobDatabaseUrl: 'postgres://xmail_runtime:different-fixture@private-db/xmail' }).enforced).toBe(true)
        try { budget({}, owned) } catch (error) { expect(String(error)).not.toMatch(/fixture|postgres:\/\/|private-db/) }
    })
})
