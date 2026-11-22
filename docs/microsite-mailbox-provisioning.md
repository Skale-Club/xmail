# Microsite mailbox provisioning

Narrow server-to-server API so the Skale Club Websites platform can make `info@<domain>` work for
each Skale-owned microsite (owner decision D-015). It is deliberately separate from the outreach
service key and from every human route.

## Product decision (recorded)

- `info@<domain>` is a FULL NATIVE MAILBOX per domain. One mailbox per domain keeps each site
  independent and transferable on sale.
- It is owned by a dedicated mailbox user (`users` row, email `info@<domain>`) with NO password:
  no password is generated, returned or logged, and SMTP/IMAP login is impossible for it
  (`authenticateNativeUser` rejects a null hash).
- All mailbox users belong to ONE bound Xmail organization, named **Owned Microsites** in the
  runbook. That organization is the grouping category: the webmail switcher groups mailboxes by
  the owner's organization name, so the owner sees every site mailbox under "Owned Microsites"
  and never mixed with other mail.
- Designated delegate users (the owner, env `XMAIL_PROVISIONING_DELEGATE_USER_IDS`) read the
  mailbox in Xmail webmail with their own login, through the new `mailbox_delegates` table.
- Inbound mail needs no new code path: the MX server resolves `info@<domain>` through
  `findLocalUser` (verified domain + `users.email`) and `findLocalNativeMailbox`, which the
  provisioned user and mailbox satisfy.

## Delegate access and isolation

- `checkUserMailboxAccess` (src/server/routes/mail/mailboxes.ts) now also admits a user listed in
  `mailbox_delegates` for that mailbox (decision in `lib/mailbox-delegation.ts`). A delegate can
  read, send as, move and delete messages in webmail. A delegate can NOT edit, deactivate or
  delete the mailbox itself (`ownerOnly` routes) and has no IMAP/SMTP access.
- `GET /api/mail/mailboxes` returns delegated mailboxes with `isDelegated: true`. They are
  classified as non-operation mailboxes (`role: 'other'`) with `organizationName: "Owned
  Microsites"`, so the client shows them in the collapsed group, not in the delegate's own
  section. Messages stay stored per mailbox id: they never land in the delegate's personal
  inbox, and the unified inbox (outreach `email_accounts`) never sees them. Opening the group
  is the only way to read them.
- The delegate list in env is the source of truth. Every ensure call re-asserts it: new
  delegates gain access on the next call, delegates removed from env are revoked.

## Warm-up and outreach exclusion

`info@` is work mail (CLAUDE.md "as três caixas"). Besides the env list
`OUTREACH_PROTECTED_DOMAINS`, provisioned microsite domains are tracked at runtime in
`microsite_mail_domains` and mirrored in memory (`lib/microsite-protected-domains.ts`, loaded at
boot, refreshed every 5 minutes and updated the moment a domain is ensured):

- `checkProtectedSendingDomains` / `isCampaignSenderEligible` reject these addresses, so campaign
  creation, activation and the agent gateway refuse them;
- `POST /api/outreach/email-accounts` refuses to create an outreach account for them;
- the warm-up mesh loader skips them even if a row was created by hand.

The mailbox user has no `email_accounts` row, so the database default `warmup_source = 'none'`
applies by construction.

## API v1

Base path `/api/provisioning/v1`. Auth: `Authorization: Bearer <XMAIL_PROVISIONING_API_KEY>`,
compared in constant time. The API is bound to the organization in
`XMAIL_PROVISIONING_ORG_ID`; callers can never choose an organization. Key or org unset: every
route answers `503 {"error":"provisioning_disabled"}`. Bad token: `401 {"error":"invalid_token"}`.
Own rate limiter (120 requests/minute/IP). No DELETE.

`:domain` is a lowercase hostname. Errors: `400 invalid_domain`, `400 invalid_site_ref`,
`403 protected_domain` (MAIL_DOMAIN, OUTREACH_PROTECTED_DOMAINS, MAIL_HOST, `skale.club` and every
subdomain including `*.staging.skale.club`), `404 domain_not_found`,
`409 domain_owned_elsewhere` (never says which org), `409 mailbox_user_conflict` (a login-capable
or admin user already holds `info@<domain>`; it is never adopted), `500 internal_error`.

