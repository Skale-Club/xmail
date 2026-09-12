-- Fase 1 (docs/outbound-authentication-audit.md) — DMARC aggregate report ingestion.
--
-- The audit's central finding: "o sistema afirma DKIM enabled e não tem como confirmar o que
-- chegou do outro lado". DMARC aggregate reports (RFC 7489 section 7) are that confirmation —
-- Google/Microsoft/Yahoo etc. send them daily to whatever address a domain's DMARC `rua` names,
-- reporting per source IP how many messages passed/failed SPF and DKIM, both the raw validation
-- result AND the DMARC-aligned verdict (which can differ — see dmarc-parser.ts's module header).
--
-- Two tables, normalized: dmarc_reports is one row per ingested <feedback> document (report-level
-- fields: who sent it, what domain, what date range); dmarc_report_records is one row per <record>
-- block inside it (per-source-IP results). Dedup is enforced at the REPORT level — see
-- dmarc_reports_org_report_domain_unique below — so re-reading an already-processed message (the
-- ingest job marks messages read, but a retry/replay must still be safe) can never double-count
-- by re-inserting the same report's records twice: the report insert is ON CONFLICT DO NOTHING,
-- and a report that already exists never has its records path re-run (see dmarc-ingest.ts).
--
-- No CREATE INDEX CONCURRENTLY (fails inside scripts/apply-pending-migrations.mjs's per-file
-- transaction, per CLAUDE.md). No BEGIN/COMMIT — the runner wraps this file in its own
-- transaction already.

CREATE TABLE IF NOT EXISTS dmarc_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Resolved at ingestion by matching the report's policy domain against `domains.name`
    -- (see dmarc-ingest.ts). Nullable: a third party can address dmarc@skale.club's mailbox
    -- about a domain we do not (or no longer) host — the report is still stored for audit, just
    -- unattributed to a tenant.
    organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
    -- policy_published/domain, lowercased. NOT unique alone: the same reporting org can report
    -- on more than one of our domains, and report_id is only unique WITHIN a reporting org.
    domain text NOT NULL,
    reporting_org text NOT NULL,
    report_id text NOT NULL,
    date_range_begin timestamptz NOT NULL,
    date_range_end timestamptz NOT NULL,
    -- mail_messages.id this report was extracted from, if still resolvable — best-effort
    -- traceability for a human debugging a specific report, not a referenced FK (the source
    -- message can legitimately be deleted/expunged later without invalidating the report).
    source_message_id uuid,
    record_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Dedup key (Part A.2's requirement: "dedupe on report id + org so re-reading a message
    -- never double-counts"). Scoped to domain too because report_id uniqueness is only
    -- guaranteed by RFC 7489 within (reporting org, policy domain) — including domain costs
    -- nothing and removes a theoretical cross-domain collision.
    CONSTRAINT dmarc_reports_org_report_domain_unique UNIQUE (reporting_org, report_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain_range
    ON dmarc_reports (domain, date_range_begin);
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_created_at
    ON dmarc_reports (created_at);

CREATE TABLE IF NOT EXISTS dmarc_report_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL REFERENCES dmarc_reports(id) ON DELETE CASCADE,
    source_ip text,
    message_count integer NOT NULL DEFAULT 1,
    -- policy_evaluated/disposition — none | quarantine | reject. Free text, not an enum: this
    -- is third-party-authored data (see dmarc-parser.ts's module header) and an unexpected
    -- value must be storable for debugging, not rejected at the schema level.
    disposition text,
    -- auth_results/dkim — the RAW (pre-alignment) validation result and the domain that
    -- actually signed (may differ from header_from — a legitimate forwarder can DKIM-sign
    -- with its own domain).
    dkim_result text,
    dkim_domain text,
    -- auth_results/spf — same shape, for SPF.
    spf_result text,
    spf_domain text,
    -- identifiers/header_from — the domain DMARC alignment is actually judged against.
    header_from text,
    -- policy_evaluated/dkim and /spf — the ALIGNED verdict DMARC itself computed. This is
    -- deliberately separate from dkim_result/spf_result above: a message can have dkim_result
    -- = pass (the signature validates) while policy_dkim_aligned = fail (it validates for a
    -- domain that does not align with header_from) — exactly the distinction Fase 1's query
    -- module needs to answer "DKIM passed" vs "DMARC passed" as two different numbers.
    policy_dkim_aligned text,
    policy_spf_aligned text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dmarc_report_records_report_id
    ON dmarc_report_records (report_id);
-- Drives Part A.3's rate query (per domain/date range): join back to dmarc_reports on
-- report_id, filter on header_from for the domain being asked about.
CREATE INDEX IF NOT EXISTS idx_dmarc_report_records_header_from
    ON dmarc_report_records (header_from);
