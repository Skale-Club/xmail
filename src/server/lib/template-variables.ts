/**
 * Template Variable Interpolation for Outreach Emails
 *
 * Supports personalization tokens like {{firstName}}, {{companyName}}, etc.
 * Also supports custom fields from the lead's customFields JSONB column.
 */

import { escapeHtml } from './html-escape'
import { extractLeadZip, isZipNearHome } from './zip-distance'

// Type for lead data available in templates
type LeadForTemplate = {
    email: string
    firstName: string | null
    lastName: string | null
    companyName: string | null
    companySize: string | null
    industry: string | null
    title: string | null
    website: string | null
    linkedinUrl: string | null
    phone: string | null
    location: string | null
    customFields: Record<string, any> | null
}

// Context passed by the caller (e.g., outreach-sender.ts) for variables that depend
// on per-send state, not on the lead row itself. Keep this minimal — anything that
// can be derived from `lead` belongs in BUILTIN_VARIABLES instead.
export interface TemplateContext {
    unsubscribeUrl?: string
    /** Campaign BCP-47 language used for multilingual custom-field maps. */
    contentLanguage?: string
}

// Options controlling how substituted values are rendered.
export interface InterpolateOptions {
    // When true, HTML-escape every lead-derived value (built-ins + custom fields) so that
    // lead-controlled data cannot inject markup into the outgoing HTML body. Leave false
    // for subject/plain-text renders where escaping would corrupt the output. See audit
    // finding "unescaped lead-controlled fields injected into email body".
    escapeHtml?: boolean
}

// Default values for when fields are null
const DEFAULT_VALUES: Record<string, string> = {
    firstName: 'there',
    lastName: '',
    companyName: 'your company',
    companySize: '',
    industry: '',
    title: '',
    website: '',
    linkedinUrl: '',
    phone: '',
    location: '',
}

/**
 * Cidade a partir do `location`, que chega do Xcraper como endereço postal completo
 * (`75 Main St, Hudson, MA 01749`). `{{location}}` inteiro não serve em texto de outreach:
 * "barbershops around 75 Main St, Hudson, MA 01749" soa pior que a cidade escrita à mão — e foi
 * por não existir `{{city}}` que a campanha piloto acabou com "Hudson" fixo no corpo, o que só
 * está certo enquanto a campanha não rodar em outra cidade.
 *
 * Regra: no formato `rua, cidade, ESTADO CEP` a cidade é o penúltimo segmento; com dois segmentos
 * (`Hudson, MA`) é o primeiro. Devolve string vazia quando não dá para decidir — um default
 * inventado colocaria a cidade errada no e-mail, que é pior que a frase ficar sem ela.
 */
export function extractCity(location: string | null | undefined): string {
    if (!location) return ''
    const parts = location.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length === 0) return ''
    if (parts.length === 1) return ''
    const last = parts[parts.length - 1]

    // `MA` ou `MA 01749`: o segmento anterior é a cidade. `Hudson, MA` resolve para `Hudson`.
    if (/^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(last)) {
        const city = parts[parts.length - 2]
        return /^\d+$/.test(city ?? '') ? '' : (city ?? '')
    }

    // CEP sozinho não identifica cidade: em `75 Main St, 01749` o segmento anterior é a RUA, não a
    // cidade. Só dá para confiar quando existe um terceiro segmento (`rua, cidade, CEP`).
    if (/^\d{5}(-\d{4})?$/.test(last)) {
        if (parts.length < 3) return ''
        const city = parts[parts.length - 2]
        return /^\d+$/.test(city ?? '') ? '' : (city ?? '')
    }

    return /^\d+$/.test(last) ? '' : last
}


