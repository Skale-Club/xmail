/**
 * Fase 1 (docs/outbound-authentication-audit.md) — this is the instrument the audit says does
 * not exist yet: "dado um envio, conseguir responder 'passou DKIM no destinatário?' sem
 * inferir." These tests are the contract for the parser half of that instrument. Every case
 * that feeds it attacker-shaped input (malformed, oversized) asserts the parser degrades to a
 * result, never an exception — see the module header on dmarc-parser.ts for why that matters:
 * this reads mail anyone on the internet can send to `dmarc@skale.club`.
 */
import { gzipSync, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
    MAX_COMPRESSED_ATTACHMENT_BYTES,
    MAX_DECOMPRESSED_XML_BYTES,
    parseDmarcAttachment,
    parseDmarcXml,
} from '../dmarc-parser'

/** Real-shaped Gmail-style aggregate report: two records, one aligned pass, one clean fail —
 *  matches the RFC 7489 section 7.2 example structure closely enough to exercise every field
 *  the query layer needs (raw auth_results AND aligned policy_evaluated, which differ). */
function realShapedReportXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>Google Inc.</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>10051183487581176460</report_id>
    <date_range>
      <begin>1757548800</begin>
      <end>1757635199</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>skale.club</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.5</source_ip>
      <count>12</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>skale.club</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>skale.club</domain>
        <result>pass</result>
        <selector>skaleclub</selector>
      </dkim>
      <spf>
        <domain>skale.club</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.9</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>skale.club</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>skale.club</domain>
        <result>fail</result>
      </dkim>
      <spf>
        <domain>unrelated-forwarder.example</domain>
        <result>fail</result>
      </spf>
    </auth_results>
  </record>
