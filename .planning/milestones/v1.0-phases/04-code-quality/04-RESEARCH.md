# Phase 4: Code Quality — Research

**Researched:** 2026-03-30
**Domain:** TypeScript static analysis, import hygiene, cron concurrency guards
**Confidence:** HIGH

## Summary

Phase 4 is a targeted cleanup pass with four narrow requirements. All four have been inspected against the actual source files. Three of the four are simple single-line edits; one (QUAL-04) requires a module-level flag variable. The scope is smaller than the requirements text implies because Phase 3 work already removed the `Plus` import from `NewSequencePage.tsx` — only `Link` in `SequencesPage.tsx` remains as a TS6133 error in an outreach file. Similarly, the private `sendEmail` function described in QUAL-03 is not present in `processOutreachSequences.ts` — Phase 1 work already removed it. These two requirements are either already done or need re-verification before touching anything.

The one genuinely open item of technical complexity is QUAL-04: the concurrency guard in `src/server/jobs/index.ts`. The existing pattern wraps each cron handler in an anonymous arrow function and calls `.catch()` on the returned Promise. The guard must be added without changing that pattern — a module-level `let isProcessing = false` flag with early-return and `finally` reset is the canonical approach.

**Primary recommendation:** Audit current state against each requirement before writing any code. Two requirements (QUAL-02 for `Plus`, QUAL-03) may already be satisfied by prior phase work.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| QUAL-01 | `NewInboxPage.tsx` import updated from `lib/api` to `lib/api-client` | File confirmed: line 14 still imports `apiFetch` from `'../../../lib/api'`; `api-client.ts` exports the same `apiFetch` symbol |
| QUAL-02 | Unused imports removed from `NewSequencePage.tsx` (`Plus`) and `SequencesPage.tsx` (`Link`) | `Plus` is NOT currently imported in `NewSequencePage.tsx` (already removed). `Link` IS imported but unused in `SequencesPage.tsx` (confirmed TS6133 at line 3) |
| QUAL-03 | `processOutreachSequences.ts` private `sendEmail` function removed | No `sendEmail` function exists in the file — already removed in Phase 1 work. Requirement may be pre-satisfied |
| QUAL-04 | Cron job concurrency guard added to `jobs/index.ts` for sequence processor | `jobs/index.ts` confirmed: no guard present. Cron fires `processOutreachSequences()` every 5 minutes with no overlap protection |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Frontend: React 18, Vite, TailwindCSS, shadcn/ui, wouter, TanStack React Query, react-hook-form + Zod
- Backend: Express 5 (beta), TypeScript, tsx (dev runner)
- No testing framework configured — success criteria must be verified by running `npx tsc --noEmit` and manual inspection
- `npm run lint` must pass (ESLint strict, zero warnings)
- Express 5 beta in use — keep awareness of non-standard patterns

## Standard Stack

### Core (all already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (project-defined) | Static type checking | Project standard |
| node-cron | (project-defined) | Cron scheduling | Already in use in `jobs/index.ts` |
| ESLint | (project-defined) | Lint enforcement | `npm run lint` command in CLAUDE.md |

### No new dependencies required
All work in this phase is edit-only. No packages need to be added or removed.

## Architecture Patterns

### Pattern 1: Module-level concurrency flag (QUAL-04)

**What:** A boolean flag at module scope guards against overlapping async cron invocations.

**When to use:** When an async job runs on a short cron interval and may take longer than the interval to complete. The sequence processor runs every 5 minutes and could theoretically overlap if the job takes more than 5 minutes.

**Correct pattern:**
```typescript
// In jobs/index.ts — module-level flag, NOT per-handler variable
let isSequenceProcessing = false

// Inside the cron schedule callback:
cron.schedule('*/5 * * * *', () => {
    if (isSequenceProcessing) {
        console.log('[jobs] processOutreachSequences already running, skipping tick')
        return
    }
    isSequenceProcessing = true
    processOutreachSequences()
        .catch((err) => console.error('[jobs] processOutreachSequences failed:', err))
        .finally(() => { isSequenceProcessing = false })
})
```

**Why `finally`:** Ensures the flag resets even when the async function throws. Without `finally`, a single error permanently blocks all future runs.

**Why module-level:** A variable declared inside the arrow function resets on every tick — it must be declared outside the `cron.schedule` call.

### Pattern 2: Import swap (QUAL-01)

