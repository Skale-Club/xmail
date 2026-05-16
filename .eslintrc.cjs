/**
 * ESLint configuration for SkaleClub Mail.
 *
 * Phase 12 (v1.2 milestone, COR-07): closes audit H12.
 * See: .planning/debug/system-wide-audit-2026-05-16.md
 *
 * Rules calibrated to the existing codebase:
 * - no-unused-vars: error, with `_`-prefix exception (codebase convention)
 * - no-explicit-any: warn (--max-warnings 0 in package.json makes this effectively error;
 *   tightening to 'error' is deferred to Phase 13 QUA-01 after the tsc sweep)
 * - react-hooks/exhaustive-deps: warn (some legitimate exceptions in this codebase;
 *   per-line whitelists with justification)
 *
 * Any rule disabled/whitelisted inline MUST carry a comment with phase or issue reference.
 */
module.exports = {
    root: true,
    env: {
        browser: true,
        node: true,
        es2022: true,
    },
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
    },
    plugins: [
        '@typescript-eslint',
        'react-hooks',
        'react-refresh',
    ],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
    ],
    rules: {
        // Unused variables — allow underscore-prefix opt-out (idiomatic in this repo for unused fn args)
        'no-unused-vars': 'off',  // disabled in favor of the TS-aware version below
        '@typescript-eslint/no-unused-vars': ['error', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
        }],

        // `any` — tracked but not blocking yet (v1.2 stays warn; Phase 13 QUA-01 will tighten)
        '@typescript-eslint/no-explicit-any': 'warn',

        // React hooks (UI code)
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',

        // React Fast Refresh (Vite dev experience)
        'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

        // Misc — allow console (Express logs + admin scripts); QUA-06 will gate PII-emitting logs
        'no-console': 'off',

        // Allow ts-comment escape hatches with description (audit phase decisions need them)
        '@typescript-eslint/ban-ts-comment': ['error', {
            'ts-ignore': 'allow-with-description',
            'ts-expect-error': 'allow-with-description',
            minimumDescriptionLength: 10,
        }],

        // Drizzle and Zod patterns: empty interfaces / empty functions appear in generated code
        '@typescript-eslint/no-empty-interface': 'off',
        '@typescript-eslint/no-empty-function': 'off',
    },
    overrides: [
        {
            // Server code (no JSX): turn off the React-specific rules entirely
            files: ['src/server/**/*.ts', 'scripts/**/*.ts'],
            rules: {
                'react-hooks/rules-of-hooks': 'off',
                'react-hooks/exhaustive-deps': 'off',
                'react-refresh/only-export-components': 'off',
            },
        },
        {
            // shadcn/ui primitives are vendored from a generator; allow lax rules
            files: ['src/components/ui/**/*.{ts,tsx}'],
            rules: {
                '@typescript-eslint/no-explicit-any': 'off',
                '@typescript-eslint/no-unused-vars': 'off',
                'react-refresh/only-export-components': 'off',
            },
        },
    ],
}