/**
 * Campanha de barbearias (2026-09-30): Vanildo quer a saudação com o nome curto da loja
 * ("Hi Boston Blendz," e não "Hi Boston Blendz Barbershop,"), em todos os e-mails, como se
 * estivesse falando com a barbearia. O nome curto certo é editorial e mora em
 * `custom_fields.shortName` (gravado lead a lead). Esta função é só o fallback para lead que
 * chegou sem ele: tira o descritor do fim do nome ("Barbershop", "Barber Shop", "Barber
 * Studio", "& Beauty Supply", "LLC"…) enquanto sobrar um nome que se sustente sozinho; se
 * não sobrar, devolve o nome inteiro. Nunca devolve string vazia para um nome preenchido.
 */
const SHORT_NAME_TRAILERS = /\s*(?:[-–|,]\s*)?(?:barber\s*shop|barbershop|barber\s+(?:studio|lab|spa|lounge|club)|barbers|and\s+hair\s+styling|&\s*beauty\s+supply|hair\s+salon|grooming|llc\.?|inc\.?)\s*$/i

export function shortenCompanyName(name: string | null | undefined): string {
    const full = (name ?? '').trim()
    if (!full) return ''
    let short = full
    for (let i = 0; i < 3; i++) {
        const next = short.replace(SHORT_NAME_TRAILERS, '').trim()
        if (next === short) break
        short = next
    }
    // "Barbershop Deluxe" fica inteiro (o descritor não está no fim); "The Barbery" idem.
    // Se sobrou pouco ("The", "A", "Los") o corte comeu o nome: volta o original.
    if (short.length < 3 || /^(the|a|an|los|las|el|la)$/i.test(short)) return full
    return short
}
// Built-in variable handlers
const BUILTIN_VARIABLES: Record<string, (lead: LeadForTemplate) => string> = {
    '{{firstName}}': (lead) => lead.firstName || DEFAULT_VALUES.firstName,
    '{{lastname}}': (lead) => lead.lastName || DEFAULT_VALUES.lastName,
    '{{lastName}}': (lead) => lead.lastName || DEFAULT_VALUES.lastName,
    '{{email}}': (lead) => lead.email,
    '{{companyName}}': (lead) => lead.companyName || DEFAULT_VALUES.companyName,
    '{{company}}': (lead) => lead.companyName || DEFAULT_VALUES.companyName,
    '{{companySize}}': (lead) => lead.companySize || DEFAULT_VALUES.companySize,
    '{{industry}}': (lead) => lead.industry || DEFAULT_VALUES.industry,
    '{{title}}': (lead) => lead.title || DEFAULT_VALUES.title,
    '{{website}}': (lead) => lead.website || DEFAULT_VALUES.website,
    '{{linkedinUrl}}': (lead) => lead.linkedinUrl || DEFAULT_VALUES.linkedinUrl,
    '{{phone}}': (lead) => lead.phone || DEFAULT_VALUES.phone,
    '{{location}}': (lead) => lead.location || DEFAULT_VALUES.location,
    '{{city}}': (lead) => extractCity(lead.location),
    '{{shortName}}': (lead) => {
        const explicit = lead.customFields?.shortName
        if (explicit != null && String(explicit).trim() !== '') return String(explicit).trim()
        return shortenCompanyName(lead.companyName) || DEFAULT_VALUES.firstName
    },
    '{{fullName}}': (lead) => {
        const parts = [lead.firstName, lead.lastName].filter(Boolean)
        return parts.length > 0 ? parts.join(' ') : 'there'
    },
}

// Regex to match {{variableName}} patterns
const VARIABLE_REGEX = /\{\{([a-zA-Z0-9_]+)\}\}/g

