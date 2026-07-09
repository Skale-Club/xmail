import { sql, getTableName, type Table, type InferSelectModel } from 'drizzle-orm'
import { z } from 'zod'
import type { db as DbType } from '../../db'

// Zod schema for pagination query params
export const paginationQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
})

export interface PaginationMeta {
    page: number
    limit: number
    total: number
    totalPages: number
}

export interface PaginatedResult<T> {
    data: T[]
    pagination: PaginationMeta
}

export async function paginate<T extends Table>(
    database: typeof DbType,
    table: T,
    options: {
        where?: any
        page: number
        limit: number
        orderBy?: any
        with?: Record<string, any>
        columns?: Record<string, boolean>
    }
): Promise<PaginatedResult<InferSelectModel<T>>> {
    const { where, page, limit, orderBy, with: withRelations, columns } = options
    const offset = (page - 1) * limit

    // Count query
    const countResult = await database
        .select({ count: sql<string>`count(*)` })
        .from(table)
        .where(where)

    const total = Number(countResult[0]?.count || 0)

    // Get the query key from the table name. db.query is keyed by the schema
    // EXPORT names (camelCase, e.g. emailAccounts), not the SQL table names
    // (snake_case, e.g. email_accounts) — convert, or every multi-word table
    // crashes with "Cannot read properties of undefined (reading 'findMany')".
    const tableName = getTableName(table)
    const queryKey = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof typeof database.query

    // Data query using db.query relational API
    const data = await (database.query[queryKey] as any).findMany({
        where,
        limit,
        offset,
        orderBy,
        ...(withRelations ? { with: withRelations } : {}),
        ...(columns ? { columns } : {}),
    })

    return {
        data: data as InferSelectModel<T>[],
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    }
}
