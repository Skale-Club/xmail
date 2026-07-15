import {
    pgTable,
    uuid,
    text,
    timestamp,
    boolean,
    integer,
    jsonb,
    pgEnum,
    uniqueIndex,
    index,
    check,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

// Enums
export const userRoleEnum = pgEnum('user_role', ['admin', 'member', 'viewer'])
export const serverModeEnum = pgEnum('server_mode', ['live', 'development'])
export const serverSendModeEnum = pgEnum('server_send_mode', ['smtp', 'api', 'outlook'])
export const domainVerificationEnum = pgEnum('domain_verification', ['pending', 'verified', 'failed'])
export const messageStatusEnum = pgEnum('message_status', ['pending', 'queued', 'sent', 'delivered', 'bounced', 'held', 'failed'])
export const credentialTypeEnum = pgEnum('credential_type', ['smtp', 'api'])
export const outlookMailboxStatusEnum = pgEnum('outlook_mailbox_status', ['active', 'expired', 'revoked'])
export const routeModeEnum = pgEnum('route_mode', ['endpoint', 'hold', 'reject'])
export const webhookEventEnum = pgEnum('webhook_event', [
    'message_sent',
    'message_delivered',
    'message_bounced',
    'message_held',
    'message_opened',
    'link_clicked',
    'domain_verified',
    'spam_alert',
    'test'
])

// Users table
export const users = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    passwordHash: text('password_hash'),
    avatarUrl: text('avatar_url'),
    isAdmin: boolean('is_admin').default(false).notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    twoFactorEnabled: boolean('two_factor_enabled').default(false).notNull(),
    twoFactorSecret: text('two_factor_secret'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// Organizations table
export const organizations = pgTable('organizations', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    timezone: text('timezone').default('UTC').notNull(),
    ownerId: uuid('owner_id').references(() => users.id).notNull(),
    outreachEnabled: boolean('outreach_enabled').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// Organization users (membership)
export const organizationUsers = pgTable('organization_users', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    userId: uuid('user_id').references(() => users.id).notNull(),
    role: userRoleEnum('role').default('member').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
    orgUserUnique: uniqueIndex('org_user_unique').on(table.organizationId, table.userId),
}))

// Domains table
export const domains = pgTable('domains', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    verificationToken: text('verification_token'),
    verificationMethod: text('verification_method').default('dns'),
    verificationStatus: domainVerificationEnum('verification_status').default('pending').notNull(),
    verifiedAt: timestamp('verified_at'),
    // DKIM
    dkimPrivateKey: text('dkim_private_key'),
    dkimPublicKey: text('dkim_public_key'),
    dkimSelector: text('dkim_selector').default('skaleclub'),
    dkimStatus: text('dkim_status').default('pending'),
    dkimError: text('dkim_error'),
    // SPF
    spfStatus: text('spf_status').default('pending'),
    spfError: text('spf_error'),
    // DMARC
    dmarcStatus: text('dmarc_status').default('pending'),
    dmarcError: text('dmarc_error'),
    // MX
    mxStatus: text('mx_status').default('pending'),
    mxError: text('mx_error'),
    // Return path
    returnPathStatus: text('return_path_status').default('pending'),
    returnPathError: text('return_path_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxDomainsOrganizationId: index('idx_domains_organization_id').on(table.organizationId),
}))

// Credentials table
export const credentials = pgTable('credentials', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    type: credentialTypeEnum('type').default('smtp').notNull(),
    key: text('key').notNull(),
    secretHash: text('secret_hash'),
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxCredentialsOrganizationId: index('idx_credentials_organization_id').on(table.organizationId),
}))

// Outlook mailboxes
export const outlookMailboxes = pgTable('outlook_mailboxes', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    microsoftUserId: text('microsoft_user_id').notNull(),
    tenantId: text('tenant_id'),
    scopes: jsonb('scopes').notNull().default([]),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    tokenExpiresAt: timestamp('token_expires_at').notNull(),
    status: outlookMailboxStatusEnum('status').default('active').notNull(),
    lastSyncedAt: timestamp('last_synced_at'),
    lastSendAt: timestamp('last_send_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    orgEmailUnique: uniqueIndex('outlook_mailboxes_org_email_unique').on(table.organizationId, table.email),
    microsoftUserUnique: uniqueIndex('outlook_mailboxes_microsoft_user_unique').on(table.microsoftUserId),
    idxOutlookMailboxesOrganizationId: index('idx_outlook_mailboxes_organization_id').on(table.organizationId),
}))

// Routes table
export const routes = pgTable('routes', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    address: text('address').notNull(),
    mode: routeModeEnum('mode').default('endpoint').notNull(),
    // Endpoint configurations
    smtpEndpointId: uuid('smtp_endpoint_id'),
    httpEndpointId: uuid('http_endpoint_id'),
    addressEndpointId: uuid('address_endpoint_id'),
    // Spam handling
    spamMode: text('spam_mode').default('mark'),
    spamThreshold: integer('spam_threshold').default(5),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxRoutesOrganizationId: index('idx_routes_organization_id').on(table.organizationId),
}))

// SMTP Endpoints
export const smtpEndpoints = pgTable('smtp_endpoints', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    hostname: text('hostname').notNull(),
    port: integer('port').default(25).notNull(),
    sslMode: text('ssl_mode').default('auto').notNull(),
    username: text('username'),
    password: text('password'),
    passwordEncrypted: text('password_encrypted'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxSmtpEndpointsOrganizationId: index('idx_smtp_endpoints_organization_id').on(table.organizationId),
}))

// HTTP Endpoints
export const httpEndpoints = pgTable('http_endpoints', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    method: text('method').default('POST').notNull(),
    headers: jsonb('headers').default({}),
    includeOriginal: boolean('include_original').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxHttpEndpointsOrganizationId: index('idx_http_endpoints_organization_id').on(table.organizationId),
}))

// Address Endpoints
export const addressEndpoints = pgTable('address_endpoints', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    emailAddress: text('email_address').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxAddressEndpointsOrganizationId: index('idx_address_endpoints_organization_id').on(table.organizationId),
}))

