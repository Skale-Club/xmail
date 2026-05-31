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
        // drizzle 0.45's `.from()` rejects a bare generic `T extends Table`
        // (TableLikeHasEmptySelection guard). Cast is type-only; the real
        // table object is passed at runtime. Matches the `as any` on the
        // relational query below.
        .from(table as any)
        .where(where)

    const total = Number(countResult[0]?.count || 0)

    // Get the query key from the table name
    const tableName = getTableName(table)
    const queryKey = tableName as keyof typeof database.query

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
