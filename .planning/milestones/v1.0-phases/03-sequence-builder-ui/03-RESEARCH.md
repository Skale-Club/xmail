# Phase 3: Sequence Builder UI - Research

**Researched:** 2026-03-30
**Domain:** React UI wiring — form to API, route params, field name correction
**Confidence:** HIGH (all findings sourced directly from codebase)

## Summary

`NewSequencePage` is a functional UI component with complete step-builder rendering but a broken save path: `handleSave` does `console.log` instead of calling the API. The API endpoints already exist and are fully implemented. The problem is not architecture — it is wiring.

There are three concrete defects to fix: (1) `handleSave` replaces the console.log with two real API calls, (2) the local `Step` interface uses `delayDays` and `bodyHtml` but the API/schema requires `delayHours` and `htmlBody`, and (3) `NewSequencePage` receives no `campaignId` because its route pattern `/outreach/sequences/new` has no `:id` param and the page does not read one.

The `SequencesPage` already contains a working reference implementation — `createSequenceWithSteps` plus a `useMutation` wrapping it — that correctly targets the API with the right field names. `NewSequencePage` can be rewired to replicate this pattern.

**Primary recommendation:** Replace the `handleSave` stub in `NewSequencePage` with a `useMutation` call that mirrors `SequencesPage.createSequenceWithSteps`, fix the two field name mismatches in the `Step` interface and its usages, and change the route/import in `main.tsx` to supply `:id` as `campaignId`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEQ-01 | `NewSequencePage` save button calls `POST /api/outreach/campaigns/:campaignId/sequences` then `POST .../steps` for each step | API routes confirmed at lines 585 and 663 of campaigns.ts; pattern already implemented in SequencesPage.createSequenceWithSteps |
| SEQ-02 | Use correct field names: `delayHours` (not `delayDays`), `htmlBody` (not `bodyHtml`) | Schema confirmed: `delay_hours` column (delayHours camelCase), `html_body` column (htmlBody camelCase); Zod schema in campaigns.ts lines 44-54 validates these names |
| SEQ-03 | `NewSequencePage` receives `campaignId` from route param `/outreach/campaigns/:id/sequences/new` | Route does not exist in main.tsx; page does not read `useParams`/`useRoute`; pattern available from OrganizationDetailPage (useRoute) and EmailDetailPage (useParams) |
| SEQ-04 | Route for `NewSequencePage` added to `src/main.tsx` with the `:id` param pattern | main.tsx currently maps `/outreach/sequences/new` → `SequencesPage` (not `NewSequencePage`); `NewSequencePage` is not imported or routed at all |
| SEQ-05 | After successful save, user navigates to campaign/sequences list with success toast | Pattern: useMutation onSuccess calls toast + setLocation; reference: SequencesPage createMutation.onSuccess |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Frontend stack:** React 18, Vite, TailwindCSS, shadcn/ui (Radix UI), wouter (routing), TanStack React Query, react-hook-form + Zod
- **API client:** Use `apiFetch` / `apiRequest` from `src/lib/api-client.ts` — NOT `lib/api` (that is the old client, only NewInboxPage still uses it, which is a QUAL-01 defect)
- **Toast:** Import `toast` from `../../../components/ui/toaster` — not any third-party lib
- **No testing framework configured** — no test files expected in this phase
- **ESLint: zero warnings** — unused imports must be removed (`Plus` in NewSequencePage is already flagged as QUAL-02)
- **Path alias:** `@/*` maps to `./src/*`

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| wouter | project-installed | Client routing + `useParams` / `useRoute` / `useLocation` | Only router in use; both `useParams` and `useRoute` patterns confirmed in codebase |
| @tanstack/react-query | project-installed | `useMutation` for API calls, `useQueryClient` for cache invalidation | All outreach pages use this pattern |
| src/lib/api-client | internal | `apiFetch` / `apiRequest` for authenticated fetch | Official API client for all outreach pages |
| src/components/ui/toaster | internal | `toast({ title, variant })` for user feedback | Used in SequencesPage, CampaignsPage, NewSequencePage |

### Field Names (verified against schema and API)
| UI currently uses | Must change to | Source |
|------------------|---------------|--------|
| `delayDays` | `delayHours` | `sequenceSteps.delayHours` (schema.ts line 762); Zod: `z.number().int().min(0).default(0)` |
| `bodyHtml` | `htmlBody` | `sequenceSteps.htmlBody` (schema.ts line 766); Zod: `z.string().optional()` |

### API Endpoints (verified from campaigns.ts)
| Action | Route | Method | Body | Response |
|--------|-------|--------|------|----------|
| Create sequence | `/api/outreach/campaigns/:campaignId/sequences` | POST | `{ name, description? }` | `{ sequence: { id, ... } }` |
| Create step | `/api/outreach/campaigns/sequences/:sequenceId/steps` | POST | `{ stepOrder, type, delayHours, subject?, htmlBody?, plainBody? }` | `{ step: { id, ... } }` |