// Messages table
export const messages = pgTable('messages', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    // Message identification
    messageId: text('message_id'),
    token: text('token').notNull(),
    // Direction
    direction: text('direction').notNull(), // 'incoming' | 'outgoing'
    // Sender/Recipient
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    toAddresses: jsonb('to_addresses').notNull().default([]),
    ccAddresses: jsonb('cc_addresses').default([]),
    bccAddresses: jsonb('bcc_addresses').default([]),
    // Content
    subject: text('subject'),
    plainBody: text('plain_body'),
    htmlBody: text('html_body'),
    attachments: jsonb('attachments').default([]),
    headers: jsonb('headers').default({}),
    // Status
    status: messageStatusEnum('status').default('pending').notNull(),
    held: boolean('held').default(false).notNull(),
    holdExpiry: timestamp('hold_expiry'),
    heldReason: text('held_reason'),
    // Tracking
    spamScore: integer('spam_score'),
    spamChecks: jsonb('spam_checks').default([]),
    // Timestamps
    sentAt: timestamp('sent_at'),
    deliveredAt: timestamp('delivered_at'),
    bouncedAt: timestamp('bounced_at'),
    openedAt: timestamp('opened_at'),
    clickedAt: timestamp('clicked_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxMessagesOrganizationId: index('idx_messages_organization_id').on(table.organizationId),
    idxMessagesOrgStatus: index('idx_messages_org_status').on(table.organizationId, table.status),
    idxMessagesToken: index('idx_messages_token').on(table.token),
}))

// Message deliveries
export const deliveries = pgTable('deliveries', {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').references(() => messages.id).notNull(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    // Recipient
    rcptTo: text('rcpt_to').notNull(),
    // Status
    status: messageStatusEnum('status').default('pending').notNull(),
    // Details
    details: text('details'),
    output: text('output'),
    sentWithSsl: boolean('sent_with_ssl').default(false),
    // Timestamps
    sentAt: timestamp('sent_at'),
    deliveredAt: timestamp('delivered_at'),
    bouncedAt: timestamp('bounced_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
    idxDeliveriesMessageId: index('idx_deliveries_message_id').on(table.messageId),
    idxDeliveriesOrganizationId: index('idx_deliveries_organization_id').on(table.organizationId),
}))

// Webhooks table
export const webhooks = pgTable('webhooks', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    secret: text('secret'),
    active: boolean('active').default(true).notNull(),
    events: jsonb('events').notNull().default([]),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxWebhooksOrganizationId: index('idx_webhooks_organization_id').on(table.organizationId),
}))

// Webhook requests log
export const webhookRequests = pgTable('webhook_requests', {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id').references(() => webhooks.id).notNull(),
    event: webhookEventEnum('event').notNull(),
    payload: jsonb('payload').notNull(),
    responseCode: integer('response_code'),
    responseBody: text('response_body'),
    success: boolean('success').default(false).notNull(),
    attempts: integer('attempts').default(1).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
    idxWebhookRequestsWebhookId: index('idx_webhook_requests_webhook_id').on(table.webhookId),
}))

// Email templates
export const templates = pgTable('templates', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    subject: text('subject').notNull(),
    plainBody: text('plain_body'),
    htmlBody: text('html_body'),
    variables: jsonb('variables').default([]), // list of template variable names
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    orgSlugUnique: uniqueIndex('template_org_slug_unique').on(table.organizationId, table.slug),
    idxTemplatesOrganizationId: index('idx_templates_organization_id').on(table.organizationId),
}))

// Track domains (for open/click tracking)
export const trackDomains = pgTable('track_domains', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    domain: text('domain').notNull(),
    verificationToken: text('verification_token'),
    verificationStatus: domainVerificationEnum('verification_status').default('pending').notNull(),
    verifiedAt: timestamp('verified_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxTrackDomainsOrganizationId: index('idx_track_domains_organization_id').on(table.organizationId),
}))

// Suppression list
export const suppressions = pgTable('suppressions', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    emailAddress: text('email_address').notNull(),
    // Provenance of the suppression — constrained at DB layer (see migration 020).
    source: text('source').notNull().default('manual'), // 'bounce' | 'complaint' | 'unsubscribe' | 'manual'
    reason: text('reason').notNull(), // 'bounce', 'complaint', 'manual' (free-text reason; superseded by source going forward but kept for compat)
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
    orgEmailUnique: uniqueIndex('suppression_org_email_unique').on(table.organizationId, table.emailAddress),
    idxSuppressionsOrganizationId: index('idx_suppressions_organization_id').on(table.organizationId),
}))

// Statistics (aggregated)
export const statistics = pgTable('statistics', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    date: timestamp('date').notNull(),
    // Counts
    messagesSent: integer('messages_sent').default(0).notNull(),
    messagesDelivered: integer('messages_delivered').default(0).notNull(),
    messagesBounced: integer('messages_bounced').default(0).notNull(),
    messagesHeld: integer('messages_held').default(0).notNull(),
    messagesOpened: integer('messages_opened').default(0).notNull(),
    linksClicked: integer('links_clicked').default(0).notNull(),
    // Incoming
    messagesIncoming: integer('messages_incoming').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
    orgDateUnique: uniqueIndex('stats_org_date_unique').on(table.organizationId, table.date),
    idxStatisticsOrganizationId: index('idx_statistics_organization_id').on(table.organizationId),
}))

