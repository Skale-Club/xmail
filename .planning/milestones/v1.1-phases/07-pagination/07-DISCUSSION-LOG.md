# Phase 07: Pagination - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 07-pagination
**Areas discussed:** Utility, Frontend UI, Page size

---

## Utility

| Option | Description | Selected |
|--------|-------------|----------|
| Shared utility (Recommended) | Extract count+query+response into a reusable function — DRY, consistent, easier to maintain | ✓ |
| Inline (match existing) | Keep pagination inline per route — matches current codebase style, less refactoring | |

**User's choice:** Shared utility (Recommended)
**Notes:** Extract the duplicated inline pagination pattern into a shared helper function.

---

## Frontend UI

| Option | Description | Selected |
|--------|-------------|----------|
| Add pagination controls (Recommended) | Simple prev/next + page indicator. Requirements say list endpoints need pagination. | ✓ |
| Backend only for now | Just make endpoints accept params. Add UI in a later phase. | |
| Use existing infinite scroll hook | useInfiniteScroll.ts already exists for webmail — reuse it for outreach lists | |

**User's choice:** Add pagination controls (Recommended)
**Notes:** Simple prev/next buttons + page indicator for all outreach list pages.

---

## Page size

| Option | Description | Selected |
|--------|-------------|----------|
| 25 (Recommended) | Faster initial load, matches requirements example | ✓ |
| 50 (match existing) | Consistent with messages/contacts endpoints | |

**User's choice:** 25 (Recommended)
**Notes:** Default page size is 25 items.

---

## Agent's Discretion

- Utility function location and naming
- Whether to also paginate per-campaign sequences endpoint

## Deferred Ideas

- Infinite scroll for outreach lists (could reuse useInfiniteScroll.ts from webmail)
- Cursor-based pagination (v2 requirement CURSOR-01)
- Pre-computed denormalized counts (v2 requirement CACHE-01)