**What:** Replace `'../../../lib/api'` with `'../../../lib/api-client'` in `NewInboxPage.tsx`.

**Key verification:** Both `lib/api.ts` and `lib/api-client.ts` export `apiFetch`. The signatures are compatible — `apiFetch<T>(path, options)`. No call-site changes are required, only the import path changes.

**Difference between the two modules:**
- `lib/api.ts` — older version, no retry logic, uses `ApiFetchOptions` type
- `lib/api-client.ts` — newer version, adds exponential backoff retry, uses `ApiRequestOptions` type, also exports `apiRequest`

`NewInboxPage.tsx` only uses `apiFetch` — no `apiRequest` usage — so the import swap is safe without any other changes.

### Pattern 3: Remove unused import (QUAL-02)

**What:** Remove `Link` from the `wouter` import line in `SequencesPage.tsx`.

**Current line 3:**
```typescript
import { Link, useLocation } from 'wouter'
```

**After fix:**
```typescript
import { useLocation } from 'wouter'
```

`useLocation` is used in the file; only `Link` is unused.

**Note on `Plus` / `NewSequencePage.tsx`:** The `Plus` symbol is NOT in the current import line (`import { ArrowLeft, Save, Clock, Mail, Trash2 } from 'lucide-react'`). Phase 3 work removed it. QUAL-02 for `NewSequencePage.tsx` is already satisfied.

### Pattern 4: Verify QUAL-03 (dead function removal)

**What:** The requirement says to remove a private `sendEmail` function from `processOutreachSequences.ts`.

**Actual state:** A full scan of `processOutreachSequences.ts` (332 lines) finds no `sendEmail` function. The file exports only `processOutreachSequences`, `resetDailyLimits`, and `markCompletedCampaigns`. Phase 1 work removed the private function.

**Action for planner:** The plan task for QUAL-03 should verify this precondition and mark the requirement satisfied if confirmed, rather than performing a destructive edit.

### Anti-Patterns to Avoid

- **Flag inside arrow function:** Declaring `let isProcessing = false` inside the `cron.schedule` callback — it resets every tick and provides no protection.
- **Missing `finally`:** Using only `.catch()` to reset the flag — a thrown error leaves the flag set to `true` permanently.
- **Removing `useLocation` from SequencesPage:** Only `Link` is unused; `useLocation` is actively used for navigation.
- **Changing `apiFetch` call signatures in NewInboxPage:** The function signatures between `api.ts` and `api-client.ts` are compatible — no call-site updates needed.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Concurrency guard | A queue, semaphore, or mutex class | Module-level boolean flag | The job is single-process; a simple boolean suffices. A full mutex adds complexity with no benefit. |
| Import deduplication | Custom tooling | Direct file edit | This is a one-line change per file. |

## Common Pitfalls

### Pitfall 1: Flag reset without `finally`
**What goes wrong:** The flag is set to `true` at job start and reset in `.catch()` only. If the job succeeds (no catch), or if the promise is rejected in a way that bypasses catch, the flag stays `true` and blocks all future runs silently.
**Why it happens:** Developers model it as "reset on error" rather than "reset unconditionally after completion."
**How to avoid:** Always use `.finally(() => { isSequenceProcessing = false })` — this runs whether the promise resolves or rejects.
**Warning signs:** After a deployment, the sequence job never logs "skipping tick" but also never logs send output.

### Pitfall 2: Per-tick flag variable scope
**What goes wrong:** `let isProcessing = false` placed inside the `cron.schedule(() => { ... })` callback — the flag is re-created to `false` on every tick.
**Why it happens:** Arrow function scope is easy to misread quickly.
**How to avoid:** Place the flag at module scope, above all `cron.schedule` calls.

### Pitfall 3: Assuming QUAL-02 and QUAL-03 still need work
**What goes wrong:** The plan includes tasks to remove `Plus` from `NewSequencePage.tsx` and remove `sendEmail` from `processOutreachSequences.ts` — but these are already done.
**Why it happens:** Requirements were written before Phase 3 landed; Phase 3 removed `Plus` as a side effect of its rewrite.
**How to avoid:** Verify current state first. Running `npx tsc --noEmit` shows only one TS6133 error in outreach files (`SequencesPage.tsx:3 Link`).