export const systemBranding = pgTable('system_branding', {
    id: text('id').primaryKey().default('default'),
    companyName: text('company_name').notNull().default(''),
    applicationName: text('application_name').notNull().default('Mail Platform'),
    logoStorage: text('logo_storage'),
    faviconStorage: text('favicon_storage'),
    mailHost: text('mail_host'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const systemIntegrations = pgTable('system_integrations', {
    id: text('id').primaryKey().$defaultFn(() => 'default'),
    telegramBotToken: text('telegram_bot_token'),       // encrypted
    telegramChatId: text('telegram_chat_id'),           // plaintext
    telegramEnabled: boolean('telegram_enabled').default(false).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
export type SystemIntegrations = typeof systemIntegrations.$inferSelect

// Relations
export const usersRelations = relations(users, ({ many }) => ({
    organizations: many(organizationUsers),
}))

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
    owner: one(users, {
        fields: [organizations.ownerId],
        references: [users.id],
    }),
    members: many(organizationUsers),
    domains: many(domains),
    credentials: many(credentials),
    routes: many(routes),
    messages: many(messages),
    webhooks: many(webhooks),
    smtpEndpoints: many(smtpEndpoints),
    httpEndpoints: many(httpEndpoints),
    addressEndpoints: many(addressEndpoints),
    outlookMailboxes: many(outlookMailboxes),
    trackDomains: many(trackDomains),
    suppressions: many(suppressions),
    statistics: many(statistics),
    templates: many(templates),
}))

export const organizationUsersRelations = relations(organizationUsers, ({ one }) => ({
    organization: one(organizations, {
        fields: [organizationUsers.organizationId],
        references: [organizations.id],
    }),
    user: one(users, {
        fields: [organizationUsers.userId],
        references: [users.id],
    }),
}))

export const domainsRelations = relations(domains, ({ one }) => ({
    organization: one(organizations, {
        fields: [domains.organizationId],
        references: [organizations.id],
    }),
}))

export const credentialsRelations = relations(credentials, ({ one }) => ({
    organization: one(organizations, {
        fields: [credentials.organizationId],
        references: [organizations.id],
    }),
}))

export const outlookMailboxesRelations = relations(outlookMailboxes, ({ one }) => ({
    organization: one(organizations, {
        fields: [outlookMailboxes.organizationId],
        references: [organizations.id],
    }),
    emailAccount: one(emailAccounts, {
        fields: [outlookMailboxes.id],
        references: [emailAccounts.outlookMailboxId],
    }),
}))

export const routesRelations = relations(routes, ({ one }) => ({
    organization: one(organizations, {
        fields: [routes.organizationId],
        references: [organizations.id],
    }),
    smtpEndpoint: one(smtpEndpoints, {
        fields: [routes.smtpEndpointId],
        references: [smtpEndpoints.id],
    }),
    httpEndpoint: one(httpEndpoints, {
        fields: [routes.httpEndpointId],
        references: [httpEndpoints.id],
    }),
    addressEndpoint: one(addressEndpoints, {
        fields: [routes.addressEndpointId],
        references: [addressEndpoints.id],
    }),
}))

export const messagesRelations = relations(messages, ({ one, many }) => ({
    organization: one(organizations, {
        fields: [messages.organizationId],
        references: [organizations.id],
    }),
    deliveries: many(deliveries),
}))

export const deliveriesRelations = relations(deliveries, ({ one }) => ({
    message: one(messages, {
        fields: [deliveries.messageId],
        references: [messages.id],
    }),
    organization: one(organizations, {
        fields: [deliveries.organizationId],
        references: [organizations.id],
    }),
}))

export const webhooksRelations = relations(webhooks, ({ one, many }) => ({
    organization: one(organizations, {
        fields: [webhooks.organizationId],
        references: [organizations.id],
    }),
    requests: many(webhookRequests),
}))

export const webhookRequestsRelations = relations(webhookRequests, ({ one }) => ({
    webhook: one(webhooks, {
        fields: [webhookRequests.webhookId],
        references: [webhooks.id],
    }),
}))

export const templatesRelations = relations(templates, ({ one }) => ({
    organization: one(organizations, {
        fields: [templates.organizationId],
        references: [organizations.id],
    }),
}))

export const trackDomainsRelations = relations(trackDomains, ({ one }) => ({
    organization: one(organizations, {
        fields: [trackDomains.organizationId],
        references: [organizations.id],
    }),
}))

export const suppressionsRelations = relations(suppressions, ({ one }) => ({
    organization: one(organizations, {
        fields: [suppressions.organizationId],
        references: [organizations.id],
    }),
}))

export const statisticsRelations = relations(statistics, ({ one }) => ({
    organization: one(organizations, {
        fields: [statistics.organizationId],
        references: [organizations.id],
    }),
}))

export const smtpEndpointsRelations = relations(smtpEndpoints, ({ one }) => ({
    organization: one(organizations, {
        fields: [smtpEndpoints.organizationId],
        references: [organizations.id],
    }),
}))

export const httpEndpointsRelations = relations(httpEndpoints, ({ one }) => ({
    organization: one(organizations, {
        fields: [httpEndpoints.organizationId],
        references: [organizations.id],
    }),
}))

export const addressEndpointsRelations = relations(addressEndpoints, ({ one }) => ({
    organization: one(organizations, {
        fields: [addressEndpoints.organizationId],
        references: [organizations.id],
    }),
}))

// Zod schemas for validation
export const insertUserSchema = createInsertSchema(users)
export const selectUserSchema = createSelectSchema(users)

export const insertOrganizationSchema = createInsertSchema(organizations)
export const selectOrganizationSchema = createSelectSchema(organizations)

export const insertDomainSchema = createInsertSchema(domains)
export const selectDomainSchema = createSelectSchema(domains)

export const insertCredentialSchema = createInsertSchema(credentials)
export const selectCredentialSchema = createSelectSchema(credentials)

export const insertOutlookMailboxSchema = createInsertSchema(outlookMailboxes)
export const selectOutlookMailboxSchema = createSelectSchema(outlookMailboxes)

export const insertRouteSchema = createInsertSchema(routes)
export const selectRouteSchema = createSelectSchema(routes)

export const insertMessageSchema = createInsertSchema(messages)
export const selectMessageSchema = createSelectSchema(messages)

export const insertWebhookSchema = createInsertSchema(webhooks)
export const selectWebhookSchema = createSelectSchema(webhooks)

export const insertTemplateSchema = createInsertSchema(templates)
export const selectTemplateSchema = createSelectSchema(templates)

// Types
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert

export type OrganizationUser = typeof organizationUsers.$inferSelect
export type NewOrganizationUser = typeof organizationUsers.$inferInsert

export type Domain = typeof domains.$inferSelect
export type NewDomain = typeof domains.$inferInsert

export type Credential = typeof credentials.$inferSelect
export type NewCredential = typeof credentials.$inferInsert

export type OutlookMailbox = typeof outlookMailboxes.$inferSelect
export type NewOutlookMailbox = typeof outlookMailboxes.$inferInsert

export type Route = typeof routes.$inferSelect
export type NewRoute = typeof routes.$inferInsert

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert

export type Delivery = typeof deliveries.$inferSelect
export type NewDelivery = typeof deliveries.$inferInsert

export type Webhook = typeof webhooks.$inferSelect
export type NewWebhook = typeof webhooks.$inferInsert

export type WebhookRequest = typeof webhookRequests.$inferSelect
export type NewWebhookRequest = typeof webhookRequests.$inferInsert

export type Suppression = typeof suppressions.$inferSelect
export type NewSuppression = typeof suppressions.$inferInsert

export type Statistic = typeof statistics.$inferSelect
export type NewStatistic = typeof statistics.$inferInsert

export type Template = typeof templates.$inferSelect
export type NewTemplate = typeof templates.$inferInsert

// ============================================
// OUTREACH MODULE SCHEMA (Instantly/SmartLead-like)
// ============================================

// Campaign status enum
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'active', 'paused', 'completed', 'archived'])

