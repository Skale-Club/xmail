import React from 'react'
import { AlertTriangle, PauseCircle, PlayCircle, ShieldCheck, Sparkles } from 'lucide-react'
import { Switch } from '../../ui/switch'
import { Button } from '../../ui/button'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import type { CampaignAiAutomation, OrgAiAutomationSettings } from '../../../lib/unified-inbox-api'

// ============================================================
// AI autonomy controls (Phase 23 AI-03 / AI-06)
// ============================================================
// The transparent opt-in surface. Both flags are DEFAULT-OFF; enabling autonomous sending is a
// deliberate, CONFIRMED action; the org kill switch pauses IMMEDIATELY (one click, no confirm); and
// each control DISPLAYS THE EFFECTIVE SCOPE — whether autonomy is actually active right now (org on
// AND campaign on AND unpaused AND outreach enabled). A campaign opt-in can never override the org
// being off or paused; the control shows exactly why it is or isn't effective.
//
// These are PRESENTATIONAL components: all state + persistence lives in the parent (SettingsPage /
// OverviewTab) so the safety behaviors (default-off, confirm-to-enable, immediate pause, effective
// display) are unit-testable without a network.

// ------------------------------------------------------------
// Organization control
// ------------------------------------------------------------

export interface OrgAiAutomationControlProps {
    settings: OrgAiAutomationSettings | undefined
    isLoading?: boolean
    /** Whether the current user may change these controls (org admin/member). Viewers see read-only. */
    canManage: boolean
    onSetDraftAssistance: (enabled: boolean) => void
    /** Called with the NEW value. Enabling is only ever called AFTER an explicit confirmation. */
    onSetAutonomous: (enabled: boolean) => void
    onPause: (reason: string) => void
    onResume: () => void
    pending?: boolean
    error?: string | null
}

function orgEffectiveBanner(s: OrgAiAutomationSettings): { tone: string; icon: React.ReactNode; text: string } {
    if (!s.autonomousEnabled) {
        return { tone: 'text-muted-foreground', icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />, text: 'Autonomous sending is OFF for this organization.' }
    }
    if (s.autonomyPaused) {
        return { tone: 'text-amber-700 dark:text-amber-400', icon: <PauseCircle className="h-4 w-4" aria-hidden="true" />, text: 'Autonomous sending is PAUSED. The kill switch is active — nothing sends until you resume.' }
    }
    if (!s.outreachEnabled) {
        return { tone: 'text-red-600 dark:text-red-400', icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />, text: 'Autonomous sending is BLOCKED — outreach sending is disabled for this organization.' }
    }
    return { tone: 'text-emerald-700 dark:text-emerald-400', icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />, text: 'Autonomous sending is ACTIVE at the organization level. Each campaign must ALSO opt in before it sends.' }
}

