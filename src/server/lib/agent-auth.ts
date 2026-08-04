import crypto from 'node:crypto'
import type { Request } from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import {
    OUTREACH_AGENT_SCOPES,
    outreachAgentCredentials,
    type OutreachAgentScope,
} from '../../db/schema'
import { timingSafeEqualStr } from './service-auth'
import { checkOutreachAccess } from './outreach-access'

export const AGENT_KEY_HEADER = 'x-agent-key'
export const AGENT_PRINCIPAL_HEADER = 'x-agent-principal'
export const AGENT_CREDENTIAL_HEADER = 'x-agent-credential-id'
export const AGENT_ORGANIZATION_HEADER = 'x-agent-organization-id'
export const AGENT_SCOPES_HEADER = 'x-agent-scopes'

const TOKEN_PREFIX = 'xma'
const KEY_PREFIX_BYTES = 8
const SECRET_BYTES = 32
const VALID_SCOPE_SET = new Set<string>(OUTREACH_AGENT_SCOPES)

export interface GeneratedAgentToken {
    token: string
    keyPrefix: string
    keyHash: string
}

export interface AgentPrincipal {
    credentialId: string
    organizationId: string
    principalUserId: string
    scopes: OutreachAgentScope[]
}

export type AgentAuthenticationResult =
    | { ok: true; principal: AgentPrincipal }
    | { ok: false; status: 401 | 503; error: string }

export function hashAgentToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

export function generateAgentToken(): GeneratedAgentToken {
    const keyPrefix = crypto.randomBytes(KEY_PREFIX_BYTES).toString('hex')
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url')
    const token = `${TOKEN_PREFIX}_${keyPrefix}_${secret}`
    return { token, keyPrefix, keyHash: hashAgentToken(token) }
}

export function parseAgentToken(token: string): { keyPrefix: string } | null {
    const match = /^xma_([0-9a-f]{16})_([A-Za-z0-9_-]{40,})$/.exec(token)
    return match ? { keyPrefix: match[1] } : null
}

export function normalizeAgentScopes(value: unknown): OutreachAgentScope[] {
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((scope): scope is OutreachAgentScope => (
        typeof scope === 'string' && VALID_SCOPE_SET.has(scope)
    )))]
}

export function stripAgentHeaders(req: Request): void {
    delete req.headers[AGENT_PRINCIPAL_HEADER]
    delete req.headers[AGENT_CREDENTIAL_HEADER]
    delete req.headers[AGENT_ORGANIZATION_HEADER]
    delete req.headers[AGENT_SCOPES_HEADER]
}

export async function authenticateOutreachAgent(req: Request): Promise<AgentAuthenticationResult> {
    const provided = req.headers[AGENT_KEY_HEADER]
    if (typeof provided !== 'string' || provided.length === 0) {
        return { ok: false, status: 401, error: 'Unauthorized' }
    }

    const parsed = parseAgentToken(provided)
    if (!parsed) return { ok: false, status: 401, error: 'Unauthorized' }

    try {
        const credential = await db.query.outreachAgentCredentials.findFirst({
            where: eq(outreachAgentCredentials.keyPrefix, parsed.keyPrefix),
        })
        const suppliedHash = hashAgentToken(provided)
        if (!credential || !timingSafeEqualStr(suppliedHash, credential.keyHash)) {
            return { ok: false, status: 401, error: 'Unauthorized' }
        }
        if (credential.revokedAt || (credential.expiresAt && credential.expiresAt <= new Date())) {
            return { ok: false, status: 401, error: 'Credential expired or revoked' }
        }
        // A credential cannot outlive the human principal's tenant access. Removing the user
        // from the organization immediately invalidates every bound agent token.
        if (!await checkOutreachAccess(credential.principalUserId, credential.organizationId)) {
            return { ok: false, status: 401, error: 'Credential principal no longer has organization access' }
        }

        const scopes = normalizeAgentScopes(credential.scopes)
        const principal: AgentPrincipal = {
            credentialId: credential.id,
            organizationId: credential.organizationId,
            principalUserId: credential.principalUserId,
            scopes,
        }

        // The clear-text token must never travel past the authentication boundary.
        delete req.headers[AGENT_KEY_HEADER]
        req.headers['x-user-id'] = principal.principalUserId
        req.headers[AGENT_PRINCIPAL_HEADER] = 'true'
        req.headers[AGENT_CREDENTIAL_HEADER] = principal.credentialId
        req.headers[AGENT_ORGANIZATION_HEADER] = principal.organizationId
        req.headers[AGENT_SCOPES_HEADER] = principal.scopes.join(',')

        await db.update(outreachAgentCredentials)
            .set({ lastUsedAt: new Date(), updatedAt: new Date() })
            .where(eq(outreachAgentCredentials.id, credential.id))

        return { ok: true, principal }
    } catch (error) {
        console.error('[agent-auth] Credential lookup failed:', error instanceof Error ? error.message : error)
        return { ok: false, status: 503, error: 'Agent authentication temporarily unavailable' }
    }
}

export function getAgentPrincipal(req: Request): AgentPrincipal | null {
    if (req.headers[AGENT_PRINCIPAL_HEADER] !== 'true') return null
    const credentialId = req.headers[AGENT_CREDENTIAL_HEADER]
    const organizationId = req.headers[AGENT_ORGANIZATION_HEADER]
    const principalUserId = req.headers['x-user-id']
    const scopes = normalizeAgentScopes(
        typeof req.headers[AGENT_SCOPES_HEADER] === 'string'
            ? req.headers[AGENT_SCOPES_HEADER].split(',')
            : [],
    )
    if (typeof credentialId !== 'string' || typeof organizationId !== 'string' || typeof principalUserId !== 'string') {
        return null
    }
    return { credentialId, organizationId, principalUserId, scopes }
}

export function agentHasScope(principal: AgentPrincipal, scope: OutreachAgentScope): boolean {
    return principal.scopes.includes(scope)
}