// Lead status enum
export const leadStatusEnum = pgEnum('lead_status', ['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'])

// Email account status enum
export const emailAccountStatusEnum = pgEnum('email_account_status', ['pending', 'verified', 'failed', 'paused'])

// Sequence step type enum
export const sequenceStepTypeEnum = pgEnum('sequence_step_type', ['email', 'delay', 'condition'])

// Email account provider enum
export const emailProviderEnum = pgEnum('email_provider', ['smtp', 'outlook', 'native'])

// Email Accounts (Inboxes for sending outreach emails)
export const emailAccounts = pgTable('email_accounts', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    // Account details
    email: text('email').notNull(),
    displayName: text('display_name'),
    provider: emailProviderEnum('provider').default('smtp').notNull(),
    // Sourcing vendor for this mailbox: manual paste, IceMail, Primeforge, ... (migration 033).
    // Distinct from `provider` above, which is the SENDING mechanism (SMTP vs Outlook OAuth).
    mailboxProvider: text('mailbox_provider').default('manual').notNull(),
    // External reference on the vendor side (mailbox id) for warmup sync / re-provisioning.
    providerRef: text('provider_ref'),
    outlookMailboxId: uuid('outlook_mailbox_id').references(() => outlookMailboxes.id),
    // SMTP settings (optional for OAuth providers)
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port').default(587),
    smtpUsername: text('smtp_username'),
    smtpPassword: text('smtp_password'),
    smtpSecure: boolean('smtp_secure').default(true),
    // IMAP settings (for reply tracking)
    imapHost: text('imap_host'),
    imapPort: integer('imap_port').default(993),
    imapUsername: text('imap_username'),
    imapPassword: text('imap_password'),
    imapSecure: boolean('imap_secure').default(true),
    // Sending limits (warm-up and daily limits)
    dailySendLimit: integer('daily_send_limit').default(50).notNull(),
    currentDailySent: integer('current_daily_sent').default(0).notNull(),
    minMinutesBetweenEmails: integer('min_minutes_between_emails').default(5).notNull(),
    maxMinutesBetweenEmails: integer('max_minutes_between_emails').default(30).notNull(),
    // Warm-up settings
    warmupEnabled: boolean('warmup_enabled').default(true).notNull(),
    warmupDays: integer('warmup_days').default(14).notNull(),
    warmupCurrentDay: integer('warmup_current_day').default(0).notNull(),
    // Status
    status: emailAccountStatusEnum('status').default('pending').notNull(),
    lastError: text('last_error'),
    lastSyncAt: timestamp('last_sync_at'),
    verifiedAt: timestamp('verified_at'),
    // Tracking
    totalSent: integer('total_sent').default(0).notNull(),
    totalOpens: integer('total_opens').default(0).notNull(),
    totalClicks: integer('total_clicks').default(0).notNull(),
    totalReplies: integer('total_replies').default(0).notNull(),
    totalBounces: integer('total_bounces').default(0).notNull(),
    lastSentAt: timestamp('last_sent_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    orgEmailUnique: uniqueIndex('email_account_org_email_unique').on(table.organizationId, table.email),
    idxEmailAccountsOrganizationId: index('idx_email_accounts_organization_id').on(table.organizationId),
    idxEmailAccountsOutlookMailboxId: index('idx_email_accounts_outlook_mailbox_id').on(table.outlookMailboxId),
}))

// Lead Lists (groups of leads)
export const leadLists = pgTable('lead_lists', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').default('#3B82F6'),
    leadCount: integer('lead_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxLeadListsOrganizationId: index('idx_lead_lists_organization_id').on(table.organizationId),
}))

// Leads (Prospects)
export const leads = pgTable('leads', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    // Contact info
    email: text('email').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    companyName: text('company_name'),
    companySize: text('company_size'),
    industry: text('industry'),
    title: text('title'),
    website: text('website'),
    linkedinUrl: text('linkedin_url'),
    phone: text('phone'),
    location: text('location'),
    // Custom fields (JSON)
    customFields: jsonb('custom_fields').default({}),
    // Status
    status: leadStatusEnum('status').default('new').notNull(),
    // Source tracking
    source: text('source'),
    leadListId: uuid('lead_list_id').references(() => leadLists.id),
    // Engagement tracking
    totalEmailsSent: integer('total_emails_sent').default(0).notNull(),
    totalOpens: integer('total_opens').default(0).notNull(),
    totalClicks: integer('total_clicks').default(0).notNull(),
    totalReplies: integer('total_replies').default(0).notNull(),
    lastContactedAt: timestamp('last_contacted_at'),
    lastRepliedAt: timestamp('last_replied_at'),
    // Opt-out
    unsubscribedAt: timestamp('unsubscribed_at'),
    unsubscribedReason: text('unsubscribed_reason'),
    // Timestamps
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    orgEmailUnique: uniqueIndex('lead_org_email_unique').on(table.organizationId, table.email),
    idxLeadsOrganizationId: index('idx_leads_organization_id').on(table.organizationId),
    idxLeadsLeadListId: index('idx_leads_lead_list_id').on(table.leadListId),
}))

// Campaigns
export const campaigns = pgTable('campaigns', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    // Basic info
    name: text('name').notNull(),
    description: text('description'),
    // Settings
    status: campaignStatusEnum('status').default('draft').notNull(),
    // Sender settings
    fromName: text('from_name'),
    replyToEmail: text('reply_to_email'),
    // Schedule settings
    timezone: text('timezone').default('UTC').notNull(),
    sendOnWeekends: boolean('send_on_weekends').default(false).notNull(),
    sendStartTime: text('send_start_time').default('09:00').notNull(), // HH:mm
    sendEndTime: text('send_end_time').default('17:00').notNull(), // HH:mm
    // Tracking settings
    trackOpens: boolean('track_opens').default(true).notNull(),
    trackClicks: boolean('track_clicks').default(true).notNull(),
    // Agentic follow-up (P001/P002, migration 034) — OFF by default.
    agenticFollowupEnabled: boolean('agentic_followup_enabled').default(false).notNull(),
    maxFollowUps: integer('max_follow_ups').default(2).notNull(),
    // Statistics (cached)
    totalLeads: integer('total_leads').default(0).notNull(),
    leadsContacted: integer('leads_contacted').default(0).notNull(),
    totalOpens: integer('total_opens').default(0).notNull(),
    totalClicks: integer('total_clicks').default(0).notNull(),
    totalReplies: integer('total_replies').default(0).notNull(),
    totalBounces: integer('total_bounces').default(0).notNull(),
    totalUnsubscribes: integer('total_unsubscribes').default(0).notNull(),
    // Timestamps
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxCampaignsOrganizationId: index('idx_campaigns_organization_id').on(table.organizationId),
}))

