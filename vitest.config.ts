import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    test: {
        // Serialize file execution across ALL projects. The postgres project's .db suites
        // share one disposable database and several drive org-wide jobs; if two files' hooks
        // run concurrently their transactions interleave on shared tables and deadlock or
        // exhaust connections. `fileParallelism` is only honored at this root level in
        // Vitest 3 (not per-project), and unlike a single shared fork it keeps each file in
        // its own worker, so a suite that mutates process.env (the harness self-test) can't
        // bleed into its siblings. The server/client suites are in-memory and fast, so
        // serializing them costs little.
        fileParallelism: false,
        projects: [
            {
                extends: true,
                test: {
                    name: 'server',
                    environment: 'node',
                    include: ['src/**/*.{test,spec}.ts'],
                    exclude: ['src/**/*.db.{test,spec}.ts'],
                    restoreMocks: true,
                },
            },
            {
                extends: true,
                plugins: [react()],
                test: {
                    name: 'client',
                    environment: 'jsdom',
                    include: ['src/**/*.{test,spec}.tsx'],
                    setupFiles: ['./src/test/setup-jsdom.ts'],
                    restoreMocks: true,
                },
            },
            {
                extends: true,
                test: {
                    name: 'postgres',
                    environment: 'node',
                    include: ['src/**/*.db.{test,spec}.ts'],
                    globalSetup: ['./src/test/postgres-global-setup.ts'],
                    restoreMocks: true,
                    // DB suites do real work in hooks: a beforeAll re-applies a migration
                    // under a shared advisory lock, and setup/teardown open pooled
                    // connections against one disposable container. 10s (the default) kills
                    // a legitimately-slow-but-correct hook under full-project load; give the
                    // migration/connection hooks realistic headroom.
                    hookTimeout: 30_000,
                    testTimeout: 20_000,
                    // Every .db suite shares one disposable database, and several drive jobs
                    // that are global by design: processFollowUps selects every due
                    // campaign_lead, and the inbound claim selects across organizations
                    // (deliberately — the queues are org-wide, scoping happens per handler).
                    // File serialization that prevents these shared-database suites from
                    // deadlocking is enforced by the root-level `fileParallelism: false`
                    // above (per-project fileParallelism is not honored in Vitest 3).
                },
            },
        ],
    },
})