| Route | Behavior |
| --- | --- |
| `GET /domains/:domain` | Strictly read-only: no key generation, no backfill, no audit. 404 if the bound org has no such domain. |
| `PUT /domains/:domain` body `{siteRef}` | Idempotent ensure of the domain in the bound org, DKIM keys generated once. 201 created, 200 existed. Concurrent calls converge (per-name advisory lock). |
| `PUT /domains/:domain/mailboxes/info` body `{siteRef}` | Idempotent ensure of user, org membership, native mailbox, folders, delegate access. Also ensures the domain if it is missing, so ONE call does everything (`siteRef` required only when the domain is not yet provisioned; later calls may send `{}`). 201 when something was created, else 200. |
| `POST /domains/:domain/verify` | Runs the existing DNS verification, writes only the verification columns, returns the status. |

Every route returns the same status object:

```json
{
  "domain": "acme.com",
  "state": "dns_pending",
  "verification": { "status": "pending", "mx": "pending", "spf": "pending", "dkim": "pending", "dmarc": "pending" },
  "dnsRecords": [{ "type": "MX", "name": "@", "value": "mx.skale.club", "purpose": "mx", "required": true, "priority": 10 }],
  "mailbox": { "address": "info@acme.com", "exists": true, "mailboxRef": "<opaque id>", "lastInboundAt": null, "messageCount": 0 },
  "ready": false
}
```

States: `not_provisioned` (no mailbox yet), `suspended` (mailbox deactivated), `dns_pending`
(ownership TXT, MX, SPF or DKIM not verified), `inbound_pending` (DNS verified, no message
received), `ready`. `ready` requires verified DNS AND the mailbox AND at least one received
message (any folder except Sent/Drafts). DMARC and Return-Path are published but advisory
(`required: false`). `dnsRecords` come from the existing domain configuration; the DKIM private
key never leaves the server and `mailboxRef` is an id, never a credential.

Every write is audited in `microsite_provisioning_audit` (action, domain, siteRef, outcome,
detail), never with secrets.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `XMAIL_PROVISIONING_API_KEY` | Bearer secret shared with the Websites platform (`openssl rand -base64 32`). |
| `XMAIL_PROVISIONING_ORG_ID` | UUID of the "Owned Microsites" organization. |
| `XMAIL_PROVISIONING_DELEGATE_USER_IDS` | Comma-separated user UUIDs allowed to read every site mailbox. |

Added to `.github/scripts/deploy-xmail.sh` (`run_app_container`, the block build-deploy.yml
actually runs), to the `env:`/`envs:` lists of `build-deploy.yml`, and to the legacy
`deploy-hetzner.yml`. Create the three GitHub secrets before the next deploy; unset secrets leave
the API disabled (503), nothing else changes.

## Operator runbook

1. Apply migration `081_microsite_mailbox_provisioning.sql` (`node scripts/apply-pending-migrations.mjs`).
   Deploys do not run migrations. Until it is applied the new routes fail with 500 and the
   delegate lookup in `checkUserMailboxAccess` would error, so apply it BEFORE deploying.
2. In Xmail admin create the organization **Owned Microsites** (no members needed). Copy its id.
3. Note the user ids of the delegates (the owner's own Xmail user).
4. Set the three secrets, deploy. Check: `GET /api/provisioning/v1/domains/example.com` answers
   401 without a token and 404 `domain_not_found` with it.
5. Per site (the Websites platform does this automatically): `PUT .../domains/<d>/mailboxes/info`
   with `{"siteRef":"websites:tenant:27"}`. Read `dnsRecords` from the response.
6. Publish the required DNS records at the domain's DNS (MX to `MAIL_HOST`, ownership TXT, SPF,
   DKIM, plus DMARC and Return-Path CNAME). Never overwrite an existing client MX/SPF without
   merging deliberately.
7. `POST .../verify`, repeat until `inbound_pending`.
8. Verify inbound with an authorized test message from a mailbox you control to `info@<d>`. The
   state becomes `ready` once Xmail stores it. Read it in webmail: the delegate sees it under
   "Owned Microsites".

## Rollback

- Disable the API: unset `XMAIL_PROVISIONING_API_KEY` (or the org id) and redeploy: every route
  answers 503. Existing mailboxes keep receiving mail.
- Revoke reading access: empty `XMAIL_PROVISIONING_DELEGATE_USER_IDS` and call the ensure route
  (grants are pruned), or `DELETE FROM mailbox_delegates WHERE mailbox_id = ...`.
- Take a site out: deactivate its mailbox (`mailboxes.is_active = false` gives state `suspended`).
  Deleting domains or mailboxes is an approved lifecycle step, deliberately not in this API.
- The migration only adds three tables and is safe to leave in place.

## Not covered here (known limits)

- No automated DB integration test of the drizzle store (the repo's DB suite needs Docker). The
  rules are unit tested against an in-memory store; the real store relies on the advisory lock
  and the unique indexes described in `lib/microsite-provisioning-store.ts`.
- Delegates use webmail only. IMAP/SMTP access for `info@` stays closed by design.