</feedback>`
}

describe('parseDmarcXml — relatório real', () => {
    it('extrai os campos de nível de relatório', () => {
        const report = parseDmarcXml(realShapedReportXml())
        expect(report).not.toBeNull()
        expect(report?.reportingOrg).toBe('Google Inc.')
        expect(report?.reportId).toBe('10051183487581176460')
        expect(report?.domain).toBe('skale.club')
        expect(report?.dateRangeBegin.toISOString()).toBe(new Date(1757548800 * 1000).toISOString())
        expect(report?.dateRangeEnd.toISOString()).toBe(new Date(1757635199 * 1000).toISOString())
    })

    it('extrai os dois records, distinguindo o resultado CRU do resultado ALINHADO', () => {
        const report = parseDmarcXml(realShapedReportXml())
        expect(report?.records).toHaveLength(2)

        const [aligned, notAligned] = report!.records
        expect(aligned).toMatchObject({
            sourceIp: '203.0.113.5',
            messageCount: 12,
            disposition: 'none',
            dkimResult: 'pass',
            dkimDomain: 'skale.club',
            spfResult: 'pass',
            spfDomain: 'skale.club',
            headerFrom: 'skale.club',
            policyDkimAligned: 'pass',
            policySpfAligned: 'pass',
        })

        // O segundo record prova que auth_results (cru) e policy_evaluated (alinhado) são lidos
        // de blocos distintos: SPF cru falhou contra um domínio diferente do header_from, e isso
        // não pode se confundir com o dkim/spf de policy_evaluated.
        expect(notAligned).toMatchObject({
            sourceIp: '198.51.100.9',
            messageCount: 3,
            dkimResult: 'fail',
            spfResult: 'fail',
            spfDomain: 'unrelated-forwarder.example',
            headerFrom: 'skale.club',
            policyDkimAligned: 'fail',
            policySpfAligned: 'fail',
        })
    })
})

describe('parseDmarcXml — malformado', () => {
    it('nunca lança — string vazia', () => {
        expect(() => parseDmarcXml('')).not.toThrow()
        expect(parseDmarcXml('')).toBeNull()
    })

    it('nunca lança — lixo binário decodificado como texto', () => {
        const garbage = Buffer.from([0x00, 0xff, 0x13, 0x37, 0x00, 0x01]).toString('utf8')
        expect(() => parseDmarcXml(garbage)).not.toThrow()
        expect(parseDmarcXml(garbage)).toBeNull()
    })

    it('nunca lança — XML bem formado mas sem os campos de relatório exigidos', () => {
        const xml = '<feedback><record><row><source_ip>1.2.3.4</source_ip></row></record></feedback>'
        expect(() => parseDmarcXml(xml)).not.toThrow()
        expect(parseDmarcXml(xml)).toBeNull()
    })

    it('nunca lança — tags nunca fechadas', () => {
        const xml = '<feedback><report_metadata><org_name>Broken'
        expect(() => parseDmarcXml(xml)).not.toThrow()
        expect(parseDmarcXml(xml)).toBeNull()
    })

    it('pula um record sem <count> utilizável em vez de derrubar o relatório inteiro', () => {
        const xml = `<?xml version="1.0"?><feedback>
            <report_metadata><org_name>Yahoo</org_name><report_id>abc123</report_id>
                <date_range><begin>1757548800</begin><end>1757635199</end></date_range></report_metadata>
            <policy_published><domain>skale.club</domain></policy_published>
            <record><row><source_ip>1.2.3.4</source_ip></row></record>
        </feedback>`
        const report = parseDmarcXml(xml)
        expect(report).not.toBeNull()
        expect(report?.records).toEqual([])
    })
})

describe('parseDmarcAttachment — descompressão', () => {
    it('aceita XML puro (sem compressão)', async () => {
        const bytes = Buffer.from(realShapedReportXml(), 'utf8')
        const result = await parseDmarcAttachment(bytes, { sizeBytes: bytes.length, filename: 'report.xml' })
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.report.reportingOrg).toBe('Google Inc.')
    })

    it('descomprime um anexo gzip real', async () => {
        const xml = realShapedReportXml()
        const gzipped = gzipSync(Buffer.from(xml, 'utf8'))
        const result = await parseDmarcAttachment(gzipped, { sizeBytes: gzipped.length, filename: 'google.com!skale.club!123.xml.gz' })
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.report.records).toHaveLength(2)
            expect(result.report.domain).toBe('skale.club')
        }
    })

    it('descomprime um anexo zip (entrada única, deflate)', async () => {
        const xml = realShapedReportXml()
        const compressed = deflateRawSync(Buffer.from(xml, 'utf8'))
        const filename = 'report.xml'
        const filenameBuf = Buffer.from(filename, 'utf8')
        const header = Buffer.alloc(30)
        header.writeUInt32LE(0x04034b50, 0) // local file header signature
        header.writeUInt16LE(20, 4) // version needed
        header.writeUInt16LE(0, 6) // general purpose flag — no data descriptor
        header.writeUInt16LE(8, 8) // method: deflate
        header.writeUInt16LE(0, 10) // mod time
        header.writeUInt16LE(0, 12) // mod date
        header.writeUInt32LE(0, 14) // crc32 (unchecked by the reader)
        header.writeUInt32LE(compressed.length, 18) // compressed size
        header.writeUInt32LE(xml.length, 22) // uncompressed size
        header.writeUInt16LE(filenameBuf.length, 26)
        header.writeUInt16LE(0, 28) // extra length
        const zipBytes = Buffer.concat([header, filenameBuf, compressed])

        const result = await parseDmarcAttachment(zipBytes, { sizeBytes: zipBytes.length, filename: 'report.zip' })
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.report.records).toHaveLength(2)
    })

    it('nunca lança e rejeita graciosamente um anexo malformado', async () => {
        const garbage = Buffer.from('this is not xml, gzip, or zip at all — just noise', 'utf8')
        let result
        await expect((async () => { result = await parseDmarcAttachment(garbage, { sizeBytes: garbage.length }) })()).resolves.not.toThrow()
        expect(result!.ok).toBe(false)
    })

    it('nunca lança em um gzip corrompido (cabeçalho válido, corpo quebrado)', async () => {
        const validGzip = gzipSync(Buffer.from(realShapedReportXml(), 'utf8'))
        const corrupted = Buffer.from(validGzip)
        // Flip bytes in the compressed body (after the 10-byte gzip header) so the header sniff
        // still says "gzip" but the deflate stream itself is invalid.
        for (let i = 10; i < Math.min(corrupted.length, 30); i++) corrupted[i] = corrupted[i] ^ 0xff
        const result = await parseDmarcAttachment(corrupted, { sizeBytes: corrupted.length })
        expect(result.ok).toBe(false)
    })

    it('rejeita um anexo cujo tamanho reportado excede o teto comprimido', async () => {
        const bytes = Buffer.from(realShapedReportXml(), 'utf8')
        const result = await parseDmarcAttachment(bytes, { sizeBytes: MAX_COMPRESSED_ATTACHMENT_BYTES + 1 })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toContain('exceeds')
    })

    it('rejeita um anexo cujos bytes reais excedem o teto comprimido, mesmo com sizeBytes mentindo', async () => {
        const big = Buffer.alloc(MAX_COMPRESSED_ATTACHMENT_BYTES + 1024, 0x41)
        const result = await parseDmarcAttachment(big, { sizeBytes: 10 }) // untrusted metadata lying about size
        expect(result.ok).toBe(false)
    })

    it('aborta uma bomba gzip antes de materializar o resultado descomprimido inteiro', async () => {
        // A highly repetitive payload compresses extremely well; decompressed it would exceed
        // MAX_DECOMPRESSED_XML_BYTES by a wide margin. The point of this test is that the cap
        // is enforced by aborting the STREAM, not by measuring the result afterward.
        const bomb = gzipSync(Buffer.alloc(MAX_DECOMPRESSED_XML_BYTES * 4, 0x00))
        expect(bomb.length).toBeLessThan(MAX_COMPRESSED_ATTACHMENT_BYTES) // legal to receive at all
        const result = await parseDmarcAttachment(bomb, { sizeBytes: bomb.length })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toContain('cap')
    })
})