// Sequences (email sequences for campaigns)
export const sequences = pgTable('sequences', {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxSequencesCampaignId: index('idx_sequences_campaign_id').on(table.campaignId),
}))

// Sequence Steps (individual emails in a sequence)
export const sequenceSteps = pgTable('sequence_steps', {
    id: uuid('id').primaryKey().defaultRandom(),
    sequenceId: uuid('sequence_id').references(() => sequences.id, { onDelete: 'cascade' }).notNull(),
    // Step order
    stepOrder: integer('step_order').notNull(),
    // Type
    type: sequenceStepTypeEnum('type').default('email').notNull(),
    // Delay before this step (in hours)
    delayHours: integer('delay_hours').default(0).notNull(),
    // Email content
    subject: text('subject'),
    plainBody: text('plain_body'),
    htmlBody: text('html_body'),
    // A/B testing
    subjectB: text('subject_b'),
    plainBodyB: text('plain_body_b'),
    htmlBodyB: text('html_body_b'),
    abTestEnabled: boolean('ab_test_enabled').default(false).notNull(),
    abTestPercentage: integer('ab_test_percentage').default(50), // percentage for variant A
    // Statistics
    totalSent: integer('total_sent').default(0).notNull(),
    totalOpens: integer('total_opens').default(0).notNull(),
    totalClicks: integer('total_clicks').default(0).notNull(),
    totalReplies: integer('total_replies').default(0).notNull(),
    // Timestamps
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    sequenceOrderUnique: uniqueIndex('sequence_step_order_unique').on(table.sequenceId, table.stepOrder),
    idxSequenceStepsSequenceId: index('idx_sequence_steps_sequence_id').on(table.sequenceId),
    sequenceStepsDelayHoursPositive: check('sequence_steps_delay_hours_positive', sql`${table.delayHours} >= 0`),
    sequenceStepsOrderPositive: check('sequence_steps_order_positive', sql`${table.stepOrder} >= 1`),
}))

// Campaign Leads (junction table - leads assigned to campaigns)
export const campaignLeads = pgTable('campaign_leads', {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }).notNull(),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }).notNull(),
    // Assignment
    assignedEmailAccountId: uuid('assigned_email_account_id').references(() => emailAccounts.id),
    // Progress
    currentStepId: uuid('current_step_id').references(() => sequenceSteps.id, { onDelete: 'set null' }),
    currentStepOrder: integer('current_step_order').default(0).notNull(),
    // Status
    status: leadStatusEnum('status').default('new').notNull(),
    // Next scheduled action
    nextScheduledAt: timestamp('next_scheduled_at'),
    // Agentic follow-up (P001/P002, migration 034)
    nextFollowUpAt: timestamp('next_follow_up_at'),
    followUpCount: integer('follow_up_count').default(0).notNull(),
    lastReplyMessageId: text('last_reply_message_id'),
    lastReplyText: text('last_reply_text'),
    lastReplyAt: timestamp('last_reply_at'),
    // Tracking for this specific campaign/lead combination
    totalOpens: integer('total_opens').default(0).notNull(),
    totalClicks: integer('total_clicks').default(0).notNull(),
    totalReplies: integer('total_replies').default(0).notNull(),
    // Timestamps
    firstContactedAt: timestamp('first_contacted_at'),
    lastContactedAt: timestamp('last_contacted_at'),
    lastRepliedAt: timestamp('last_replied_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    campaignLeadUnique: uniqueIndex('campaign_lead_unique').on(table.campaignId, table.leadId),
    idxCampaignLeadsCampaignId: index('idx_campaign_leads_campaign_id').on(table.campaignId),
    idxCampaignLeadsLeadId: index('idx_campaign_leads_lead_id').on(table.leadId),
    idxCampaignLeadsAssignedEmailAccountId: index('idx_campaign_leads_assigned_email_account_id').on(table.assignedEmailAccountId),
    idxCampaignLeadsCurrentStepId: index('idx_campaign_leads_current_step_id').on(table.currentStepId),
    idxCampaignLeadsCampaignStatus: index('idx_campaign_leads_campaign_status').on(table.campaignId, table.status),
    idxCampaignLeadsNextScheduled: index('idx_campaign_leads_next_scheduled').on(table.nextScheduledAt),
    idxCampaignLeadsNextFollowUp: index('idx_campaign_leads_next_follow_up').on(table.nextFollowUpAt),
}))

// Outreach Emails (sent emails from campaigns)
export const outreachEmails = pgTable('outreach_emails', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }).notNull(),
    campaignLeadId: uuid('campaign_lead_id').references(() => campaignLeads.id, { onDelete: 'cascade' }).notNull(),
    sequenceStepId: uuid('sequence_step_id').references(() => sequenceSteps.id, { onDelete: 'cascade' }).notNull(),
    emailAccountId: uuid('email_account_id').references(() => emailAccounts.id).notNull(),
    // Message details
    messageId: text('message_id'), // RFC 2822 Message-ID
    // Stateless HMAC-signed tracking token (see src/server/lib/outreach-tokens.ts in Plan 14-05)
    trackingToken: text('tracking_token').notNull(),
    // Content sent
    subject: text('subject').notNull(),
    plainBody: text('plain_body'),
    htmlBody: text('html_body'),
    // A/B variant
    abVariant: text('ab_variant'), // 'a' or 'b'
    // Tracking
    sentAt: timestamp('sent_at'),
    deliveredAt: timestamp('delivered_at'),
    openedAt: timestamp('opened_at'),
    openedCount: integer('opened_count').default(0).notNull(),
    clickedAt: timestamp('clicked_at'),
    clickedCount: integer('clicked_count').default(0).notNull(),
    repliedAt: timestamp('replied_at'),
    bouncedAt: timestamp('bounced_at'),
    bounceReason: text('bounce_reason'),
    unsubscribedAt: timestamp('unsubscribed_at'),
    // Status
    status: messageStatusEnum('status').default('pending').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    campaignLeadStepUnique: uniqueIndex('outreach_emails_campaign_lead_step_unique').on(table.campaignLeadId, table.sequenceStepId),
    trackingTokenUnique: uniqueIndex('outreach_emails_tracking_token_unique').on(table.trackingToken),
    idxOutreachEmailsOrganizationId: index('idx_outreach_emails_organization_id').on(table.organizationId),
    idxOutreachEmailsCampaignId: index('idx_outreach_emails_campaign_id').on(table.campaignId),
    idxOutreachEmailsCampaignLeadId: index('idx_outreach_emails_campaign_lead_id').on(table.campaignLeadId),
    idxOutreachEmailsSequenceStepId: index('idx_outreach_emails_sequence_step_id').on(table.sequenceStepId),
    idxOutreachEmailsEmailAccountId: index('idx_outreach_emails_email_account_id').on(table.emailAccountId),
    // Reply/bounce processors look up sent mail by message_id (migration 032).
    idxOutreachEmailsMessageId: index('idx_outreach_emails_message_id').on(table.messageId),
    // Phase 17 — every aggregate query in the health endpoint filters on
    // (sent_at >= window AND status = ?). Composite index makes those scans
    // index-only for the common 1h/24h/7d rolling windows.
    idxOutreachEmailsSentAtStatus: index('idx_outreach_emails_sent_at_status').on(table.sentAt, table.status),
}))

