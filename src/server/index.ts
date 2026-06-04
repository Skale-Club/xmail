import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { join } from 'path'
import { existsSync } from 'fs'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { eq } from 'drizzle-orm'
import { closeDatabaseConnection, db } from '../db'
import { users } from '../db/schema'
import authRoutes from './routes/auth'
import userRoutes from './routes/users'
import organizationRoutes from './routes/organizations'
import domainRoutes from './routes/domains'
import messageRoutes from './routes/messages'
import webhookRoutes from './routes/webhooks'
import credentialRoutes from './routes/credentials'
import routeRoutes from './routes/routes'
import systemRoutes from './routes/system'
import trackRoutes from './routes/track'
import templateRoutes from './routes/templates'
import outreachRoutes from './routes/outreach'
import outreachHealthRoutes from './routes/admin/outreach-health'
import integrationsRoutes from './routes/integrations'
import healthEmailRoutes from './routes/health-email'
import unsubscribeRoutes from './routes/outreach/unsubscribe'
import outlookRoutes from './routes/outlook'
import mailRoutes from './routes/mail'
import notificationRoutes from './routes/notifications'
import autodiscoverRoutes from './routes/autodiscover'
import { createSMTPServer } from './smtp-server'
import { createIMAPServer, loadImapBranding } from './imap-server'
import { createMXServer } from './mx-server'
import { runReadinessChecks } from './lib/health'
import { resolveUserFromToken } from './lib/auth-cache'
import { getMailTLSOptions } from './lib/mail-tls'

const app = express()
const PORT = process.env.PORT || 9001
const supabaseOrigin = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : null

app.set('trust proxy', 1)

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'img-src': ["'self'", 'data:', 'https:', 'http:', supabaseOrigin].filter(Boolean) as string[],
            'connect-src': ["'self'", supabaseOrigin].filter(Boolean) as string[],
            // QUA-05 — see audit M10. Close clickjacking (frame-ancestors), plugin-content
            // (object-src), and base-URI hijack (base-uri) vectors. helmet defaults DO NOT
            // include these via getDefaultDirectives().
            'frame-ancestors': ["'none'"],
            'object-src': ["'none'"],
            'base-uri': ["'self'"],
        },
    },
}))
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:9000',
    credentials: true,
}))

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 500 : 2000,
    message: { error: 'Too many requests, please try again later.' },
})
app.use('/api/', limiter)

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10, // QUA-07 — see audit M8. Bumped from 5 → 10 to reduce false lockouts of honest users.
    message: { error: 'Too many authentication attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
})
app.use('/api/auth/login', authLimiter)
app.use('/api/auth/reset-password', authLimiter)

const trackingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
})
app.use('/t/', trackingLimiter)

// Per-user limiter for /api/mail/mailboxes/test-connection (SMTP/IMAP probe abuse defense).
// Applied AFTER the auth middleware below so keyGenerator can read req.headers['x-user-id'].
const testConnectionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const uid = req.headers['x-user-id']
        return typeof uid === 'string' && uid ? `user:${uid}` : `ip:${req.ip}`
    },
    message: { error: 'Too many connection tests; please wait a minute.' },
})

// Public unsubscribe endpoint — pre-empts P1-20. Tighter limit than /t/ because
// /o/u/ is human-interactive (one click per recipient), not pixel-hit volume.
const unsubscribeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many unsubscribe requests, please try again later.' },
})
app.use('/o/u/', unsubscribeLimiter)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
// Outlook autodiscover sends XML bodies; accept them as raw text
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '100kb' }))

// Prevent browsers from caching API responses
app.use('/api/', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    next()
})

