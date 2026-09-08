/**
 * Compliance checks for a campaign's sequence content, evaluated at approval-preview time
 * (Fase 37 / audit finding 2 — see docs/outreach-hermes-system-map.md §8).
 *
 * Pure, DB/HTTP-free by design (mirrors the daily-territory-budget.ts split): every input is a
 * plain object already read from the database, so these functions are unit-testable directly
 * and reusable from both the approvals route and its tests without spinning up Postgres.
 *
 * These checks are informational for the human reviewer — they do NOT gate activation. The
 * gate that actually blocks activation is `validateCampaignReadyForActivation` in
 * routes/outreach/campaigns.ts (G9). Adding a hard block here would widen what approval does,
 * which Fase 37 explicitly avoids: the fix is visibility, not a new veto.
 */

// Minimal shape of a sequence step needed for compliance evaluation — deliberately narrower
// than the full Drizzle `SequenceStep` row so this module has zero DB dependency.
export interface CampaignComplianceStep {
    stepOrder: number
    type: string
    subject: string | null
    plainBody: string | null
    htmlBody: string | null
    subjectB: string | null
    plainBodyB: string | null
    htmlBodyB: string | null
    abTestEnabled: boolean
}

export interface ComplianceBlocker {
    code: 'missing_physical_address' | 'missing_unsubscribe_placeholder'
    message: string
}

export interface CampaignComplianceAssessment {
    /** True only when every email step's content includes a physical postal address. */
    hasPhysicalAddress: boolean
    /** True only when every email step (both A/B variants, when A/B is on) renders {{unsubscribeUrl}}. */
    unsubscribePresentInEveryStep: boolean
    stepsMissingAddress: number[]
    stepsMissingUnsubscribe: number[]
    blockers: ComplianceBlocker[]
}

const STREET_SUFFIXES = [
    'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'road', 'rd', 'lane', 'ln',
    'drive', 'dr', 'court', 'ct', 'way', 'circle', 'cir', 'place', 'pl', 'suite', 'ste',
    'terrace', 'ter', 'parkway', 'pkwy', 'highway', 'hwy', 'square', 'sq',
]

// A street number, 1-6 words, then a recognized street-type token. This alone is not enough —
// "we just moved into a new office on Main Street" would match — so it is only treated as a
// real address when a ZIP or state code shows up shortly after it (see ZIP_OR_STATE_RE below).
const STREET_ADDRESS_RE = new RegExp(
    `\\b\\d{1,6}\\s+[A-Za-z0-9.'-]+(?:\\s+[A-Za-z0-9.'-]+){0,5}\\s+(${STREET_SUFFIXES.join('|')})\\b\\.?`,
    'i',
)
// A two-letter state code followed by a ZIP, or a bare 5(+4)-digit ZIP.
const ZIP_OR_STATE_RE = /\b([A-Z]{2}\s+\d{5}(?:-\d{4})?|\d{5}(?:-\d{4})?)\b/
// How far past the matched street token a ZIP/state may appear and still count as the same
// address (covers "123 Main St, Hudson, MA 01749" and similar city/state tails).
const ADDRESS_WINDOW_CHARS = 80

/**
 * Heuristic CAN-SPAM physical-address detector. Not a full address parser — it looks for the
 * two signals that distinguish a real mailing address from an incidental street mention: a
 * street-numbered, street-typed phrase, followed nearby by a ZIP code or state abbreviation.
 */
export function containsPhysicalPostalAddress(text: string | null | undefined): boolean {
    if (!text) return false
    // Strip markup so an HTML <address> block or a <br>-separated address still reads as text.
    const plain = text.replace(/<[^>]+>/g, ' ')
    const streetMatch = STREET_ADDRESS_RE.exec(plain)
    if (!streetMatch) return false
    const windowEnd = Math.min(plain.length, streetMatch.index + streetMatch[0].length + ADDRESS_WINDOW_CHARS)
    return ZIP_OR_STATE_RE.test(plain.slice(streetMatch.index, windowEnd))
}

// The literal token the sender actually substitutes at send time (src/server/lib/
// template-variables.ts checks this exact case, not the case-insensitive built-in-variable
// path) — so the compliance check must look for this exact casing, not a case-insensitive one.
const UNSUBSCRIBE_TOKEN = '{{unsubscribeUrl}}'

/** True when a single email step is missing {{unsubscribeUrl}} in a body it will actually send. */
function stepMissingUnsubscribe(step: CampaignComplianceStep): boolean {
    const variantABodies = [step.plainBody, step.htmlBody].filter((b): b is string => Boolean(b))
    const variantAOk = variantABodies.length > 0 && variantABodies.some((b) => b.includes(UNSUBSCRIBE_TOKEN))
    if (!step.abTestEnabled) return !variantAOk

    const variantBBodies = [step.plainBodyB, step.htmlBodyB].filter((b): b is string => Boolean(b))
    const variantBOk = variantBBodies.length > 0 && variantBBodies.some((b) => b.includes(UNSUBSCRIBE_TOKEN))
    return !(variantAOk && variantBOk)
}

/**
 * Assess a campaign's canonical sequence for the two compliance elements Fase 37 calls out:
 * a physical postal address somewhere in the body, and {{unsubscribeUrl}} in every step (both
 * A/B variants when A/B testing is on). Non-email steps (delay/condition) carry no content and
 * are excluded from both checks.
 */
export function assessCampaignActivationCompliance(steps: CampaignComplianceStep[]): CampaignComplianceAssessment {
    const emailSteps = steps.filter((step) => step.type === 'email')

    const stepsMissingAddress = emailSteps
        .filter((step) => {
            const combined = [step.subject, step.plainBody, step.htmlBody, step.subjectB, step.plainBodyB, step.htmlBodyB]
                .filter((part): part is string => Boolean(part))
                .join('\n')
            return !containsPhysicalPostalAddress(combined)
        })
        .map((step) => step.stepOrder)

    const stepsMissingUnsubscribe = emailSteps
        .filter(stepMissingUnsubscribe)
        .map((step) => step.stepOrder)

    const hasPhysicalAddress = emailSteps.length > 0 && stepsMissingAddress.length === 0
    const unsubscribePresentInEveryStep = emailSteps.length > 0 && stepsMissingUnsubscribe.length === 0

    const blockers: ComplianceBlocker[] = []
    if (!hasPhysicalAddress) {
        blockers.push({
            code: 'missing_physical_address',
            message: emailSteps.length === 0
                ? 'Campaign has no email steps to check for a physical postal address.'
                : stepsMissingAddress.length === emailSteps.length
                    ? 'No step in this sequence includes a physical postal address (CAN-SPAM requirement).'
                    : `Step(s) ${stepsMissingAddress.join(', ')} are missing a physical postal address.`,
        })
    }
    if (!unsubscribePresentInEveryStep) {
        blockers.push({
            code: 'missing_unsubscribe_placeholder',
            message: emailSteps.length === 0
                ? 'Campaign has no email steps to check for {{unsubscribeUrl}}.'
                : `Step(s) ${stepsMissingUnsubscribe.join(', ')} do not render {{unsubscribeUrl}} in the sent body.`,
        })
    }

    return { hasPhysicalAddress, unsubscribePresentInEveryStep, stepsMissingAddress, stepsMissingUnsubscribe, blockers }
}
