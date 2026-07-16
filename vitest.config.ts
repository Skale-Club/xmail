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
                    // Every .db suite shares one disposable database, and several drive
                    // jobs that are global by design: processFollowUps selects every due
                    // campaign_lead, and the inbound claim selects across organizations
                    // (deliberately — the queues are org-wide, scoping happens per handler).
                    // Run one file at a time. In parallel they interleave migration DDL and
                    // consume rows another suite queued, producing failures that say
                    // nothing about the code under test.
                    fileParallelism: false,
                },
            },
        ],
    },
})