// Outreach Settings (per-org defaults for campaigns)
export const outreachSettings = pgTable('outreach_settings', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().unique().references(() => organizations.id, { onDelete: 'cascade' }),
    // general
    defaultTimezone: text('default_timezone').default('UTC').notNull(),
    defaultSendStartTime: text('default_send_start_time').default('09:00').notNull(),
    defaultSendEndTime: text('default_send_end_time').default('17:00').notNull(),
    sendOnWeekends: boolean('send_on_weekends').default(false).notNull(),
    trackOpens: boolean('track_opens').default(true).notNull(),
    trackClicks: boolean('track_clicks').default(true).notNull(),
    // sending
    defaultDailyLimit: integer('default_daily_limit').default(50).notNull(),
    defaultMinMinutesBetweenEmails: integer('default_min_minutes_between_emails').default(5).notNull(),
    warmupEnabled: boolean('warmup_enabled').default(true).notNull(),
    warmupDays: integer('warmup_days').default(21).notNull(),
    // notifications
    notifyOnReply: boolean('notify_on_reply').default(true).notNull(),
    notifyOnBounce: boolean('notify_on_bounce').default(true).notNull(),
    notifyOnUnsubscribe: boolean('notify_on_unsubscribe').default(false).notNull(),
    weeklyReport: boolean('weekly_report').default(true).notNull(),
    // meta
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// Outreach Analytics (daily aggregated stats)
export const outreachAnalytics = pgTable('outreach_analytics', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    emailAccountId: uuid('email_account_id').references(() => emailAccounts.id),
    date: timestamp('date').notNull(),
    // Stats
    emailsSent: integer('emails_sent').default(0).notNull(),
    emailsDelivered: integer('emails_delivered').default(0).notNull(),
    emailsBounced: integer('emails_bounced').default(0).notNull(),
    opens: integer('opens').default(0).notNull(),
    clicks: integer('clicks').default(0).notNull(),
    replies: integer('replies').default(0).notNull(),
    unsubscribes: integer('unsubscribes').default(0).notNull(),
    leadsAdded: integer('leads_added').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
    orgDateUnique: uniqueIndex('outreach_analytics_org_date_unique').on(table.organizationId, table.date, table.campaignId, table.emailAccountId),
    idxOutreachAnalyticsOrganizationId: index('idx_outreach_analytics_organization_id').on(table.organizationId),
    idxOutreachAnalyticsCampaignId: index('idx_outreach_analytics_campaign_id').on(table.campaignId),
    idxOutreachAnalyticsEmailAccountId: index('idx_outreach_analytics_email_account_id').on(table.emailAccountId),
}))

// Outreach Relations
export const emailAccountsRelations = relations(emailAccounts, ({ one, many }) => ({
    organization: one(organizations, {
        fields: [emailAccounts.organizationId],
        references: [organizations.id],
    }),
    outlookMailbox: one(outlookMailboxes, {
        fields: [emailAccounts.outlookMailboxId],
        references: [outlookMailboxes.id],
    }),
    campaignLeads: many(campaignLeads),
    outreachEmails: many(outreachEmails),
}))

export const leadListsRelations = relations(leadLists, ({ one, many }) => ({
    organization: one(organizations, {
        fields: [leadLists.organizationId],
        references: [organizations.id],
    }),
    leads: many(leads),
}))

export const leadsRelations = relations(leads, ({ one, many }) => ({
    organization: one(organizations, {
        fields: [leads.organizationId],
        references: [organizations.id],
    }),
    leadList: one(leadLists, {
        fields: [leads.leadListId],
        references: [leadLists.id],
    }),
    campaignLeads: many(campaignLeads),
}))

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
    organization: one(organizations, {
        fields: [campaigns.organizationId],
        references: [organizations.id],
    }),
    sequences: many(sequences),
    campaignLeads: many(campaignLeads),
    outreachEmails: many(outreachEmails),
}))

export const sequencesRelations = relations(sequences, ({ one, many }) => ({
    campaign: one(campaigns, {
        fields: [sequences.campaignId],
        references: [campaigns.id],
    }),
    steps: many(sequenceSteps),
}))

export const sequenceStepsRelations = relations(sequenceSteps, ({ one, many }) => ({
    sequence: one(sequences, {
        fields: [sequenceSteps.sequenceId],
        references: [sequences.id],
    }),
    campaignLeads: many(campaignLeads),
    outreachEmails: many(outreachEmails),
}))

export const campaignLeadsRelations = relations(campaignLeads, ({ one, many }) => ({
    campaign: one(campaigns, {
        fields: [campaignLeads.campaignId],
        references: [campaigns.id],
    }),
    lead: one(leads, {
        fields: [campaignLeads.leadId],
        references: [leads.id],
    }),
    assignedEmailAccount: one(emailAccounts, {
        fields: [campaignLeads.assignedEmailAccountId],
        references: [emailAccounts.id],
    }),
    currentStep: one(sequenceSteps, {
        fields: [campaignLeads.currentStepId],
        references: [sequenceSteps.id],
    }),
    outreachEmails: many(outreachEmails),
}))