export function OrgAiAutomationControl({
    settings,
    isLoading = false,
    canManage,
    onSetDraftAssistance,
    onSetAutonomous,
    onPause,
    onResume,
    pending = false,
    error = null,
}: OrgAiAutomationControlProps) {
    const [confirmAutonomy, setConfirmAutonomy] = React.useState(false)
    const [reason, setReason] = React.useState('')

    if (isLoading || !settings) {
        return (
            <div className="bg-card rounded-lg border border-border p-4">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            </div>
        )
    }

    const disabled = !canManage || pending
    const banner = orgEffectiveBanner(settings)

    const onAutonomousToggle = (next: boolean) => {
        if (next) {
            // Enabling autonomous sending is a deliberate action — require an explicit confirmation.
            setConfirmAutonomy(true)
        } else {
            // Disabling is immediate; a kill switch or opt-out never needs a confirmation.
            onSetAutonomous(false)
        }
    }

    return (
        <div className="bg-card rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border p-4">
                <Sparkles className="h-5 w-5 text-gray-500" aria-hidden="true" />
                <h3 className="font-semibold text-foreground">AI Assistant &amp; Automation</h3>
            </div>
            <div className="space-y-4 p-4">
                <p className="text-xs text-muted-foreground">
                    Draft assistance and autonomous sending are two SEPARATE, off-by-default permissions.
                    Draft assistance only pre-fills replies for a human to review and send. Autonomous
                    sending lets the assistant reply on its own — it additionally requires each campaign to
                    opt in, and every send still passes the same suppression, limit, warm-up, spacing, and
                    kill-switch checks as any other outreach.
                </p>

                {/* Draft assistance — a direct toggle (no send capability, so no confirmation). */}
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <label htmlFor="ai-draft-toggle" className="text-sm font-medium text-foreground">Draft assistance</label>
                        <p className="text-xs text-muted-foreground">Suggest editable reply drafts in the Unified Inbox. Never sends.</p>
                    </div>
                    <Switch
                        id="ai-draft-toggle"
                        aria-label="Draft assistance"
                        checked={settings.draftAssistanceEnabled}
                        disabled={disabled}
                        onCheckedChange={(next) => onSetDraftAssistance(next)}
                    />
                </div>

                {/* Autonomous sending — enabling requires an explicit confirmation. */}
                <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
                    <div>
                        <label htmlFor="ai-autonomous-toggle" className="text-sm font-medium text-foreground">Autonomous sending</label>
                        <p className="text-xs text-muted-foreground">Let the assistant reply to inbound messages on its own (per-campaign opt-in also required).</p>
                    </div>
                    <Switch
                        id="ai-autonomous-toggle"
                        aria-label="Autonomous sending"
                        checked={settings.autonomousEnabled}
                        disabled={disabled}
                        onCheckedChange={onAutonomousToggle}
                    />
                </div>

                {/* Effective scope — always visible so nothing is silently enabled. */}
                <div className={`flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm ${banner.tone}`} role="status">
                    {banner.icon}
                    <span>{banner.text}</span>
                </div>

                {/* Immediate kill switch. */}
                {settings.autonomousEnabled && (
                    settings.autonomyPaused ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                            <div className="text-xs text-amber-700 dark:text-amber-300">
                                Paused{settings.autonomyPausedReason ? ` — ${settings.autonomyPausedReason}` : ''}.
                            </div>
                            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onResume()}>
                                <PlayCircle className="mr-1.5 h-4 w-4" aria-hidden="true" /> Resume automation
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-wrap items-end justify-between gap-3">
                            <div className="flex-1">
                                <label htmlFor="ai-pause-reason" className="text-xs text-muted-foreground">Pause reason (optional)</label>
                                <input
                                    id="ai-pause-reason"
                                    type="text"
                                    value={reason}
                                    disabled={disabled}
                                    onChange={(e) => setReason(e.target.value)}
                                    className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                                    placeholder="e.g. reviewing recent replies"
                                />
                            </div>
                            <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={disabled}
                                onClick={() => onPause(reason.trim())}
                            >
                                <PauseCircle className="mr-1.5 h-4 w-4" aria-hidden="true" /> Pause automation
                            </Button>
                        </div>
                    )
                )}

                {error && (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>
                )}
                {!canManage && (
                    <p className="text-xs italic text-muted-foreground">You have read-only access to these controls.</p>
                )}
            </div>

            <ConfirmDialog
                open={confirmAutonomy}
                onOpenChange={setConfirmAutonomy}
                title="Enable autonomous sending?"
                description="The assistant will be able to send replies on its own for campaigns that also opt in. Every send still passes suppression, sending-limit, warm-up, spacing, and kill-switch checks. You can pause it immediately at any time."
                confirmLabel="Enable autonomous sending"
                cancelLabel="Cancel"
                variant="warning"
                loading={pending}
                onConfirm={() => { onSetAutonomous(true); setConfirmAutonomy(false) }}
            />
        </div>
    )
}

// ------------------------------------------------------------
// Campaign control
// ------------------------------------------------------------

