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
                    restoreMocks: true,
                },
            },
        ],
    },
})