export const outreachEmailsRelations = relations(outreachEmails, ({ one }) => ({
    organization: one(organizations, {
        fields: [outreachEmails.organizationId],
        references: [organizations.id],
    }),
    campaign: one(campaigns, {
        fields: [outreachEmails.campaignId],
        references: [campaigns.id],
    }),
    campaignLead: one(campaignLeads, {
        fields: [outreachEmails.campaignLeadId],
        references: [campaignLeads.id],
    }),
    sequenceStep: one(sequenceSteps, {
        fields: [outreachEmails.sequenceStepId],
        references: [sequenceSteps.id],
    }),
    emailAccount: one(emailAccounts, {
        fields: [outreachEmails.emailAccountId],
        references: [emailAccounts.id],
    }),
}))

export const outreachAnalyticsRelations = relations(outreachAnalytics, ({ one }) => ({
    organization: one(organizations, {
        fields: [outreachAnalytics.organizationId],
        references: [organizations.id],
    }),
    campaign: one(campaigns, {
        fields: [outreachAnalytics.campaignId],
        references: [campaigns.id],
    }),
    emailAccount: one(emailAccounts, {
        fields: [outreachAnalytics.emailAccountId],
        references: [emailAccounts.id],
    }),
}))

export const outreachSettingsRelations = relations(outreachSettings, ({ one }) => ({
    organization: one(organizations, {
        fields: [outreachSettings.organizationId],
        references: [organizations.id],
    }),
}))

// Zod schemas for outreach module
export const insertEmailAccountSchema = createInsertSchema(emailAccounts)
export const selectEmailAccountSchema = createSelectSchema(emailAccounts)

export const insertLeadListSchema = createInsertSchema(leadLists)
export const selectLeadListSchema = createSelectSchema(leadLists)

export const insertLeadSchema = createInsertSchema(leads)
export const selectLeadSchema = createSelectSchema(leads)

export const insertCampaignSchema = createInsertSchema(campaigns)
export const selectCampaignSchema = createSelectSchema(campaigns)

export const insertSequenceSchema = createInsertSchema(sequences)
export const selectSequenceSchema = createSelectSchema(sequences)

export const insertSequenceStepSchema = createInsertSchema(sequenceSteps)
export const selectSequenceStepSchema = createSelectSchema(sequenceSteps)

export const insertCampaignLeadSchema = createInsertSchema(campaignLeads)
export const selectCampaignLeadSchema = createSelectSchema(campaignLeads)

export const insertOutreachEmailSchema = createInsertSchema(outreachEmails)
export const selectOutreachEmailSchema = createSelectSchema(outreachEmails)

// Outreach Types
export type EmailAccount = typeof emailAccounts.$inferSelect
export type NewEmailAccount = typeof emailAccounts.$inferInsert

export type LeadList = typeof leadLists.$inferSelect
export type NewLeadList = typeof leadLists.$inferInsert

export type Lead = typeof leads.$inferSelect
export type NewLead = typeof leads.$inferInsert

export type Campaign = typeof campaigns.$inferSelect
export type NewCampaign = typeof campaigns.$inferInsert

export type Sequence = typeof sequences.$inferSelect
export type NewSequence = typeof sequences.$inferInsert

export type SequenceStep = typeof sequenceSteps.$inferSelect
export type NewSequenceStep = typeof sequenceSteps.$inferInsert

export type CampaignLead = typeof campaignLeads.$inferSelect
export type NewCampaignLead = typeof campaignLeads.$inferInsert

export type OutreachEmail = typeof outreachEmails.$inferSelect
export type NewOutreachEmail = typeof outreachEmails.$inferInsert

export type OutreachAnalytic = typeof outreachAnalytics.$inferSelect
export type NewOutreachAnalytic = typeof outreachAnalytics.$inferInsert

export type OutreachSettings = typeof outreachSettings.$inferSelect
export type NewOutreachSettings = typeof outreachSettings.$inferInsert

// ============================================
// USER MAIL MODULE (Webmail)
// ============================================

// User Mailboxes (user's email accounts for webmail)
export const mailboxes = pgTable('mailboxes', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id).notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    // SMTP settings
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').default(587).notNull(),
    smtpUsername: text('smtp_username').notNull(),
    smtpPasswordEncrypted: text('smtp_password_encrypted').notNull(),
    smtpSecure: boolean('smtp_secure').default(true).notNull(),
    // IMAP settings
    imapHost: text('imap_host').notNull(),
    imapPort: integer('imap_port').default(993).notNull(),
    imapUsername: text('imap_username').notNull(),
    imapPasswordEncrypted: text('imap_password_encrypted').notNull(),
    imapSecure: boolean('imap_secure').default(true).notNull(),
    // SEC-02 — per-mailbox opt-in to skip TLS cert verification (self-signed corporate IMAP)
    skipTlsVerify: boolean('skip_tls_verify').default(false).notNull(),
    // Status
    isDefault: boolean('is_default').default(false).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    isNative: boolean('is_native').default(false).notNull(),
    lastSyncAt: timestamp('last_sync_at'),
    syncError: text('sync_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxMailboxesUserId: index('idx_mailboxes_user_id').on(table.userId),
}))

// Mail Folders (INBOX, SENT, DRAFTS, etc.)
export const mailFolders = pgTable('mail_folders', {
    id: uuid('id').primaryKey().defaultRandom(),
    mailboxId: uuid('mailbox_id').references(() => mailboxes.id).notNull(),
    remoteId: text('remote_id').notNull(),
    name: text('name').notNull(),
    type: text('type').default('custom'), // 'inbox', 'sent', 'drafts', 'trash', 'spam', 'custom'
    unreadCount: integer('unread_count').default(0).notNull(),
    totalCount: integer('total_count').default(0).notNull(),
    uidValidity: integer('uid_validity').default(1).notNull(),
    uidNext: integer('uid_next').default(1).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    mailboxRemoteUnique: uniqueIndex('mail_folder_mailbox_remote_unique').on(table.mailboxId, table.remoteId),
    idxMailFoldersMailboxId: index('idx_mail_folders_mailbox_id').on(table.mailboxId),
}))

