/**
 * Template Variable Interpolation for Outreach Emails
 * 
 * Supports personalization tokens like {{firstName}}, {{companyName}}, etc.
 * Also supports custom fields from the lead's customFields JSONB column.
 */

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

/** Escape the five HTML-significant characters. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
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
    '{{fullName}}': (lead) => {
        const parts = [lead.firstName, lead.lastName].filter(Boolean)
        return parts.length > 0 ? parts.join(' ') : 'there'
    },
}

// Regex to match {{variableName}} patterns
const VARIABLE_REGEX = /\{\{([a-zA-Z0-9_]+)\}\}/g

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
    return template.replace(VARIABLE_REGEX, (_match, variableName: string) => {
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
    })
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
): { isValid: boolean; missingVariables: string[]; warnings: string[] } {
    const variables = extractVariables(template)
    const missingVariables: string[] = []
    const warnings: string[] = []

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
        isValid: missingVariables.length === 0,
        missingVariables,
        warnings,
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
