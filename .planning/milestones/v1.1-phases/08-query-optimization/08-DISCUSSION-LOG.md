# Phase 08: Query Optimization - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 08-query-optimization
**Areas discussed:** Scope

---

## Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Roadmap scope only (Recommended) | Stick to QRY-01, QRY-02, QRY-03 as defined. Extras noted for future phases. | |
| Roadmap + HIGH extras | Include the 2 HIGH extras (suppression check batching, unbounded leads query) plus the roadmap scope. | |
| Roadmap + all extras | Include all extras found in the audit. | ✓ |

**User's choice:** Roadmap + all extras
**Notes:** Scope expanded to include all 11 N+1 patterns found in codebase audit.

---

## Agent's Discretion

- How much to batch (memory vs query trade-offs)
- Whether to add a runFiltersOnMessage batch variant for mail batch updates

## Deferred Ideas

- Cursor-based pagination (v2)
- Pre-computed denormalized counts (v2)
- Slow query logging with EXPLAIN ANALYZE (v2)
- Connection pooling changes (out of scope)
