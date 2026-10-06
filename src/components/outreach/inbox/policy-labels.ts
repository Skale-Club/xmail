// A readable next step for each recoverable delivery-policy denial code.
// Shared by the composer (send command) and the AI automation history.
export const POLICY_HINTS: Record<string, string> = {
    organization_disabled: 'Outreach is paused for this organization. It will send when re-enabled.',
    campaign_inactive: 'The linked campaign is not active.',
    account_not_verified: 'The sending account is not verified.',
    account_cross_organization: 'That account belongs to another organization.',
    recipient_suppressed: 'The recipient is on the suppression list.',
    lead_unsubscribed: 'The recipient has unsubscribed.',
    outside_send_window: 'Outside the account send window. It will send in-window.',
    daily_limit_exhausted: 'The account hit its daily limit. It will resume tomorrow.',
    warmup_limit_exhausted: 'The account is warming up. It will resume as warm-up allows.',
    account_spacing: 'Waiting for the minimum spacing between sends.',
}

export function policyHint(code: string | null | undefined): string {
    if (!code) return ''
    return POLICY_HINTS[code] ?? `Delivery is paused (${code}).`
}
