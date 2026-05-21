/**
 * Mail client autodiscovery endpoints.
 *
 * Thunderbird:
 *   GET /.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=...
 *   GET /mail/config-v1.1.xml?emailaddress=...
 *
 * Outlook:
 *   POST /autodiscover/autodiscover.xml
 *   POST /Autodiscover/Autodiscover.xml
 *
 * Apple / iOS:
 *   GET /api/system/mail-config/apple.mobileconfig?email=...
 *
 * All endpoints are public (no auth) — they only echo server connection info,
 * never user data.
 */

import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'crypto'

const router = Router()

function mailConfig() {
    const mailHost = process.env.MAIL_HOST || 'localhost'
    const mailDomain = process.env.MAIL_DOMAIN || mailHost
    const smtpPort = parseInt(process.env.SMTP_SUBMISSION_PORT || '2587')
    const imapPort = parseInt(process.env.IMAP_PORT || '2993')
    const hasTLS = !!(process.env.MAIL_TLS_CERT_PATH && process.env.MAIL_TLS_KEY_PATH)
    return { mailHost, mailDomain, smtpPort, imapPort, hasTLS }
}

function xmlEscape(s: string): string {
    return s.replace(/[<>&'"]/g, (c) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
    }[c] as string))
}

// ─── Thunderbird autoconfig ──────────────────────────────────────────────────

function buildThunderbirdConfig(email: string): string {
    const { mailHost, mailDomain, smtpPort, imapPort, hasTLS } = mailConfig()
    const emailSafe = xmlEscape(email)
    const imapSecurity = hasTLS ? 'SSL' : 'plain'
    const smtpSecurity = hasTLS ? 'STARTTLS' : 'plain'

    return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
    <emailProvider id="${xmlEscape(mailDomain)}">
        <domain>${xmlEscape(mailDomain)}</domain>
        <displayName>${xmlEscape(process.env.APP_APPLICATION_NAME || 'Skale Club Mail')}</displayName>
        <displayShortName>${xmlEscape(mailDomain)}</displayShortName>
        <incomingServer type="imap">
            <hostname>${xmlEscape(mailHost)}</hostname>
            <port>${imapPort}</port>
            <socketType>${imapSecurity}</socketType>
            <username>${emailSafe}</username>
            <authentication>password-cleartext</authentication>
        </incomingServer>
        <outgoingServer type="smtp">
            <hostname>${xmlEscape(mailHost)}</hostname>
            <port>${smtpPort}</port>
            <socketType>${smtpSecurity}</socketType>
            <username>${emailSafe}</username>
            <authentication>password-cleartext</authentication>
        </outgoingServer>
    </emailProvider>
</clientConfig>`
}

router.get(['/.well-known/autoconfig/mail/config-v1.1.xml', '/mail/config-v1.1.xml'], (req: Request, res: Response) => {
    const email = String(req.query.emailaddress || req.query.emailAddress || '')
    res.type('application/xml').send(buildThunderbirdConfig(email))
})

// ─── Outlook Autodiscover ─────────────────────────────────────────────────────

function buildOutlookAutodiscover(email: string): string {
    const { mailHost, smtpPort, imapPort, hasTLS } = mailConfig()
    const emailSafe = xmlEscape(email)
    const smtpSSL = hasTLS ? 'on' : 'off'
    const smtpEnc = hasTLS ? 'TLS' : 'None'

    return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
    <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
        <User>
            <DisplayName>${emailSafe}</DisplayName>
            <EMailAddress>${emailSafe}</EMailAddress>
        </User>
        <Account>
            <AccountType>email</AccountType>
            <Action>settings</Action>
            <Protocol>
                <Type>IMAP</Type>
                <Server>${xmlEscape(mailHost)}</Server>
                <Port>${imapPort}</Port>
                <LoginName>${emailSafe}</LoginName>
                <SSL>${hasTLS ? 'on' : 'off'}</SSL>
                <AuthRequired>on</AuthRequired>
            </Protocol>
            <Protocol>
                <Type>SMTP</Type>
                <Server>${xmlEscape(mailHost)}</Server>
                <Port>${smtpPort}</Port>
                <LoginName>${emailSafe}</LoginName>
                <SSL>${smtpSSL}</SSL>
                <Encryption>${smtpEnc}</Encryption>
                <AuthRequired>on</AuthRequired>
                <UsePOPAuth>off</UsePOPAuth>
            </Protocol>
        </Account>
    </Response>
</Autodiscover>`
}

router.post(['/autodiscover/autodiscover.xml', '/Autodiscover/Autodiscover.xml'], (req: Request, res: Response) => {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || '')
    const emailMatch = body.match(/<EMailAddress>([^<]+)<\/EMailAddress>/i)
    const email = emailMatch?.[1] || ''
    res.type('application/xml').send(buildOutlookAutodiscover(email))
})

// ─── Apple mobileconfig ──────────────────────────────────────────────────────

router.get('/api/system/mail-config/apple.mobileconfig', (req: Request, res: Response) => {
    const email = String(req.query.email || '')
    const { mailHost, smtpPort, imapPort, hasTLS } = mailConfig()
    const appName = process.env.APP_APPLICATION_NAME || 'Skale Club Mail'
    const profileUUID = randomUUID().toUpperCase()
    const payloadUUID = randomUUID().toUpperCase()

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>EmailAccountDescription</key>
            <string>${xmlEscape(appName)}</string>
            <key>EmailAccountName</key>
            <string>${xmlEscape(email)}</string>
            <key>EmailAccountType</key>
            <string>EmailTypeIMAP</string>
            <key>EmailAddress</key>
            <string>${xmlEscape(email)}</string>
            <key>IncomingMailServerAuthentication</key>
            <string>EmailAuthPassword</string>
            <key>IncomingMailServerHostName</key>
            <string>${xmlEscape(mailHost)}</string>
            <key>IncomingMailServerPortNumber</key>
            <integer>${imapPort}</integer>
            <key>IncomingMailServerUseSSL</key>
            <${hasTLS ? 'true' : 'false'}/>
            <key>IncomingMailServerUsername</key>
            <string>${xmlEscape(email)}</string>
            <key>OutgoingMailServerAuthentication</key>
            <string>EmailAuthPassword</string>
            <key>OutgoingMailServerHostName</key>
            <string>${xmlEscape(mailHost)}</string>
            <key>OutgoingMailServerPortNumber</key>
            <integer>${smtpPort}</integer>
            <key>OutgoingMailServerUseSSL</key>
            <${hasTLS ? 'true' : 'false'}/>
            <key>OutgoingMailServerUsername</key>
            <string>${xmlEscape(email)}</string>
            <key>OutgoingPasswordSameAsIncomingPassword</key>
            <true/>
            <key>PayloadDescription</key>
            <string>Configures ${xmlEscape(appName)} mail account</string>
            <key>PayloadDisplayName</key>
            <string>${xmlEscape(appName)}</string>
            <key>PayloadIdentifier</key>
            <string>com.skaleclub.mail.account.${payloadUUID}</string>
            <key>PayloadType</key>
            <string>com.apple.mail.managed</string>
            <key>PayloadUUID</key>
            <string>${payloadUUID}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>${xmlEscape(appName)} (${xmlEscape(email)})</string>
    <key>PayloadIdentifier</key>
    <string>com.skaleclub.mail.${profileUUID}</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${profileUUID}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`

    res.setHeader('Content-Type', 'application/x-apple-aspen-config')
    res.setHeader('Content-Disposition', `attachment; filename="${email || 'mail'}.mobileconfig"`)
    res.send(plist)
})

export default router