Note: The base path is `/api/outreach/campaigns` — confirmed from `outreach/index.ts` which mounts the campaigns router at `/campaigns`, and `server/index.ts` mounts outreach at `/api/outreach`.

---

## Architecture Patterns

### Pattern 1: useMutation with sequential API calls (reference: SequencesPage)

`SequencesPage` already implements the exact flow `NewSequencePage` needs. `createSequenceWithSteps` in `SequencesPage.tsx` (lines 79-108):

```typescript
// Source: src/pages/outreach/SequencesPage.tsx lines 79-108
async function createSequenceWithSteps(params: {
    campaignId: string
    name: string
    description?: string
    steps: DraftStep[]
}) {
    const sequenceResponse = await apiFetch<{ sequence: Sequence }>(
        `/api/outreach/campaigns/${params.campaignId}/sequences`,
        { method: 'POST', body: JSON.stringify({ name: params.name, description: params.description }) }
    )

    for (const step of params.steps) {
        await apiRequest(`/api/outreach/campaigns/sequences/${sequenceResponse.sequence.id}/steps`, {
            method: 'POST',
            body: JSON.stringify({
                stepOrder: step.stepOrder,
                type: step.type,
                delayHours: step.delayHours,
                subject: step.type === 'email' ? step.subject : undefined,
                htmlBody: step.type === 'email' ? step.htmlBody : undefined,
                plainBody: step.type === 'email' ? step.plainBody || undefined : undefined,
            }),
        })
    }
    return sequenceResponse.sequence
}
```

The mutation wiring:
```typescript
// Source: src/pages/outreach/SequencesPage.tsx lines 433-443
const createMutation = useMutation({
    mutationFn: createSequenceWithSteps,
    onSuccess: () => {
        toast({ title: 'Sequence created successfully', variant: 'success' })
        queryClient.invalidateQueries({ queryKey: ['sequences'] })
        setLocation('/outreach/sequences')
    },
    onError: (error: Error) => {
        toast({ title: 'Failed to create sequence', description: error.message, variant: 'destructive' })
    },
})
```

### Pattern 2: Route param extraction (reference: OrganizationDetailPage and EmailDetailPage)

Two approaches are used in the codebase:

```typescript
// useRoute — from OrganizationDetailPage (src/pages/admin/OrganizationDetailPage.tsx line 56)
const [, params] = useRoute('/admin/organizations/:id')
const orgId = params?.id

// useParams — from EmailDetailPage (src/pages/mail/EmailDetailPage.tsx line 155)
const params = useParams<{ folder: string; id: string }>()
```

For `NewSequencePage`, the component renders inside a matched route, so `useParams<{ id: string }>()` is the simpler choice. It returns the param typed by the generic — returns `null` when no match, so guard with `params?.id` or read as `params!.id` inside a matched route.

### Pattern 3: Toast notifications

```typescript
// Source: src/components/ui/toaster.tsx line 31
// Import: import { toast } from '../../../components/ui/toaster'
toast({ title: 'Sequence created successfully', variant: 'success' })
toast({ title: 'Failed to save sequence', variant: 'destructive' })
toast({ title: 'Please enter a sequence name', variant: 'destructive' })
// variants: 'default' | 'success' | 'destructive'
```

### Pattern 4: Post-save navigation

```typescript
// Source: SequencesPage.tsx onSuccess and NewInboxPage.tsx smtpMutation.onSuccess
const [, setLocation] = useLocation()
// in onSuccess:
setLocation('/outreach/sequences')
```

After successful save, navigate to the sequences list for the campaign. The success criteria says "campaign/sequences list" — the existing `/outreach/sequences` route shows all sequences. After Phase 3 there is no campaign-specific sequences list page, so `/outreach/sequences` is the correct destination.

### Recommended Project Structure (for this phase)

No new files needed. All changes are confined to:
```
src/
├── main.tsx                                          # Add new route + import
└── pages/outreach/sequences/
    └── NewSequencePage.tsx                           # Wire save, fix field names, read campaignId
```

### Anti-Patterns to Avoid