// ─── Conditional blocks ({{#flag}}...{{/flag}} and {{^flag}}...{{/flag}}) ────────────────────────
//
// Mustache-style sections, resolved BEFORE variable substitution and only ever from the template
// string, never from lead data (a lead field containing "{{#x}}" is substituted afterwards, as
// plain text, and is not re-scanned). Rules:
//   - `{{#flag}}…{{/flag}}` renders its inner text only when `flag` is truthy for the lead;
//     `{{^flag}}…{{/flag}}` only when it is falsy. Inner text may contain {{variables}}.
//   - NO NESTING. A section opened inside another section is malformed.
//   - A tag alone on its line (only spaces/tabs around it) takes its whole line with it, so a
//     multi-line block leaves no blank line behind. Whatever else is left empty is cleaned up by
//     collapseEmptyParagraphs, which runs last.
//   - A malformed tag (unclosed, stray close, nested open, bad name) is NEVER sent: it is stripped
//     from the output. For an unclosed section the inner text is kept, the tag removed.
//     validateTemplateSections() reports every one of these so campaign activation can refuse.

/**
 * Built-in computed flags. They are derived per lead, inside this module, so the send path and the
 * approval preview (both call interpolateTemplate) can never disagree. A built-in wins over a
 * custom field of the same name.
 */
const BUILTIN_FLAGS: Record<string, (lead: LeadForTemplate) => boolean> = {
    // Lead ZIP within OUTREACH_HOME_RADIUS_MILES of OUTREACH_HOME_BASE_ZIP (see zip-distance.ts).
    nearby: (lead) => isZipNearHome(extractLeadZip(lead.location, lead.customFields)),
    // Has its own website but no online-booking platform/URL on record.
    hookNoOnlineBooking: (lead) => {
        const cf = lead.customFields
        return readBooleanField(cf?.has_owned_website) === true
            && !hasText(cf?.booking_platform)
            && !hasText(cf?.booking_url)
    },
    // Data SAYS there is no own website: has_owned_website is explicitly false AND web_presence_type
    // is present and is not 'owned_website'. Missing data is false: a failed analysis is not "no website".
    // Mutually exclusive with hookNoOnlineBooking by construction (has_owned_website true vs false).
    hookNoWebsite: (lead) => {
        const cf = lead.customFields
        const presence = cf?.web_presence_type
        return readBooleanField(cf?.has_owned_website) === false
            && typeof presence === 'string'
            && presence.trim() !== ''
            && presence.trim() !== 'owned_website'
    },
}

function hasText(value: unknown): boolean {
    if (value == null) return false
    return String(value).trim() !== ''
}

/** true / 'true' -> true, false / 'false' -> false, anything else (missing, null, '') -> null. */
function readBooleanField(value: unknown): boolean | null {
    if (value === true) return true
    if (value === false) return false
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase()
        if (v === 'true') return true
        if (v === 'false') return false
    }
    return null
}

/** Truthiness of a custom field: true, 'true', non-empty string, non-zero number, non-empty list/object. */
function isTruthyCustomField(value: unknown): boolean {
    if (value == null) return false
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) && value !== 0
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase()
        return v !== '' && v !== 'false'
    }
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object') return Object.keys(value as object).length > 0
    return false
}

function evaluateFlag(name: string, lead: LeadForTemplate): boolean {
    const builtin = Object.entries(BUILTIN_FLAGS).find(([key]) => key.toLowerCase() === name.toLowerCase())
    if (builtin) return builtin[1](lead)
    const cf = lead.customFields
    if (!cf || !Object.prototype.hasOwnProperty.call(cf, name)) return false
    return isTruthyCustomField(cf[name])
}

