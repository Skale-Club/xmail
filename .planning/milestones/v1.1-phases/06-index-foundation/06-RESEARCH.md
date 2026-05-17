---
phase: 06-index-foundation
researcher: orchestrator
discovery_level: 0
---

# Phase 06 Research: Index Foundation

## Schema Analysis: All FK Columns Across Tables

### Core Tables (org-scoped)
| Table | FK Column | References |
|-------|-----------|------------|
| organization_users | organizationId | organizations.id |
| organization_users | userId | users.id |
| domains | organizationId | organizations.id |
| credentials | organizationId | organizations.id |
| outlook_mailboxes | organizationId | organizations.id |
| routes | organizationId | organizations.id |
| smtp_endpoints | organizationId | organizations.id |
| http_endpoints | organizationId | organizations.id |
| address_endpoints | organizationId | organizations.id |
| messages | organizationId | organizations.id |
| deliveries | messageId | messages.id |
| deliveries | organizationId | organizations.id |
| webhooks | organizationId | organizations.id |
| webhook_requests | webhookId | webhooks.id |
| templates | organizationId | organizations.id |
| track_domains | organizationId | organizations.id |
| suppressions | organizationId | organizations.id |
| statistics | organizationId | organizations.id |

### Outreach Tables
| Table | FK Column | References |
|-------|-----------|------------|
| email_accounts | organizationId | organizations.id |
| email_accounts | outlookMailboxId | outlook_mailboxes.id |
| lead_lists | organizationId | organizations.id |
| leads | organizationId | organizations.id |
| leads | leadListId | lead_lists.id |
| campaigns | organizationId | organizations.id |
| sequences | campaignId | campaigns.id |
| sequence_steps | sequenceId | sequences.id |
| campaign_leads | campaignId | campaigns.id |
| campaign_leads | leadId | leads.id |
| campaign_leads | assignedEmailAccountId | email_accounts.id |
| campaign_leads | currentStepId | sequence_steps.id |
| outreach_emails | organizationId | organizations.id |
| outreach_emails | campaignId | campaigns.id |
| outreach_emails | campaignLeadId | campaign_leads.id |
| outreach_emails | sequenceStepId | sequence_steps.id |
| outreach_emails | emailAccountId | email_accounts.id |
| outreach_analytics | organizationId | organizations.id |
| outreach_analytics | campaignId | campaigns.id |
| outreach_analytics | emailAccountId | email_accounts.id |

### Webmail Tables
| Table | FK Column | References |
|-------|-----------|------------|
| mailboxes | userId | users.id |
| mail_folders | mailboxId | mailboxes.id |
| mail_messages | mailboxId | mailboxes.id |
| mail_messages | folderId | mail_folders.id |
| mail_filters | mailboxId | mailboxes.id |
| signatures | mailboxId | mailboxes.id |
| contacts | userId | users.id |
| user_notifications | userId | users.id |

### Organizations Table
| Table | FK Column | References |
|-------|-----------|------------|
| organizations | owner_id | users.id |

**Total: ~45 FK columns across 25+ tables**

## Existing Indexes (already defined in schema.ts)
- organization_users: `org_user_unique` (orgId, userId) - unique
- outlook_mailboxes: `outlook_mailboxes_org_email_unique` (orgId, email), `outlook_mailboxes_microsoft_user_unique` (microsoftUserId)
- email_accounts: `email_account_org_email_unique` (orgId, email)
- leads: `lead_org_email_unique` (orgId, email)
- campaign_leads: `campaign_lead_unique` (campaignId, leadId) - unique
- outreach_emails: `outreach_emails_campaign_lead_step_unique` (campaignLeadId, sequenceStepId) - unique
- outreach_analytics: `outreach_analytics_org_date_unique` (orgId, date, campaignId, emailAccountId) - unique
- templates: `template_org_slug_unique` (orgId, slug)
- suppressions: `suppression_org_email_unique` (orgId, emailAddress)
- statistics: `stats_org_date_unique` (orgId, date)
- sequence_steps: `sequence_step_order_unique` (sequenceId, stepOrder)
- mail_folders: `mail_folder_mailbox_remote_unique` (mailboxId, remoteId)
- mail_messages: `mail_message_mailbox_uid_unique` (mailboxId, remoteUid)
- contacts: `contact_user_email_unique` (userId, email)

**Example index in sql/indexes.sql:** `idx_messages_organization_id ON messages (organization_id)`

## Critical Query Patterns (from roadmap success criteria)

1. **Dashboard stats**: `messages WHERE organizationId = ? AND status = ?` → composite index (organizationId, status)
2. **Campaign lead counts**: `campaignLeads WHERE campaignId = ? AND status = ?` → composite index (campaignId, status)
3. **Send pipeline cron**: `campaignLeads WHERE nextScheduledAt <= now()` → index on nextScheduledAt
4. **Tracking lookup**: `messages WHERE token = ?` → index on token

## Drizzle index() API Pattern

```typescript
import { index, uniqueIndex, pgTable } from "drizzle-orm/pg-core";

export const table = pgTable('table_name', {
  column: uuid('column').references(() => other.id),
}, (table) => ({
  idxName: index('idx_name').on(table.column),
  // Composite:
  idxComposite: index('idx_composite').on(table.columnA, table.columnB),
}))
```

## Decisions
- Indexes defined in schema.ts using Drizzle `index()` API (IDX-06)
- Applied via `CREATE INDEX CONCURRENTLY` in sql/indexes.sql (not db:push)
- Old `013_add_performance_indexes.sql` superseded — mark deprecated in Phase 09
- No `serverId` FK exists — removed in earlier migration (RLS cleanup)
- `serverId` in IDX-01 requirement is obsolete — only index actual FK columns

## Risks
- Schema.ts is large (1263 lines) — careful editing needed
- Must add `index` import to drizzle-orm/pg-core imports
- db:push may fail if CONCURRENTLY indexes are attempted in transaction — separate sql/indexes.sql handles this
- Duplicate indexes (existing unique indexes already cover some FK columns) — avoid redundant single-column indexes where composite unique already exists