- **Do not import from `lib/api`**: `NewInboxPage` uses the old `lib/api` (QUAL-01 defect). `NewSequencePage` must use `lib/api-client`.
- **Do not use `Math.random()` for step IDs**: The current page already uses `Math.random().toString(36).substring(7)` for local UI IDs. This is fine for local state keys but must never be sent to the API as a DB id.
- **Do not add `Content-Type: application/json` header manually**: `apiFetch`/`apiRequest` set it automatically when body is a string (api-client.ts line 139).
- **Do not leave `Plus` import**: Already flagged as unused (QUAL-02). Remove it when fixing the file.
- **Do not rename `bodyHtml` → `htmlBody` only in one place**: The `Step` interface at line 12, the `updateStep` call at line 156, the `bodyHtml` usage in `<textarea>` at line 155, and the save payload all reference this name. All four spots must change together.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Sequential API calls | Custom retry/rollback | `async function` + `for...of` loop | SequencesPage already does this; atomic enough for now |
| Toast notifications | Custom notification component | `toast()` from `ui/toaster` | Already installed and wired to `<Toaster />` in main.tsx |
| Auth headers on API calls | Manual Bearer token | `apiFetch`/`apiRequest` | api-client handles token refresh and 401 retry |

---

## Common Pitfalls

### Pitfall 1: Route ordering in main.tsx
**What goes wrong:** Adding `/outreach/campaigns/:id/sequences/new` AFTER `/outreach/campaigns` causes wouter to never match it because `/outreach/campaigns` (as a Switch case) matches first.
**Why it happens:** wouter `Switch` is first-match-wins, and without exact matching a shorter prefix can shadow a longer path.
**How to avoid:** Place the new route `/outreach/campaigns/:id/sequences/new` BEFORE the `/outreach/campaigns` route in the Switch block.
**Warning signs:** Navigating to `/outreach/campaigns/abc123/sequences/new` renders `CampaignsPage` instead of `NewSequencePage`.

### Pitfall 2: `delayDays` → `delayHours` unit mismatch
**What goes wrong:** The current UI labels the delay input "days" and multiplies by nothing. The API schema stores hours. The default in `SequencesPage` for a delay step is `delayHours: 72` (3 days). `NewSequencePage` uses `delayDays: 3` (meaning 3, which the API would treat as 3 hours).
**How to avoid:** Rename the field to `delayHours`, update the UI label from "days" to "hours", and set the default for delay steps to `72` (or a value in hours, not days).

### Pitfall 3: `campaignId` is null when `useParams` is called outside a matched route
**What goes wrong:** If the route pattern in main.tsx does not match (typo, wrong nesting), `useParams` returns `null` for the param. The API call to `POST .../campaigns/undefined/sequences` will return 404 or create a record with a null FK, causing a DB constraint violation.
**How to avoid:** Add a guard: if no `campaignId` param, show an error or navigate back. The save button should be disabled when `campaignId` is missing.

### Pitfall 4: Step field name mismatch — two separate properties
**What goes wrong:** There are two distinct wrong names: `delayDays` (should be `delayHours`) and `bodyHtml` (should be `htmlBody`). Fixing one and missing the other results in a partial Zod validation failure on the server — the step record inserts with a null `htmlBody` silently, since Zod marks it as optional.
**Warning signs:** Steps save without error but appear with no body when fetched.

### Pitfall 5: `Plus` unused import — ESLint failure
**What goes wrong:** `Plus` is imported from lucide-react but not used in the JSX. With `npm run lint` set to zero warnings, CI will fail.
**How to avoid:** Remove the `Plus` import when touching the file.

---

## Code Examples

### Complete handleSave replacement
```typescript
// Replace the current handleSave stub in NewSequencePage.tsx
// Uses the same pattern as SequencesPage.createSequenceWithSteps

const queryClient = useQueryClient()
const [, setLocation] = useLocation()
const params = useParams<{ id: string }>()
const campaignId = params?.id

const createMutation = useMutation({
    mutationFn: async (payload: { name: string; steps: Step[] }) => {
        if (!campaignId) throw new Error('No campaign ID')
        const { sequence } = await apiFetch<{ sequence: { id: string } }>(
            `/api/outreach/campaigns/${campaignId}/sequences`,
            { method: 'POST', body: JSON.stringify({ name: payload.name }) }
        )
        for (const step of payload.steps) {
            await apiRequest(`/api/outreach/campaigns/sequences/${sequence.id}/steps`, {
                method: 'POST',
                body: JSON.stringify({
                    stepOrder: step.order,
                    type: step.type,
                    delayHours: step.delayHours,
                    subject: step.type === 'email' ? step.subject : undefined,
                    htmlBody: step.type === 'email' ? step.htmlBody : undefined,
                }),
            })
        }
        return sequence
    },
    onSuccess: () => {
        toast({ title: 'Sequence created successfully', variant: 'success' })
        queryClient.invalidateQueries({ queryKey: ['sequences'] })
        setLocation('/outreach/sequences')
    },
    onError: (error: Error) => {
        toast({ title: 'Failed to save sequence', description: error.message, variant: 'destructive' })
    },
})

const handleSave = () => {
    if (!name.trim()) {
        toast({ title: 'Please enter a sequence name', variant: 'destructive' })
        return
    }
    createMutation.mutate({ name, steps })
}
```