// Mail Messages (emails)
export const mailMessages = pgTable('mail_messages', {
    id: uuid('id').primaryKey().defaultRandom(),
    mailboxId: uuid('mailbox_id').references(() => mailboxes.id).notNull(),
    folderId: uuid('folder_id').references(() => mailFolders.id).notNull(),
    // RFC 2822
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references'),
    // Headers
    subject: text('subject'),
    fromAddress: text('from_address'),
    fromName: text('from_name'),
    toAddresses: jsonb('to_addresses').default([]),
    ccAddresses: jsonb('cc_addresses').default([]),
    bccAddresses: jsonb('bcc_addresses').default([]),
    // Content
    plainBody: text('plain_body'),
    htmlBody: text('html_body'),
    headers: jsonb('headers').default({}),
    // Attachments
    attachments: jsonb('attachments').default([]),
    hasAttachments: boolean('has_attachments').default(false).notNull(),
    // Status
    isRead: boolean('is_read').default(false).notNull(),
    isStarred: boolean('is_starred').default(false).notNull(),
    isDeleted: boolean('is_deleted').default(false).notNull(),
    isDraft: boolean('is_draft').default(false).notNull(),
    // Remote
    remoteUid: integer('remote_uid'),
    remoteDate: timestamp('remote_date'),
    size: integer('size').default(0),
    // Timestamps
    receivedAt: timestamp('received_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    folderUidUnique: uniqueIndex('mail_message_folder_uid_unique').on(table.folderId, table.remoteUid),
    idxMailMessagesMailboxId: index('idx_mail_messages_mailbox_id').on(table.mailboxId),
    idxMailMessagesFolderId: index('idx_mail_messages_folder_id').on(table.folderId),
}))

// Email Filters
export const mailFilters = pgTable('mail_filters', {
    id: uuid('id').primaryKey().defaultRandom(),
    mailboxId: uuid('mailbox_id').references(() => mailboxes.id).notNull(),
    name: text('name').notNull(),
    // Conditions (JSON)
    conditions: jsonb('conditions').notNull(), // { field: 'from'|'to'|'subject'|'body', operator: 'contains'|'equals'|'startsWith'|'regex', value: string }
    // Actions
    actions: jsonb('actions').notNull(), // { action: 'markRead'|'markStarred'|'moveToFolder'|'addLabel'|'markSpam'|'archive', value?: string }
    isActive: boolean('is_active').default(true).notNull(),
    priority: integer('priority').default(0).notNull(), // Higher = runs first
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxMailFiltersMailboxId: index('idx_mail_filters_mailbox_id').on(table.mailboxId),
}))

// Email Signatures
export const signatures = pgTable('signatures', {
    id: uuid('id').primaryKey().defaultRandom(),
    mailboxId: uuid('mailbox_id').references(() => mailboxes.id).notNull(),
    name: text('name').notNull(),
    content: text('content').notNull(), // HTML content
    isDefault: boolean('is_default').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    idxSignaturesMailboxId: index('idx_signatures_mailbox_id').on(table.mailboxId),
}))

// Mailbox Relations
export const mailboxesRelations = relations(mailboxes, ({ one, many }) => ({
    user: one(users, {
        fields: [mailboxes.userId],
        references: [users.id],
    }),
    folders: many(mailFolders),
    messages: many(mailMessages),
}))

export const mailFoldersRelations = relations(mailFolders, ({ one, many }) => ({
    mailbox: one(mailboxes, {
        fields: [mailFolders.mailboxId],
        references: [mailboxes.id],
    }),
    messages: many(mailMessages),
}))

export const mailMessagesRelations = relations(mailMessages, ({ one }) => ({
    mailbox: one(mailboxes, {
        fields: [mailMessages.mailboxId],
        references: [mailboxes.id],
    }),
    folder: one(mailFolders, {
        fields: [mailMessages.folderId],
        references: [mailFolders.id],
    }),
}))

export const mailFiltersRelations = relations(mailFilters, ({ one }) => ({
    mailbox: one(mailboxes, {
        fields: [mailFilters.mailboxId],
        references: [mailboxes.id],
    }),
}))

export const signaturesRelations = relations(signatures, ({ one }) => ({
    mailbox: one(mailboxes, {
        fields: [signatures.mailboxId],
        references: [mailboxes.id],
    }),
}))

// Contacts (user's address book for autocomplete)
export const contacts = pgTable('contacts', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id).notNull(),
    email: text('email').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    company: text('company'),
    emailedCount: integer('emailed_count').default(0).notNull(),
    lastEmailedAt: timestamp('last_emailed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
    userEmailUnique: uniqueIndex('contact_user_email_unique').on(table.userId, table.email),
    idxContactsUserId: index('idx_contacts_user_id').on(table.userId),
}))

export const contactsRelations = relations(contacts, ({ one }) => ({
    user: one(users, {
        fields: [contacts.userId],
        references: [users.id],
    }),
}))

// Types
export type Contact = typeof contacts.$inferSelect
export type NewContact = typeof contacts.$inferInsert

export type Mailbox = typeof mailboxes.$inferSelect
export type NewMailbox = typeof mailboxes.$inferInsert

export type MailFolder = typeof mailFolders.$inferSelect
export type NewMailFolder = typeof mailFolders.$inferInsert

export type MailMessage = typeof mailMessages.$inferSelect
export type NewMailMessage = typeof mailMessages.$inferInsert

export type MailFilter = typeof mailFilters.$inferSelect
export type NewMailFilter = typeof mailFilters.$inferInsert

export const insertSignatureSchema = createInsertSchema(signatures)
export const selectSignatureSchema = createSelectSchema(signatures)

export type Signature = typeof signatures.$inferSelect
export type NewSignature = typeof signatures.$inferInsert

// User Notifications table
export const userNotifications = pgTable('user_notifications', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id).notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    metadata: jsonb('metadata').default({}),
    read: boolean('read').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
    idxUserNotificationsUserId: index('idx_user_notifications_user_id').on(table.userId),
}))

export const userNotificationsRelations = relations(userNotifications, ({ one }) => ({
    user: one(users, {
        fields: [userNotifications.userId],
        references: [users.id],
    }),
}))

export type UserNotification = typeof userNotifications.$inferSelect
export type NewUserNotification = typeof userNotifications.$inferInsert

// Greylist table — persists MX greylisting state across container restarts.
// In-memory greylisting was reset on every redeploy, so legit MTAs that retry
// after the hold window kept getting a fresh 451 and could never get through.
export const greylist = pgTable('greylist', {
    // key = `${envelopeSender}|${recipient}` (lowercased)
    key: text('key').primaryKey(),
    firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
    passed: boolean('passed').default(false).notNull(),
}, (table) => ({
    idxGreylistLastSeen: index('idx_greylist_last_seen').on(table.lastSeen),
}))

export type GreylistEntry = typeof greylist.$inferSelect
export type NewGreylistEntry = typeof greylist.$inferInsert