// Any `{{#`, `{{^` or `{{/` opener. The closing `}}` is optional in the pattern so an unterminated tag is
// still caught (and reported / stripped) instead of leaking into the email as raw text; an
// unterminated tag stops at the end of its line.
const SECTION_TAG = /\{\{[ \t]*([#^/])([^{}\n]*)(\}\})?/g
const SECTION_NAME = /^[A-Za-z0-9_]+$/

/**
 * When the tag at [start, end) is alone on its line (only spaces/tabs around it), widen the range to
 * the whole line including its newline, so removing the tag leaves no blank line or indentation.
 */
function widenStandaloneTag(template: string, start: number, end: number): [number, number] {
    let s = start
    while (s > 0 && (template[s - 1] === ' ' || template[s - 1] === '\t')) s--
    if (s > 0 && template[s - 1] !== '\n') return [start, end]
    let e = end
    while (e < template.length && (template[e] === ' ' || template[e] === '\t')) e++
    if (e < template.length && template[e] === '\r') e++
    if (e < template.length && template[e] !== '\n') return [start, end]
    if (e < template.length) e++
    return [s, e]
}

/**
 * Resolves the sections of `template`. `isTruthy` is asked once per well-formed section; pass null
 * when only the diagnostics are wanted (validation), in which case `text` is not meaningful.
 */
function resolveSections(
    template: string,
    isTruthy: ((name: string) => boolean) | null,
): { text: string; issues: string[] } {
    const issues: string[] = []
    let out = ''
    let cursor = 0
    let open: { name: string; inverted: boolean } | null = null
    let inner = ''

    const append = (s: string) => {
        if (open) inner += s
        else out += s
    }

    for (const match of template.matchAll(SECTION_TAG)) {
        const index = match.index ?? 0
        const [start, end] = widenStandaloneTag(template, index, index + match[0].length)
        // Overlap guard: a previous widened range may already have consumed this tag's whitespace.
        append(template.slice(cursor, Math.max(cursor, start)))
        cursor = Math.max(cursor, end)

        const sigil = match[1]
        const rawName = match[2].trim()
        const display = `{{${sigil}${rawName}}}`

        if (match[3] === undefined || !SECTION_NAME.test(rawName)) {
            issues.push(`Malformed template tag "${match[0].trim()}"`)
            continue
        }

        if (sigil === '/') {
            if (open && open.name === rawName) {
                if (isTruthy && isTruthy(rawName) !== open.inverted) out += inner
                open = null
                inner = ''
            } else if (open) {
                issues.push(`Closing tag ${display} does not match the open section {{${open.inverted ? '^' : '#'}${open.name}}}`)
            } else {
                issues.push(`Closing tag ${display} has no opening tag`)
            }
            continue
        }

        if (open) {
            issues.push(`Section ${display} is nested inside {{${open.inverted ? '^' : '#'}${open.name}}} (nesting is not supported)`)
            continue
        }
        open = { name: rawName, inverted: sigil === '^' }
        inner = ''
    }

    append(template.slice(cursor))
    if (open) {
        issues.push(`Section {{${open.inverted ? '^' : '#'}${open.name}}} is never closed`)
        out += inner
    }
    return { text: out, issues }
}


/**
 * Problems with conditional blocks in a template: unclosed, stray or mismatched closing, nested,
 * or malformed tags. Empty means the blocks are well-formed. Used by validateTemplate and by the
 * campaign activation readiness check.
 */
export function validateTemplateSections(template: string | null | undefined): string[] {
    if (!template) return []
    return resolveSections(template, null).issues
}

/**
 * Fase 45 / campanha "Barbershops - AI Receptionist - Pilot 01": entre 50% e 80% dos leads não
 * têm `websiteInsights`, e o passo 1 dessa campanha tem `{{websiteInsight}}` sozinho em seu
 * próprio parágrafo. `interpolateTemplate` resolve isso para `''`, o que — sem este passo —
 * deixa um buraco de linhas em branco exatamente no meio do e-mail, um sinal de automação tanto
 * para quem lê quanto para filtros de spam.
 *
 * Aplicado SEMPRE, no final de `interpolateTemplate` (nunca nos call sites), para que o corpo
 * enviado (`outreach-sender.ts`) e o preview de aprovação (`outreach-approval-preview.ts`) —
 * que chamam a mesma função — produzam exatamente a mesma string. Nunca toca uma variável que
 * está no meio de uma frase: só remove uma linha (texto puro) ou elemento de bloco (HTML) que
 * ficou inteiramente vazio.
 */
function collapseEmptyParagraphs(text: string): string {
    if (!text) return text

    return text
        // HTML: um <p>/<div> (com ou sem atributos) cujo conteúdo interpolado ficou vazio —
        // só espaços e/ou <br> — some por completo. Consome também UMA quebra de linha
        // adjacente (a de trás, se existir) para não deixar uma linha vazia sobrando entre os
        // parágrafos vizinhos, mas preserva a quebra que já separava esses vizinhos.
        .replace(/<(p|div)(\s[^>]*)?>(?:\s|<br\s*\/?>)*<\/\1>\n?/gi, '')
        // Texto puro: uma variável que ocupava uma linha inteira e virou '' deixa uma linha em
        // branco "extra" ao lado da linha em branco que já separava os parágrafos — dois
        // separadores ficam adjacentes. Normaliza qualquer linha só-de-espaços para vazia e
        // depois colapsa qualquer sequência de 2+ linhas em branco (3+ '\n' consecutivos) para
        // exatamente UMA linha em branco — o separador de parágrafo normal, nunca zero.
        .split('\n')
        .map((line) => (line.trim() === '' ? '' : line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
}

/**
 * Interpolate template variables with lead data
 * 
 * @param template - The template string containing {{variable}} placeholders
 * @param lead - The lead data to use for interpolation
 * @returns The interpolated string with variables replaced
 * 
 * @example
 * const template = "Hi {{firstName}}, thanks for your interest in {{companyName}}!"
 * const lead = { firstName: "John", companyName: "Acme Corp", ... }
 * const result = interpolateTemplate(template, lead)
 * // Result: "Hi John, thanks for your interest in Acme Corp!"
 */
export function interpolateTemplate(
    template: string,
    lead: LeadForTemplate,
    context: TemplateContext = {},
    options: InterpolateOptions = {}
): string {
    if (!template) return template

    const escape = options.escapeHtml ? escapeHtml : (v: string) => v

    // audit-2026-07: single pass over {{...}} placeholders. The previous two-pass version
    // (a) used string replacements, so `$&`/`` $` `` in lead data were interpreted as regex
    // substitution patterns and corrupted output, and (b) re-scanned already-substituted
    // values, so a lead field containing `{{var}}` was itself expanded (template injection).
    // One functional-replacer pass fixes both, and escapes lead-derived values when asked.
    // Conditional blocks first, from the template string alone: lead data is only substituted below,
    // in the single pass that follows, so nothing a lead field contains can open or close a block.
    const { text: withSectionsResolved } = resolveSections(template, (flag) => evaluateFlag(flag, lead))

    return collapseEmptyParagraphs(withSectionsResolved.replace(VARIABLE_REGEX, (_match, variableName: string) => {
        // Context-provided values (internally generated, e.g. the unsubscribe URL) — not escaped.
        if (variableName === 'unsubscribeUrl') return context.unsubscribeUrl ?? ''

        // `websiteInsight` is a stable English token whose VALUE is multilingual.
        // Xphere supplies websiteInsights as { en, pt, es, ... }; the campaign
        // chooses the language at send time so the same lead can safely appear in
        // campaigns written in different languages.
        if (variableName.toLowerCase() === 'websiteinsight') {
            const raw = lead.customFields?.websiteInsights
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                const insights = raw as Record<string, unknown>
                const requested = context.contentLanguage || 'en'
                const base = requested.split('-')[0]
                const value = insights[requested] ?? insights[base] ?? insights.en
                return value != null ? escape(String(value)) : ''
            }
            const legacy = lead.customFields?.websiteInsight
            return legacy != null ? escape(String(legacy)) : ''
        }

        // Built-in lead fields (case-insensitive).
        const lowerName = variableName.toLowerCase()
        for (const [token, handler] of Object.entries(BUILTIN_VARIABLES)) {
            if (token.toLowerCase() === `{{${lowerName}}}`) {
                return escape(handler(lead))
            }
        }

        // Custom fields from the lead's JSONB column.
        if (lead.customFields && variableName in lead.customFields) {
            const value = lead.customFields[variableName]
            return value != null ? escape(String(value)) : ''
        }

        // Unknown variable — empty string is safer than leaking the raw placeholder.
        return ''
    }))
}

/**
 * Extract all variable names from a template
 * 
 * @param template - The template string to analyze
 * @returns Array of variable names found (without the {{ }})
 * 
 * @example
 * const template = "Hi {{firstName}} from {{companyName}}"
 * extractVariables(template) // ['firstName', 'companyName']
 */
export function extractVariables(template: string): string[] {
    if (!template) return []

    const variables: string[] = []
    const seen = new Set<string>()

    let match
    const regex = new RegExp(VARIABLE_REGEX.source, 'g')

    while ((match = regex.exec(template)) !== null) {
        const varName = match[1]
        if (!seen.has(varName)) {
            seen.add(varName)
            variables.push(varName)
        }
    }

    return variables
}

/**
 * Validate that all variables in a template can be resolved
 * 
 * @param template - The template string to validate
 * @param lead - The lead data to check against
 * @returns Object with isValid flag and any missing variables
 */
export function validateTemplate(
    template: string,
    lead: Partial<LeadForTemplate>
): { isValid: boolean; missingVariables: string[]; warnings: string[]; sectionErrors: string[] } {
    const variables = extractVariables(template)
    const missingVariables: string[] = []
    const warnings: string[] = []
    // Malformed {{#flag}}/{{^flag}}/{{/flag}} blocks make the template invalid.
    const sectionErrors = validateTemplateSections(template)

    const builtInNames = new Set(
        Object.keys(BUILTIN_VARIABLES).map(v => v.replace(/[{}]/g, '').toLowerCase())
    )

    for (const varName of variables) {
        const lowerName = varName.toLowerCase()

        // Check if it's a built-in variable
        if (builtInNames.has(lowerName)) {
            // Check if the lead has a null value for this field (will use default)
            const fieldName = lowerName === 'fullname' ? 'firstName' : lowerName
            if (fieldName in lead && lead[fieldName as keyof LeadForTemplate] === null) {
                warnings.push(`Variable {{${varName}}} will use default value`)
            }
        } else {
            // It's a custom field - check if it exists
            if (!lead.customFields || !(varName in lead.customFields)) {
                missingVariables.push(varName)
            }
        }
    }

    return {
        isValid: missingVariables.length === 0 && sectionErrors.length === 0,
        missingVariables,
        warnings,
        sectionErrors,
    }
}

/**
 * Get a list of all available variables for a lead
 * 
 * @param lead - Optional lead to check which custom fields are available
 * @returns Object with built-in and custom variable names
 */
export function getAvailableVariables(lead?: LeadForTemplate): {
    builtIn: string[]
    custom: string[]
} {
    const builtIn = Object.keys(BUILTIN_VARIABLES).map(v => v.replace(/[{}]/g, ''))

    const custom = lead?.customFields ? Object.keys(lead.customFields) : []

    return { builtIn, custom }
}

/**
 * Preview a template with sample data
 * 
 * @param template - The template string
 * @returns Interpolated template with sample values
 */
export function previewTemplate(template: string): string {
    const sampleLead: LeadForTemplate = {
        email: 'john.doe@example.com',
        firstName: 'John',
        lastName: 'Doe',
        companyName: 'Acme Corporation',
        companySize: '51-200',
        industry: 'Technology',
        title: 'Product Manager',
        website: 'https://acme.com',
        linkedinUrl: 'https://linkedin.com/in/johndoe',
        phone: '+1 (555) 123-4567',
        location: 'San Francisco, CA',
        customFields: {},
    }

    return interpolateTemplate(template, sampleLead)
}

// Export types
export type { LeadForTemplate }