### Route additions in main.tsx
```typescript
// Add import at top (with other outreach lazy imports):
const NewSequencePage = React.lazy(() => import('./pages/outreach/sequences/NewSequencePage'))

// Add route in Switch — BEFORE the /outreach/campaigns route:
<Route path="/outreach/campaigns/:id/sequences/new">
    <AdminCheck>
        <OrganizationProvider>
            <PageSuspense><NewSequencePage /></PageSuspense>
        </OrganizationProvider>
    </AdminCheck>
</Route>
```

### Step interface corrections
```typescript
// Replace in NewSequencePage.tsx:
interface Step {
    id: string
    type: 'email' | 'delay'
    order: number
    delayHours: number      // was delayDays
    subject: string
    htmlBody: string        // was bodyHtml
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `console.log` save stub | Real API call via useMutation | This phase | Sequences actually persist |
| Local IDs (`Math.random`) | DB-assigned UUIDs returned by API | This phase | Steps addressable by server |
| No route param | `/outreach/campaigns/:id/sequences/new` | This phase | Campaign FK populated correctly |

---

## Current State of NewSequencePage (Defect Inventory)

| Defect | Location | Fix |
|--------|----------|-----|
| `handleSave` does `console.log`, not API call | line 62 | Replace with `createMutation.mutate(...)` |
| `Step.delayDays` wrong field name | line 11 | Rename to `delayHours` |
| `Step.bodyHtml` wrong field name | line 12 | Rename to `htmlBody` |
| UI label says "days" for delay | line 139 | Change label to "hours" |
| `delayDays: parseInt(...)` in updateStep | line 136 | Change key to `delayHours` |
| `delayDays: type === 'delay' ? 3 : 0` in addStep | line 37 | Change key + value to `delayHours: 72` |
| No `campaignId` read from route | entire file | Add `useParams<{id:string}>()` |
| No `useMutation` / `useQueryClient` import | line 1 | Add imports from `@tanstack/react-query` |
| No `apiFetch`/`apiRequest` import | line 1 | Add imports from `../../lib/api-client` |
| `Plus` imported but unused | line 2 | Remove (QUAL-02) |
| No route in main.tsx for `NewSequencePage` | main.tsx | Add route with `:id` param |

---

## Open Questions

1. **Post-save destination: campaign detail or global sequences list?**
   - What we know: Success criteria says "campaign/sequences list". No campaign detail page exists in the codebase today.
   - What's unclear: Whether `/outreach/sequences` is sufficient or whether a campaign-scoped view is intended.
   - Recommendation: Navigate to `/outreach/sequences` — that is the only sequences list page; it shows all sequences grouped by campaign name. A campaign-specific sequences view is out of scope for this milestone.

2. **Delay unit label: hours or days?**
   - What we know: Schema and API both use `delayHours` (integer). The current UI shows "days". `SequencesPage` labels it "Delay in Hours" with a default of 72.
   - Recommendation: Match `SequencesPage` — label "hours", default 72 for delay steps. Document this clearly in the task so the implementer does not preserve the "days" label.

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — this phase is UI code changes only with no new tools, runtimes, or services required).

---

## Validation Architecture

nyquist_validation is explicitly `false` in `.planning/config.json`. This section is omitted.

---

## Sources

### Primary (HIGH confidence)
- `src/pages/outreach/sequences/NewSequencePage.tsx` — direct inspection of broken save handler and wrong field names
- `src/pages/outreach/SequencesPage.tsx` — reference implementation for createSequenceWithSteps, useMutation, toast, navigation
- `src/server/routes/outreach/campaigns.ts` — API route definitions: POST /:campaignId/sequences (line 585), POST /sequences/:sequenceId/steps (line 663), Zod schemas (lines 38-55)
- `src/db/schema.ts` — column names: `delay_hours` → `delayHours`, `html_body` → `htmlBody`, `plain_body` → `plainBody`
- `src/main.tsx` — confirmed NewSequencePage is not imported/routed; current routes for outreach sequences
- `src/lib/api-client.ts` — confirmed `apiFetch` and `apiRequest` signatures
- `src/components/ui/toaster.tsx` — toast API: `toast({ title, description?, variant? })`

### Secondary (MEDIUM confidence)
- `src/pages/admin/OrganizationDetailPage.tsx` — `useRoute` pattern example
- `src/pages/mail/EmailDetailPage.tsx` — `useParams` pattern example
- `src/pages/outreach/inboxes/NewInboxPage.tsx` — confirmed anti-pattern: imports from `lib/api` (old client), should NOT be replicated

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all from direct source inspection
- Architecture: HIGH — exact patterns extracted from working reference implementations in SequencesPage
- Pitfalls: HIGH — derived from concrete line-level defects found in the files

**Research date:** 2026-03-30
**Valid until:** Until any of these files change: campaigns.ts API routes, schema.ts sequence tables, SequencesPage.tsx mutation pattern
