# Testing Patterns

**Analysis Date:** 2026-07-16

> Phase 18-01 update: Vitest is now configured with mutually exclusive `server`
> (Node `.test.ts`), `client` (jsdom `.test.tsx`), and `postgres`
> (Testcontainers `.db.test.ts`) projects. Use `npm run test -- <file>` for every
> targeted test; database targets are guarded loopback URLs and never fall back to
> application `DATABASE_URL`.

## Test Infrastructure

| Component | Technology | Config File |
|----------|-----------|------------|
| Test Runner | None configured | N/A |
| Assertion Library | N/A | N/A |
| Mocking Framework | N/A | N/A |
| E2E Framework | None | N/A |

**Confirmed:** No testing framework is configured in this codebase.

**Evidence:**
- `package.json` — no test runner in `scripts`, no jest/vitest/playwright in `devDependencies`
- No `jest.config.*` or `vitest.config.*` at project root
- No `*.test.*` or `*.spec.*` files anywhere under `src/`
- `CLAUDE.md` explicitly states: "No testing framework is currently configured"

## Test Types

| Type | Framework | Location | Count |
|-----|----------|----------|-------|
| Unit Tests | None | N/A | 0 |
| Integration Tests | None | N/A | 0 |
| E2E Tests | None | N/A | 0 |

## Test Commands

| Command | Purpose |
|--------|---------|
| `npm run lint` | ESLint validation only |
| N/A | No test runner |

## Coverage

**Current coverage:** 0%

No tests exist in the codebase. All validation is done via:
- TypeScript strict mode (`strict: true`)
- ESLint linting (`npm run lint`)
- Zod schema validation on API request bodies

## Test Patterns

**No test patterns exist.** However, the codebase uses these validation approaches:

**Zod Validation (backend routes):**
```typescript
// From src/server/routes/organizations.ts
const createOrganizationSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase'),
    timezone: z.string().optional(),
})

// Usage in route
const { name, slug, timezone } = createOrganizationSchema.parse(req.body)
```

**TypeScript Strict Mode:**
- `strict: true` in `tsconfig.json`
- `noUnusedLocals: true`
- `noUnusedParameters: true`

**Express Error Handling:**
```typescript
// All route handlers follow this pattern
router.get('/', async (req: Request, res: Response) => {
    try {
        // Route logic
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error fetching organizations:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})
```

## Mocking Strategy

**No mocking framework exists.** However, the codebase has these patterns for handling external dependencies:

**Supabase Client Mocking (would be needed for tests):**
```typescript
// From src/lib/supabase.ts - client initialization
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
```

**API Client Error Handling:**
```typescript
// From src/lib/api-client.ts
export class ApiClientError extends Error {
    status: number
    path: string
    details?: unknown
    code?: string
}
```

## CI Test Integration

**No CI test integration exists.**

The only CI command available is linting:
```bash
npm run lint    # eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0
```

## Test Gaps

**Critical gaps requiring attention:**

1. **Authentication middleware** (`src/server/index.ts`)
   - JWT validation logic is untested
   - No tests for token refresh, expiration handling

2. **API routes** (`src/server/routes/`)
   - All CRUD operations are untested
   - No validation of authorization checks
   - No tests for RLS policy enforcement

3. **Email tracking** (`src/server/lib/tracking.ts`)
   - Open/click token generation and validation is untested
   - No tests for webhook dispatch

4. **React Query hooks** (`src/hooks/`)
   - Data fetching logic untested
   - Cache invalidation behavior untested
   - Optimistic update rollback untested

5. **Form validation** (`react-hook-form` + Zod)
   - Zod schemas not tested in isolation
   - Form submission error handling untested

6. **Database operations** (`src/db/schema.ts`)
   - Drizzle ORM queries untested
   - No tests for cascade deletes
   - No tests for relation loading

**Recommended Testing Stack:**

| Type | Tool | Install |
|------|------|---------|
| Unit/Integration | Vitest | `npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom` |
| API Testing | Supertest | `npm install -D supertest @types/supertest` |
| E2E | Playwright | `npm install -D @playwright/test` |

**Suggested test structure:**
```
src/
├── __tests__/           # Unit tests
│   ├── lib/
│   └── server/
├── __tests__/api/       # API integration tests
└── e2e/                 # Playwright tests
```

---

*Testing analysis: 2026-03-31*
