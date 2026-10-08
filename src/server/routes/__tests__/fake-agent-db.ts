import { randomUUID } from 'node:crypto'
import { getTableName } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

/**
 * In-memory stand-in for the Drizzle `db` used by the agent-gateway route tests. No Postgres.
 *
 * It is deliberately NOT a SQL engine. It understands exactly what those routes issue:
 *   - `select(cols?).from(t).where(w).orderBy().groupBy().limit().offset().for()`
 *   - `selectDistinct`, `insert().values().onConflictDoNothing().returning()`, `update().set().where()
 *     .returning()`, `delete().where().returning()`, `query.<table>.findFirst/findMany`,
 *     `transaction`, and `execute` (answered by a per-test handler).
 *
 * What makes it useful as a tenant-isolation check: a `where` clause is rendered to SQL with
 * Drizzle's own dialect and its `col = $n`, `col in (...)`, `col is null` and `lower(col) = $n`
 * predicates are evaluated against the rows. A route that forgets its `organization_id` filter
 * therefore returns another tenant's row here, and a route that selects a column it should not
 * (a password) gets it, so the tests can fail on the real mistake.
 *
 * What it cannot prove: real SQL semantics (joins, FOR UPDATE, jsonb operators, the pooler).
 * Those need a reachable Postgres.
 */

export type Row = Record<string, any>

const dialect = new PgDialect()

export const state = {
    tables: {} as Record<string, Row[]>,
    audits: [] as Row[],
    deniedAudits: [] as Row[],
    failNextAudit: false,
    executed: [] as Array<{ sql: string; params: unknown[] }>,
    executeHandler: null as null | ((query: { sql: string; params: unknown[] }) => unknown),
    /** camelCase table name -> unique column sets, for onConflictDoNothing. */
    uniques: {} as Record<string, string[][]>,
    sqlSets: [] as Row[],
}

const camel = (value: string) => value.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
const tableKey = (table: unknown) => camel(getTableName(table as never))

export function reset(tables: Record<string, Row[]>, uniques: Record<string, string[][]> = {}) {
    state.tables = tables
    state.audits = []
    state.deniedAudits = []
    state.failNextAudit = false
    state.executed = []
    state.executeHandler = null
    state.uniques = uniques
    state.sqlSets = []
}

export function rows(name: string): Row[] {
    return (state.tables[name] ??= [])
}

const clone = <T,>(value: T): T => structuredClone(value)

interface Predicate { column: string; test: (value: unknown) => boolean }

function predicatesOf(where: unknown): Predicate[] {
    if (!where) return []
    const query = dialect.sqlToQuery(where as never)
    const text = query.sql
    const params = query.params
    const out: Predicate[] = []
    const paramAt = (token: string) => params[Number(token.slice(1)) - 1]
    for (const match of text.matchAll(/(lower\()?"\w+"\."(\w+)"\)? = (\$\d+)/g)) {
        const wanted = paramAt(match[3])
        const lowered = Boolean(match[1])
        out.push({
            column: camel(match[2]),
            test: (value) => (lowered ? String(value ?? '').toLowerCase() === String(wanted).toLowerCase() : String(value) === String(wanted)),
        })
    }
    for (const match of text.matchAll(/"\w+"\."(\w+)" in \(([^)]*)\)/g)) {
        const wanted = new Set(match[2].split(',').map((token) => String(paramAt(token.trim()))))
        out.push({ column: camel(match[1]), test: (value) => wanted.has(String(value)) })
    }
    for (const match of text.matchAll(/"\w+"\."(\w+)" is null/g)) {
        out.push({ column: camel(match[1]), test: (value) => value === null || value === undefined })
    }
    for (const match of text.matchAll(/"\w+"\."(\w+)" is not null/g)) {
        out.push({ column: camel(match[1]), test: (value) => value !== null && value !== undefined })
    }
    return out
}

export function matches(where: unknown, row: Row): boolean {
    return predicatesOf(where).every((predicate) => predicate.column in row && predicate.test(row[predicate.column]))
}

