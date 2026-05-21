import { defineConfig, loadEnv, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

function appConfigPlugin(config: {
    supabaseUrl: string
    supabaseAnonKey: string
    appName: string
    faviconUrl: string
    appleTouchIconUrl: string
}): Plugin {
    return {
        name: 'app-config-dev-endpoint',
        configureServer(server) {
            server.middlewares.use('/app-config.js', (_req, res) => {
                res.setHeader('Content-Type', 'application/javascript')
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
                res.end(`window.__APP_CONFIG__ = ${JSON.stringify({
                    VITE_SUPABASE_URL: config.supabaseUrl,
                    VITE_SUPABASE_ANON_KEY: config.supabaseAnonKey,
                    VITE_APP_NAME: config.appName,
                })};`)
            })
        },
        transformIndexHtml(html) {
            return html
                .replace(
                    '<link rel="icon" href="/brand-mark.svg" type="image/svg+xml" />',
                    `<link rel="icon" href="${config.faviconUrl}" type="image/svg+xml" />`
                )
                .replace(
                    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
                    `<link rel="apple-touch-icon" href="${config.appleTouchIconUrl}" />`
                )
        },
    }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '')
    const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || ''
    const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || ''
    const appName = env.VITE_APP_NAME || 'Skale Club Mail'

    const storageBase = `${supabaseUrl}/storage/v1/object/public/branding-assets`
    const faviconUrl     = `${storageBase}/favicon.svg`
    const appleTouchIcon = `${storageBase}/apple-touch-icon.png`
    const pwaIcon192     = `${storageBase}/pwa-icon-192.png`
    const pwaIcon512     = `${storageBase}/pwa-icon-512.png`
    const pwaIconMask    = `${storageBase}/pwa-icon-maskable.png`

    return {
        plugins: [
            react(),
            appConfigPlugin({ supabaseUrl, supabaseAnonKey, appName, faviconUrl, appleTouchIconUrl: appleTouchIcon }),
            VitePWA({
                registerType: 'autoUpdate',
                includeAssets: [],
                manifest: {
                    name: appName,
                    short_name: 'Mail',
                    description: 'Multi-tenant email server management platform',
                    theme_color: '#6366f1',
                    background_color: '#09090b',
                    display: 'standalone',
                    orientation: 'portrait-primary',
                    scope: '/',
                    start_url: '/',
                    icons: [
                        {
                            src: pwaIcon192,
                            sizes: '192x192',
                            type: 'image/png',
                            purpose: 'any',
                        },
                        {
                            src: pwaIcon512,
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'any',
                        },
                        {
                            src: pwaIconMask,
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'maskable',
                        },
                    ],
                },
                workbox: {
                    globPatterns: ['**/*.{js,css,html,svg,woff2}'],
                    // Drop precaches from prior builds so old chunk hashes
                    // can't be served after a deploy. Combined with
                    // skipWaiting + clientsClaim this means a new SW
                    // takes over immediately rather than waiting for
                    // every tab to close.
                    cleanupOutdatedCaches: true,
                    skipWaiting: true,
                    clientsClaim: true,
                    // Never cache the API response shells themselves with
                    // the precache; only the runtimeCaching entry below
                    // applies.
                    navigateFallbackDenylist: [/^\/api\//],
                    runtimeCaching: [
                        {
                            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/'),
                            handler: 'NetworkFirst',
                            options: {
                                cacheName: 'api-cache',
                                networkTimeoutSeconds: 10,
                                cacheableResponse: { statuses: [0, 200] },
                            },
                        },
                    ],
                },
            }),
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        define: {
            'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
            'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey),
            'import.meta.env.VITE_APP_NAME': JSON.stringify(appName),
            'import.meta.env.VITE_BUILD_TIMESTAMP': JSON.stringify(new Date().toISOString()),
        },
        server: {
            port: 9000,
            host: '127.0.0.1',
            proxy: {
                '/api': {
                    target: 'http://localhost:9001',
                    changeOrigin: true,
                },
            },
        },
        build: {
            outDir: 'dist/client',
            emptyOutDir: true,
            rollupOptions: {
                output: {
                    manualChunks: {
                        'vendor-react': ['react', 'react-dom'],
                        'vendor-router': ['wouter'],
                        'vendor-query': ['@tanstack/react-query'],
                        'vendor-ui': ['lucide-react', 'clsx', 'tailwind-merge'],
                        'vendor-quill': ['react-quill-new'],
                        'vendor-date': ['date-fns'],
                    },
                },
            },
            chunkSizeWarningLimit: 500,
        },
    }
})
