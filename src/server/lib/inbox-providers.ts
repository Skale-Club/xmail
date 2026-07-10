/**
 * Inbox Providers — provider-agnostic abstraction for sourcing cold-outreach sending mailboxes.
 *
 * Xmail sends outreach through `email_accounts` rows (SMTP/IMAP). Those mailboxes can come from
 * different vendors — a user pasting their own credentials ("manual"), or a cold-email
 * infrastructure provider that provisions pre-warmed, DKIM-authenticated mailboxes (IceMail,
 * Primeforge, ...). This module is the single seam those vendors plug into, so the rest of the
 * codebase never hard-codes a vendor.
 *
 * P006 ships the abstraction + the "manual" path (bulk credential import). Automated provisioning
 * against the vendor APIs is added later behind the same registry:
 *   - P007 — Primeforge (API access + Forge MCP are included in all plans)
 *   - P008 — IceMail (REST API; blocked on API-key access to the gated reference)
 *
 * The vendor a mailbox came from is persisted on `email_accounts.mailbox_provider` (migration 033),
 * with an optional `provider_ref` for the vendor-side mailbox id (used later for warmup sync).
 */

export type InboxProviderId = 'manual' | 'icemail' | 'primeforge'

export interface InboxProvider {
    id: InboxProviderId
    label: string
    /**
     * Whether this provider can create/provision brand-new mailboxes through a vendor API.
     * `manual` is false (the user brings their own credentials). IceMail/Primeforge are true;
     * the actual provisioning implementation lands in P007/P008 — until then this only advertises
     * intent so the UI can show "connect account" affordances.
     */
    supportsProvisioning: boolean
    /** Whether Xmail can import bulk SMTP/IMAP credentials for this provider (always true today). */
    supportsCredentialImport: boolean
    /** Short operator-facing note. */
    notes: string
}

const PROVIDERS: Record<InboxProviderId, InboxProvider> = {
    manual: {
        id: 'manual',
        label: 'Manual (bring your own SMTP/IMAP)',
        supportsProvisioning: false,
        supportsCredentialImport: true,
        notes: 'User supplies SMTP/IMAP credentials directly. No vendor API.',
    },
    icemail: {
        id: 'icemail',
        label: 'IceMail',
        // Provisioning API exists but its reference is gated — wired up in P008 once an API key
        // is available. Bulk credential export/import works today.
        supportsProvisioning: false,
        supportsCredentialImport: true,
        notes: 'Cheapest/fastest cold-mailbox provider. Bulk SMTP/IMAP export supported; automated provisioning is P008 (blocked on API key).',
    },
    primeforge: {
        id: 'primeforge',
        label: 'Primeforge',
        // API + Forge MCP are included in all plans; the automated adapter is P007.
        supportsProvisioning: false,
        supportsCredentialImport: true,
        notes: 'Deliverability-focused provider. API + Forge MCP included in all plans; automated provisioning is P007.',
    },
}

export function isInboxProviderId(value: unknown): value is InboxProviderId {
    return value === 'manual' || value === 'icemail' || value === 'primeforge'
}

export function getInboxProvider(id: InboxProviderId): InboxProvider {
    return PROVIDERS[id]
}

export function listInboxProviders(): InboxProvider[] {
    return Object.values(PROVIDERS)
}