const isSql = (value: unknown) => Boolean(value) && typeof value === 'object' && 'queryChunks' in (value as object)
const isColumn = (value: unknown) => Boolean(value) && typeof value === 'object' && 'name' in (value as object) && 'table' in (value as object)

function project(source: Row[], cols: Record<string, unknown> | undefined, groupBy: unknown[]): Row[] {
    if (!cols) return source.map(clone)
    const entries = Object.entries(cols)
    const sqlKeys = entries.filter(([, value]) => isSql(value)).map(([key]) => key)
    const columnEntries = entries.filter(([, value]) => isColumn(value)) as Array<[string, { name: string }]>
    if (sqlKeys.length > 0) {
        // Aggregate select: count(*) per group (or one row for the whole set).
        const groups = new Map<string, Row[]>()
        const groupColumns = groupBy.filter(isColumn) as Array<{ name: string }>
        for (const row of source) {
            const key = groupColumns.map((column) => String(row[camel(column.name)])).join('|')
            groups.set(key, [...(groups.get(key) ?? []), row])
        }
        if (groupColumns.length === 0) groups.set('', source)
        return [...groups.values()].map((group) => {
            const out: Row = {}
            for (const [key, column] of columnEntries) out[key] = group[0]?.[camel(column.name)] ?? null
            for (const key of sqlKeys) out[key] = group.length
            return out
        })
    }
    return source.map((row) => Object.fromEntries(columnEntries.map(([key, column]) => [key, clone(row[camel(column.name)] ?? null)])))
}

function selectBuilder(cols: Record<string, unknown> | undefined) {
    let source: Row[] = []
    let where: unknown
    let limit: number | undefined
    let offset = 0
    let group: unknown[] = []
    const builder: any = {
        from(table: unknown) {
            source = rows(tableKey(table))
            return builder
        },
        where(value: unknown) { where = value; return builder },
        orderBy() { return builder },
        groupBy(...columns: unknown[]) { group = columns; return builder },
        limit(value: number) { limit = value; return builder },
        offset(value: number) { offset = value; return builder },
        for() { return builder },
        then(resolve: (value: Row[]) => unknown, reject: (reason: unknown) => unknown) {
            try {
                const filtered = source.filter((row) => matches(where, row))
                const shaped = project(filtered, cols, group)
                const paged = cols && Object.values(cols).some(isSql) ? shaped : shaped.slice(offset, limit === undefined ? undefined : offset + limit)
                return Promise.resolve(paged).then(resolve, reject)
            } catch (error) {
                return Promise.reject(error).then(resolve, reject)
            }
        },
    }
    return builder
}

function insertBuilder(table: unknown) {
    const key = tableKey(table)
    let incoming: Row[] = []
    let skipOnConflict = false
    const builder: any = {
        values(value: Row | Row[]) { incoming = Array.isArray(value) ? value : [value]; return builder },
        onConflictDoNothing() { skipOnConflict = true; return builder },
        returning(cols?: Record<string, unknown>) {
            const inserted: Row[] = []
            for (const value of incoming) {
                const row: Row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...clone(value) }
                const conflicts = (state.uniques[key] ?? []).some((columns) => rows(key).some((existing) => columns.every((column) => (
                    existing[column] !== undefined && existing[column] !== null && existing[column] === row[column]
                ))))
                if (conflicts && skipOnConflict) continue
                rows(key).push(row)
                inserted.push(row)
            }
            return Promise.resolve(project(inserted, cols, []))
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
            return builder.returning().then(resolve, reject)
        },
    }
    return builder
}

function updateBuilder(table: unknown) {
    const key = tableKey(table)
    let values: Row = {}
    let where: unknown
    const run = () => {
        const touched: Row[] = []
        for (const row of rows(key)) {
            if (!matches(where, row)) continue
            const plain: Row = {}
            for (const [column, value] of Object.entries(values)) {
                if (isSql(value)) state.sqlSets.push({ table: key, column })
                else plain[column] = value
            }
            Object.assign(row, plain)
            touched.push(row)
        }
        return touched
    }
    const builder: any = {
        set(value: Row) { values = value; return builder },
        where(value: unknown) { where = value; return builder },
        returning(cols?: Record<string, unknown>) { return Promise.resolve(project(run(), cols, [])) },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
            return Promise.resolve(run()).then(resolve, reject)
        },
    }
    return builder
}