app.get('/health', (_req, res) => {
    const uptimeSeconds = Math.floor(process.uptime())
    const memoryUsage = process.memoryUsage()

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: process.env.DEPLOY_VERSION || 'unknown',
        deployedAt: process.env.DEPLOYED_AT || null,
        uptime: {
            seconds: uptimeSeconds,
            human: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`
        },
        memory: {
            heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            rssMB: Math.round(memoryUsage.rss / 1024 / 1024)
        },
        node: process.version,
        env: process.env.NODE_ENV || 'development'
    })
})

app.get('/health/db', async (_req, res) => {
    const readiness = await runReadinessChecks()
    const statusCode = readiness.services.database.ok ? 200 : 503

    res.status(statusCode).json({
        status: readiness.services.database.ok ? 'ok' : 'error',
        checkedAt: readiness.checkedAt,
        database: readiness.services.database,
    })
})

app.get('/health/auth', async (_req, res) => {
    const readiness = await runReadinessChecks()
    const statusCode = readiness.services.auth.ok ? 200 : 503

    res.status(statusCode).json({
        status: readiness.services.auth.ok ? 'ok' : 'error',
        checkedAt: readiness.checkedAt,
        auth: readiness.services.auth,
    })
})

app.get('/health/ready', async (_req, res) => {
    const readiness = await runReadinessChecks()
    res.status(readiness.ok ? 200 : 503).json(readiness)
})

// Public mail-server health endpoint — useful for post-deploy diagnostics.
// Shows which TLS cert was loaded, which env vars are set, and which ports
// the mail servers are listening on. No secrets are exposed.
app.get('/health/mail', (_req, res) => {
    const tls = getMailTLSOptions()
    const envChecks = {
        SUPABASE_URL:                    !!process.env.SUPABASE_URL,
        SUPABASE_ANON_KEY:               !!process.env.SUPABASE_ANON_KEY,
        DATABASE_URL:                    !!process.env.DATABASE_URL,
        JWT_SECRET:                      !!process.env.JWT_SECRET,
        ENCRYPTION_KEY:                  !!process.env.ENCRYPTION_KEY,
        OUTLOOK_TOKEN_ENCRYPTION_KEY:    !!process.env.OUTLOOK_TOKEN_ENCRYPTION_KEY,
        MAIL_HOST:                       process.env.MAIL_HOST || '(not set)',
        MAIL_DOMAIN:                     process.env.MAIL_DOMAIN || '(not set)',
        MAIL_TLS_CERT_PATH:              process.env.MAIL_TLS_CERT_PATH || '(not set)',
        MAIL_TLS_KEY_PATH:               process.env.MAIL_TLS_KEY_PATH || '(not set)',
        ENABLE_MAIL_SERVER:              process.env.ENABLE_MAIL_SERVER || '(not set, defaults on)',
        MX_PORT:                         process.env.MX_PORT || '(not set, defaults to 25 in prod / 2525 in dev)',
        SMTP_HOST:                       process.env.SMTP_HOST ? '✓ set' : '(not set)',
    }

    const encryptionKeyPresent = !!(process.env.OUTLOOK_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET)

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        tls: {
            loaded: tls !== null,
            note: tls ? 'TLS certificate active — IMAP/SMTP running with TLS' : 'No TLS cert found — mail servers running in plaintext mode',
        },
        encryptionKey: {
            ok: encryptionKeyPresent,
            note: encryptionKeyPresent
                ? 'Encryption key present (OUTLOOK_TOKEN_ENCRYPTION_KEY or JWT_SECRET)'
                : '⚠️  MISSING — mailbox provisioning will fail with 500 (set OUTLOOK_TOKEN_ENCRYPTION_KEY in Coolify)',
        },
        ports: {
            smtp: parseInt(process.env.SMTP_SUBMISSION_PORT || '587'),
            imap: parseInt(process.env.IMAP_PORT || '993'),
            mx:   parseInt(process.env.MX_PORT || '25'),
        },
        env: envChecks,
    })
})

app.get('/app-config.js', (_req, res) => {
    res.type('application/javascript')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')

    const publicConfig = {
        VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
        VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
        VITE_APP_NAME: process.env.VITE_APP_NAME || process.env.APP_APPLICATION_NAME || 'Xmail',
    }

    res.send(`window.__APP_CONFIG__ = ${JSON.stringify(publicConfig)};`)
})

const PUBLIC_PATHS = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/reset-password',
    '/api/auth/refresh',
    '/api/system/branding',
    '/api/system/mail-server-info',
]

const PUBLIC_PATH_PREFIXES = [
    '/api/system/mail-config/',
]

app.use('/api', async (req, res, next) => {
    const path = req.originalUrl.split('?')[0]

    if (PUBLIC_PATHS.some(p => path === p)) {
        return next()
    }
    if (PUBLIC_PATH_PREFIXES.some(p => path.startsWith(p))) {
        return next()
    }

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    const token = authHeader.replace('Bearer ', '')
    // SEC-03 — see src/server/lib/auth-cache.ts
    const { user, error } = await resolveUserFromToken(token)

    if (error || !user) {
        return res.status(401).json({ error: error ?? 'Invalid or expired token' })
    }

    req.headers['x-user-id'] = user.id
    req.headers['x-user-email'] = user.email ?? ''
    req.headers['x-user-first-name'] = user.firstName
    req.headers['x-user-last-name'] = user.lastName
    req.headers['x-user-email-verified'] = String(user.emailVerified)

    next()
})

type MailServer = { start: () => void; close: () => Promise<void> }
let runningSmtpServer: MailServer | null = null
let runningImapServer: MailServer | null = null
let runningMxServer: MailServer | null = null

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        console.log(`[shutdown] Received ${signal}, closing mail servers and DB...`)
        const closers: Promise<void>[] = []
        if (runningSmtpServer) closers.push(runningSmtpServer.close().catch(() => undefined))
        if (runningImapServer) closers.push(runningImapServer.close().catch(() => undefined))
        if (runningMxServer) closers.push(runningMxServer.close().catch(() => undefined))
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
        void Promise.race([Promise.all(closers), timeout])
            .then(() => closeDatabaseConnection())
            .finally(() => process.exit(0))
    })
}

app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/organizations', organizationRoutes)
app.use('/api/domains', domainRoutes)
app.use('/api/messages', messageRoutes)
app.use('/api/webhooks', webhookRoutes)
app.use('/api/credentials', credentialRoutes)
app.use('/api/routes', routeRoutes)
app.use('/api/system', systemRoutes)
app.use('/api/templates', templateRoutes)
app.use('/api/outreach', outreachRoutes)
// Phase 17 — platform-admin observability endpoints (GET /api/admin/outreach/health).
// JWT auth is applied by the /api middleware above; the route handler additionally
// gates on isPlatformAdmin so non-admin users get 403 instead of 200.
app.use('/api/admin/outreach', outreachHealthRoutes)
app.use('/api/admin/integrations', integrationsRoutes)
// Platform-admin email-subsystem health (GET /api/health/email).
// JWT auth applied by the /api middleware; handler gates on isPlatformAdmin.
app.use('/api/health/email', healthEmailRoutes)
app.use('/api/outlook', outlookRoutes)
app.use('/api/mail/mailboxes/test-connection', testConnectionLimiter)
app.use('/api/mail', mailRoutes)
app.use('/api/notifications', notificationRoutes)

// Mail client autodiscovery — Thunderbird/Outlook use paths outside /api,
// so mounted on root. Apple .mobileconfig is under /api/system/mail-config/.
app.use('/', autodiscoverRoutes)

// Public unsubscribe endpoint — mounted OUTSIDE /api so the JWT middleware does
// not 401 recipients clicking the link from their inbox. The HMAC token IS the auth.
app.use('/o/u', unsubscribeRoutes)

app.use('/t', trackRoutes)

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Error:', err.message)
    console.error('Stack:', err.stack)

    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    })
})

// Serve static frontend files in production (dist/client built by Vite)
const clientDist = join(process.cwd(), 'dist', 'client')

if (existsSync(clientDist)) {
    // sw.js and registerSW.js must never be cached by HTTP intermediaries.
    // The browser's SW update algorithm compares the byte content of the
    // new sw.js against the installed copy; if an HTTP cache returns the
    // old sw.js the browser thinks nothing changed and won't install the
    // new build's service worker, causing stale-chunk blank screens.
    app.get('/sw.js', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
        res.setHeader('Content-Type', 'application/javascript')
        res.sendFile(join(clientDist, 'sw.js'))
    })
    app.get('/registerSW.js', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
        res.setHeader('Content-Type', 'application/javascript')
        res.sendFile(join(clientDist, 'registerSW.js'))
    })

    app.use(express.static(clientDist))
    // SPA fallback — serve index.html for all non-API routes
    app.use((_req: express.Request, res: express.Response) => {
        res.sendFile(join(clientDist, 'index.html'))
    })
} else {
    app.use((_req: express.Request, res: express.Response) => {
        res.status(404).json({ error: 'Not found' })
    })
}

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`)

    // Warn if no platform admin exists
    try {
        const adminUser = await db.query.users.findFirst({ where: eq(users.isAdmin, true) })
        if (!adminUser) {
            console.warn('⚠️  No platform admin found. Run: npx tsx scripts/set-admin.ts <email>')
        }
    } catch { /* ignore */ }

    import('./jobs/index').then((jobs) => jobs.startJobs())

    // Start native SMTP + IMAP + MX servers (always on in production; set
    // ENABLE_MAIL_SERVER=false to disable for dev/CI runs).
    if (process.env.ENABLE_MAIL_SERVER !== 'false') {
        try {
            runningSmtpServer = createSMTPServer()
            runningImapServer = createIMAPServer()
            runningMxServer = createMXServer()
            runningSmtpServer.start()
            runningMxServer.start()
            loadImapBranding()
                .then(() => runningImapServer!.start())
                .catch((err) => {
                    console.warn('⚠️  IMAP branding load failed, starting IMAP server anyway:', (err as Error).message)
                    runningImapServer!.start()
                })
        } catch (err) {
            console.warn('⚠️  SMTP/IMAP/MX servers failed to start:', (err as Error).message)
        }
    } else {
        console.log('ℹ️  SMTP/IMAP/MX servers disabled (ENABLE_MAIL_SERVER=false)')
    }
})

export default app