export interface CampaignAiAutomationControlProps {
    automation: CampaignAiAutomation | undefined
    isLoading?: boolean
    canManage: boolean
    /** Called with the NEW value. Enabling is only ever called AFTER an explicit confirmation. */
    onSetEnabled: (enabled: boolean) => void
    pending?: boolean
    error?: string | null
}

function campaignEffectiveBanner(a: CampaignAiAutomation): { tone: string; icon: React.ReactNode; text: string } {
    if (a.effective.enabled) {
        return { tone: 'text-emerald-700 dark:text-emerald-400', icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />, text: 'Autonomous replies are ACTIVE for this campaign.' }
    }
    switch (a.effective.reason) {
        case 'org_disabled':
            return { tone: 'text-muted-foreground', icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />, text: 'Organization-level autonomous sending is off. Turn it on in outreach Settings to enable this.' }
        case 'org_paused':
            return { tone: 'text-amber-700 dark:text-amber-400', icon: <PauseCircle className="h-4 w-4" aria-hidden="true" />, text: 'Organization automation is paused. Resume it in Settings before this campaign can send.' }
        case 'campaign_disabled':
            return { tone: 'text-muted-foreground', icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />, text: 'Turn on the toggle to let this campaign send autonomous replies.' }
        case 'campaign_inactive':
            return { tone: 'text-muted-foreground', icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />, text: 'This campaign is not active, so autonomous replies will not run.' }
        case 'outreach_disabled':
            return { tone: 'text-red-600 dark:text-red-400', icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />, text: 'Outreach sending is disabled for this organization.' }
        default:
            return { tone: 'text-muted-foreground', icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />, text: 'Autonomous replies are not active for this campaign.' }
    }
}

export function CampaignAiAutomationControl({
    automation,
    isLoading = false,
    canManage,
    onSetEnabled,
    pending = false,
    error = null,
}: CampaignAiAutomationControlProps) {
    const [confirm, setConfirm] = React.useState(false)

    if (isLoading || !automation) {
        return (
            <div className="bg-card border border-border rounded-lg p-4">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            </div>
        )
    }

    const disabled = !canManage || pending
    const banner = campaignEffectiveBanner(automation)

    const onToggle = (next: boolean) => {
        if (next) setConfirm(true)
        else onSetEnabled(false)
    }

    return (
        <div className="bg-card border border-border rounded-lg">
            <div className="flex items-center gap-2 border-b border-border p-4">
                <Sparkles className="h-5 w-5 text-gray-500" aria-hidden="true" />
                <h3 className="font-semibold text-foreground">Autonomous AI replies</h3>
            </div>
            <div className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <label htmlFor="campaign-ai-toggle" className="text-sm font-medium text-foreground">Let AI reply to inbound messages for this campaign</label>
                        <p className="text-xs text-muted-foreground">Off by default. Requires organization-level autonomy to also be on and unpaused.</p>
                    </div>
                    <Switch
                        id="campaign-ai-toggle"
                        aria-label="Autonomous AI replies for this campaign"
                        checked={automation.campaignAiAutonomousEnabled}
                        disabled={disabled}
                        onCheckedChange={onToggle}
                    />
                </div>

                <div className={`flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm ${banner.tone}`} role="status">
                    {banner.icon}
                    <span>{banner.text}</span>
                </div>

                {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
                {!canManage && <p className="text-xs italic text-muted-foreground">You have read-only access to this control.</p>}
            </div>

            <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title="Enable autonomous replies for this campaign?"
                description="When the organization also has autonomous sending on and unpaused, the assistant may reply to inbound messages for this campaign on its own. Every send still passes suppression, sending-limit, warm-up, spacing, and kill-switch checks."
                confirmLabel="Enable for this campaign"
                cancelLabel="Cancel"
                variant="warning"
                loading={pending}
                onConfirm={() => { onSetEnabled(true); setConfirm(false) }}
            />
        </div>
    )
}
