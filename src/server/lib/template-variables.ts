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
export function interpolateTemplate(template: string, lead: LeadForTemplate, context: TemplateContext = {}): string {
    if (!template) return template

    let result = template

    // First, handle built-in variables (case-insensitive matching)
    for (const [token, handler] of Object.entries(BUILTIN_VARIABLES)) {
        // Match both {{firstName}} and {{firstname}} etc.
        const lowerToken = token.toLowerCase()
        const regex = new RegExp(escapeRegex(token) + '|' + escapeRegex(lowerToken), 'gi')
        result = result.replace(regex, handler(lead))
    }

    // Then handle any remaining {{variable}} patterns (custom fields)
    result = result.replace(VARIABLE_REGEX, (match, variableName) => {
        if (variableName === 'unsubscribeUrl') return context.unsubscribeUrl ?? ''
        // Check if it's a custom field
        if (lead.customFields && variableName in lead.customFields) {
            const value = lead.customFields[variableName]
            return value != null ? String(value) : ''
        }

        // Check if it's a built-in variable we might have missed (different case)
        const lowerName = variableName.toLowerCase()
        for (const [token, handler] of Object.entries(BUILTIN_VARIABLES)) {
            if (token.toLowerCase() === `{{${lowerName}}}`) {
                return handler(lead)
            }
        }

        // Unknown variable - return empty string or keep the placeholder
        // Returning empty string is safer for production
        return ''
    })

    return result
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
 * Escape special regex characters in a string
 */
function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