function deleteBuilder(table: unknown) {
    const key = tableKey(table)
    let where: unknown
    const run = () => {
        const removed = rows(key).filter((row) => matches(where, row))
        state.tables[key] = rows(key).filter((row) => !removed.includes(row))
        return removed
    }
    const builder: any = {
        where(value: unknown) { where = value; return builder },
        returning() { return Promise.resolve(run().map(clone)) },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
            return Promise.resolve(run()).then(resolve, reject)
        },
    }
    return builder
}

type Relations = Record<string, (row: Row) => Row[]>

function queryApi(name: string) {
    const attach = (row: Row, withSpec: Record<string, unknown> | undefined): Row => {
        const out = clone(row)
        if (name === 'sequences' && withSpec?.steps) {
            out.steps = clone(rows('sequenceSteps')
                .filter((step) => step.sequenceId === row.id)
                .sort((a, b) => a.stepOrder - b.stepOrder))
        }
        return out
    }
    return {
        findFirst: async (options: { where?: unknown; with?: Record<string, unknown> } = {}) => {
            const found = rows(name).find((row) => matches(options.where, row))
            return found ? attach(found, options.with) : undefined
        },
        findMany: async (options: { where?: unknown; with?: Record<string, unknown>; limit?: number } = {}) => {
            const found = rows(name).filter((row) => matches(options.where, row))
            return found.slice(0, options.limit).map((row) => attach(row, options.with))
        },
    }
}
export type { Relations }

function makeDb() {
    const api: any = {
        select: (cols?: Record<string, unknown>) => selectBuilder(cols),
        selectDistinct: (cols?: Record<string, unknown>) => selectBuilder(cols),
        insert: insertBuilder,
        update: updateBuilder,
        delete: deleteBuilder,
        query: new Proxy({}, { get: (_target, name: string) => queryApi(name) }),
        execute: async (query: unknown) => {
            const rendered = dialect.sqlToQuery(query as never)
            state.executed.push({ sql: rendered.sql, params: rendered.params })
            if (!state.executeHandler) throw new Error('execute() called without a test handler')
            return state.executeHandler(rendered)
        },
        transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
            const snapshot = clone(state.tables)
            const auditCount = state.audits.length
            try {
                // A distinct handle, so a test can tell an audit written THROUGH the transaction
                // (executor.isTransaction) from one written on the shared connection.
                const tx = Object.assign(Object.create(api), { isTransaction: true })
                return await callback(tx)
            } catch (error) {
                state.tables = snapshot
                state.audits.length = auditCount
                throw error
            }
        },
    }
    return api
}

export const fakeDb = makeDb()

/** `writeAgentAudit` stand-in: records the call, keeps the executor, and can be told to fail once. */
export async function recordAudit(input: Row): Promise<void> {
    if (input.outcome === 'denied') {
        state.deniedAudits.push(input)
        return
    }
    if (state.failNextAudit) {
        state.failNextAudit = false
        throw new Error('audit insert failed')
    }
    state.audits.push({ ...input, createdAt: new Date() })
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing shared by the route tests
// ---------------------------------------------------------------------------------------------

export interface TestServer {
    baseUrl: string
    close: () => Promise<void>
    call: (method: string, pathname: string, body?: unknown) => Promise<{ status: number; body: any }>
}

export async function startServer(router: unknown): Promise<TestServer> {
    const { default: express } = await import('express')
    const { createServer } = await import('node:http')
    const app = express()
    app.use(express.json())
    app.use('/', router as never)
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${port}`
    return {
        baseUrl,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
        call: async (method, pathname, body) => {
            const response = await fetch(`${baseUrl}${pathname}`, {
                method,
                headers: body === undefined ? undefined : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
            const text = await response.text()
            let parsed: any = null
            try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
            return { status: response.status, body: parsed }
        },
    }
}
