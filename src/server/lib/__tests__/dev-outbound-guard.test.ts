import http from 'node:http'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    OUTBOUND_BLOCKED_CODE,
    connectTarget,
    devAllowedHosts,
    installDevOutboundGuard,
    isHostAllowed,
    uninstallDevOutboundGuard,
} from '../dev-outbound-guard'
import { applyDevelopmentMailIsolation } from '../dev-guard-entry'

const ref = 'abcdefghijklmnopqrst'
const env = {
    XMAIL_DEV_DATABASE_URL: `postgresql://postgres.${ref}:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    XMAIL_DEV_SUPABASE_PROJECT_REF: ref,
    // A wildcard must never turn into "allow everything".
    XMAIL_DEV_OUTBOUND_ALLOW_HOSTS: ' Extra.Example.test , * , *.evil.test ',
} as NodeJS.ProcessEnv

const logged: string[] = []

describe('development outbound guard (fail closed)', () => {
    beforeAll(() => { installDevOutboundGuard(env, message => logged.push(message)) })
    afterAll(() => uninstallDevOutboundGuard())

    it('allows loopback, the dev database and the dev Supabase project only', () => {
        const allowed = devAllowedHosts(env)
        for (const host of ['localhost', '127.0.0.1', 'app.localhost', '::1', '[::1]']) expect(isHostAllowed(host, allowed), host).toBe(true)
        expect(isHostAllowed('aws-0-us-east-1.pooler.supabase.com', allowed)).toBe(true)
        expect(isHostAllowed(`${ref}.supabase.co`, allowed)).toBe(true)
        expect(isHostAllowed('extra.example.test', allowed)).toBe(true)
        for (const host of [
            'smtp.gmail.com', 'gmail-smtp-in.l.google.com', 'imap.gmail.com', 'outlook.office365.com',
            'graph.microsoft.com', 'api.telegram.org', 'api.openai.com', 'api.millionverifier.com',
            'zzbudkfkcmqkavgwselc.supabase.co', 'other.supabase.co', 'evil.test', '10.0.0.5',
        ]) expect(isHostAllowed(host, allowed), host).toBe(false)
    })

    it('derives the dialed host from every Socket#connect signature', () => {
        expect(connectTarget([{ host: 'smtp.example.com', port: 587 }])).toBe('smtp.example.com')
        expect(connectTarget([[{ host: 'smtp.example.com', port: 587 }, () => undefined]])).toBe('smtp.example.com')
        expect(connectTarget([{ port: 25 }])).toBe('localhost')
        expect(connectTarget([993, 'imap.example.com'])).toBe('imap.example.com')
        expect(connectTarget(['25', 'mx.example.com'])).toBe('mx.example.com')
        expect(connectTarget([{ path: '/tmp/x.sock' }])).toBeNull()
        expect(connectTarget(['/tmp/x.sock'])).toBeNull()
    })

    it('destroys direct MX (port 25), SMTP submission and IMAP connections before they are dialed', async () => {
        for (const [host, port] of [['gmail-smtp-in.l.google.com', 25], ['smtp.example.com', 587], ['imap.example.com', 993]] as const) {
            const error = await new Promise<NodeJS.ErrnoException>(resolve => {
                net.connect({ host, port }).once('error', resolve)
            })
            expect(error.code, host).toBe(OUTBOUND_BLOCKED_CODE)
            expect(error.message).toContain(host)
        }
    })

    it('blocks fetch and node:http clients (webhooks, Telegram, AI, Xphere)', async () => {
        await expect(fetch('https://api.telegram.org/bot1/sendMessage', { method: 'POST', body: '{}' }))
            .rejects.toSatisfy((e: Error & { cause?: { code?: string } }) => e.cause?.code === OUTBOUND_BLOCKED_CODE)
        const error = await new Promise<NodeJS.ErrnoException>(resolve => {
            http.get('http://hooks.example.com/', () => undefined).once('error', resolve)
        })
        expect(error.code).toBe(OUTBOUND_BLOCKED_CODE)
    })

    it('blocks a real nodemailer transport (the outbound path of Send)', async () => {
        const nodemailer = await import('nodemailer')
        const transport = nodemailer.createTransport({ host: 'smtp.example.com', port: 587, connectionTimeout: 3000 })
        await expect(transport.sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 'x', text: 'x' }))
            .rejects.toBeTruthy()
        expect(logged.some(m => m.includes('smtp.example.com'))).toBe(true)
    })

    it('still serves loopback traffic (Vite, the dev server, the SSH tunnel)', async () => {
        const server = http.createServer((_, res) => res.end('ok'))
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        try {
            const { port } = server.address() as net.AddressInfo
            expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok')
        } finally {
            server.close()
        }
    })

    it('logs each blocked host once and is idempotent', () => {
        expect(installDevOutboundGuard(env)).toBe(installDevOutboundGuard(env))
        expect(logged.filter(m => m.includes('gmail-smtp-in.l.google.com'))).toHaveLength(1)
    })
})

describe('development entry isolation', () => {
    afterAll(() => uninstallDevOutboundGuard())

    it('turns the mail servers and the SMTP relay off and installs the guard in development', () => {
        const target = {
            NODE_ENV: 'development', ENABLE_MAIL_SERVER: 'true',
            SMTP_HOST: 'smtp.relay.example', SMTP_USER: 'relay-user', SMTP_PASS: 'relay-pass', XMAIL_DEV_SUPABASE_PROJECT_REF: ref,
        } as NodeJS.ProcessEnv
        expect(applyDevelopmentMailIsolation(target)).toBe(true)
        expect(target.ENABLE_MAIL_SERVER).toBe('false')
        expect([target.SMTP_HOST, target.SMTP_USER, target.SMTP_PASS]).toEqual(['', '', ''])
        expect(net.Socket.prototype.connect.name).toBe('guardedConnect')
    })

    it('leaves production and test environments untouched', () => {
        uninstallDevOutboundGuard()
        for (const NODE_ENV of ['production', 'test']) {
            const target = { NODE_ENV, ENABLE_MAIL_SERVER: 'true', SMTP_HOST: 'smtp.relay.example' } as NodeJS.ProcessEnv
            expect(applyDevelopmentMailIsolation(target)).toBe(false)
            expect(target.ENABLE_MAIL_SERVER).toBe('true')
            expect(target.SMTP_HOST).toBe('smtp.relay.example')
        }
        expect(net.Socket.prototype.connect.name).not.toBe('guardedConnect')
    })
})