### Pitfall 4: TypeScript `noUnusedLocals` vs `TS6133`
**What goes wrong:** Assuming that removing the unused import fixes the error without verifying `tsconfig.json` enforces `noUnusedLocals`.
**Why it happens:** TS6133 is only emitted when `noUnusedLocals: true` is active in the tsconfig.
**How to avoid:** The error is confirmed present via `npx tsc --noEmit` output — so the tsconfig is already enforcing it. Removing the import will fix it.

## Code Examples

### Confirmed current state — TS6133 errors in outreach files
```
src/pages/outreach/SequencesPage.tsx(3,10): error TS6133: 'Link' is declared but its value is never read.
```
(From live `npx tsc --noEmit` run on 2026-03-30. No other outreach-file TS6133 errors present.)

### Confirmed current state — NewInboxPage.tsx line 14
```typescript
import { apiFetch } from '../../../lib/api'
```
Must become:
```typescript
import { apiFetch } from '../../../lib/api-client'
```

### Full TS6133 errors found (non-outreach, for awareness)
```
src/components/mail/EmailHtmlViewer.tsx(1,8):   React unused
src/components/mode-toggle.tsx(7,13):           theme unused
src/components/ui/ConfirmDialog.tsx(1,1):       React unused
src/hooks/useCompose.tsx(1,8):                  React unused
src/hooks/useMail.ts(3,64):                     ContactItem unused
src/pages/mail/ContactsPage.tsx(12,5):          Download unused
src/pages/mail/SettingsPage.tsx(20,5):          ExternalLink unused
```
These are outside the outreach module. Phase 4 success criteria requires only zero TS6133 in outreach files — the success criterion is "zero TS6133 errors across all outreach files," not zero across the entire codebase.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `lib/api.ts` (`apiFetch`) | `lib/api-client.ts` (`apiFetch` + `apiRequest` with retry) | Existing in codebase | `NewInboxPage.tsx` is the last outreach page still on the old module |
| Private `sendEmail` in processOutreachSequences | Removed; delegates to `outreach-sender.ts` | Phase 1 | QUAL-03 pre-satisfied |
| No cron guard | `isProcessing` flag needed | Phase 4 | Prevents stacked runs |

## Environment Availability

Step 2.6: SKIPPED — Phase 4 is purely code/config changes with no external dependencies.

## Open Questions

1. **QUAL-03 pre-satisfaction**
   - What we know: No `sendEmail` function exists in `processOutreachSequences.ts` as of 2026-03-30
   - What's unclear: Whether requirements tracking should mark QUAL-03 as done or the plan should include a verification-only task
   - Recommendation: Include a single verification task that confirms absence and marks REQUIREMENTS.md `QUAL-03` as `[x]`

2. **QUAL-02 `Plus` pre-satisfaction**
   - What we know: `Plus` is not in `NewSequencePage.tsx` imports
   - What's unclear: Same as above — was it ever there and removed, or never added?
   - Recommendation: Same — a verification task that confirms TS6133 output has no `Plus`-related entry and marks `[x]`

3. **Other TS6133 errors outside outreach scope**
   - What we know: 7 other TS6133 errors exist in non-outreach files
   - What's unclear: Whether success criteria ("zero TS6133 across all outreach files") means these are acceptable
   - Recommendation: Leave non-outreach TS6133 errors alone. Phase success criteria is scoped to outreach files only.

## Sources

### Primary (HIGH confidence)
- Direct file inspection of `src/pages/outreach/inboxes/NewInboxPage.tsx` — import on line 14
- Direct file inspection of `src/pages/outreach/sequences/NewSequencePage.tsx` — no `Plus` in lucide import
- Direct file inspection of `src/pages/outreach/SequencesPage.tsx` — `Link` unused at line 3
- Direct file inspection of `src/server/jobs/index.ts` — no concurrency guard present
- Direct file inspection of `src/server/jobs/processOutreachSequences.ts` (332 lines) — no `sendEmail` function
- Live `npx tsc --noEmit` output — confirms exactly one TS6133 error in outreach files

### Secondary (MEDIUM confidence)
- `lib/api.ts` vs `lib/api-client.ts` comparison — `apiFetch` signatures are compatible; import swap is safe

## Metadata

**Confidence breakdown:**
- Requirement states (pre-satisfied vs pending): HIGH — verified by direct file inspection and tsc output
- Concurrency guard pattern: HIGH — standard Node.js module-level flag pattern
- Import compatibility: HIGH — both files confirmed to export `apiFetch` with compatible signatures

**Research date:** 2026-03-30
**Valid until:** 2026-04-30 (stable codebase — changes only from parallel phase work)
